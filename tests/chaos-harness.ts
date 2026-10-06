import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@mas/core";
import {
  admitEvents,
  appendEvent,
  claimNextExecution,
  collectOutputs,
  commitCheckpoint,
  FsSnapshotStore,
  markDelivered,
  renewExecution,
  restoreCheckpoint,
  settleExecution,
  type SnapshotStore,
} from "@mas/db";
import type { Kysely } from "kysely";
import type { Database } from "@mas/db";

/**
 * 确定性混沌车道 harness（spec §5.20 / plan M3 3.9）：
 * 多 owner 并发驱动**真实实现**（claim/renew/deliver/append/checkpoint/output/settle/
 * 过期回收），每次动作后校验六个不变量；租约过期用"改写 lease_expires_at"模拟
 * （SQL 侧时钟无法虚拟化，等价的种子驱动失效）。
 *
 * 不变量：
 *  1. 任一时刻至多一个 generation 能成功提交 canonical 写入；
 *  2. 旧 generation 不能追加事件/推进 checkpoint/发布 output；
 *  3. active checkpoint 一定指向完整、已校验的候选；
 *  4. seq 严格递增且无空洞；
 *  5. 重试 acquire/append/collect/settle 幂等；
 *  6. 释放计算资源不删除 canonical 的 checkpoint 与 output。
 */

/** mulberry32：可复现 PRNG。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Owner {
  name: string;
  /** 持有的 fence（claim 后填）。 */
  execId: string | null;
  generation: number;
  attemptId: string;
}

export interface ChaosResult {
  seed: number;
  steps: number;
  canonicalWrites: number;
  rejectedStale: number;
  checkpointCommits: number;
  outputFiles: number;
}

export class InvariantError extends Error {}

export async function runChaosSeed(
  db: Kysely<Database>,
  store: SnapshotStore,
  seed: number,
  opts: { steps?: number; workspaceId: string; agentSnapshot: Record<string, unknown>; environmentId: string } ,
): Promise<ChaosResult> {
  const rand = rng(seed);
  const steps = opts.steps ?? 40;
  const sessionId = `sesn_chaos_${seed}_${newId("x").slice(-6)}`;
  const home = join(tmpdir(), `mas-chaos-${sessionId}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "outputs"), { recursive: true });
  writeFileSync(join(home, "rollout.json"), "[]");

  // 建会话（直接落库，走真实 admitEvents）
  await db.insertInto("sessions").values({
    id: sessionId,
    workspace_id: opts.workspaceId,
    agent_snapshot: opts.agentSnapshot,
    environment_id: opts.environmentId,
    environment_snapshot: { id: opts.environmentId, config: { type: "cloud" } },
  }).execute();
  await admitEvents(db, {
    sessionId,
    workspaceId: opts.workspaceId,
    events: [{ id: newId("sevt"), type: "user.message", payload: { type: "user.message", content: [{ type: "text", text: `seed-${seed}` }] } }],
    executionKind: "user_message",
  });

  const owners: Owner[] = [0, 1, 2].map((i) => ({ name: `w${i}`, execId: null, generation: 0, attemptId: "" }));
  let canonicalWrites = 0;
  let rejectedStale = 0;
  let checkpointCommits = 0;
  let msgCounter = 0;
  let outputCounter = 0;

  const currentRow = async (execId: string) =>
    (await db.selectFrom("session_executions").select(["generation", "attempt_id", "state", "lease_expires_at"]).where("id", "=", execId).executeTakeFirst()) ?? null;

  const assertSeqInvariant = async () => {
    const rows = await db
      .selectFrom("session_events")
      .select(["seq"])
      .where("session_id", "=", sessionId)
      .where("seq", "is not", null)
      .orderBy("seq", "asc")
      .execute();
    rows.forEach((r, i) => {
      if (Number(r.seq) !== i + 1) {
        throw new InvariantError(`seed ${seed}: seq hole/dup at ${i} → ${r.seq}`);
      }
    });
  };

  const assertCheckpointInvariant = async () => {
    const s = await db.selectFrom("sessions").select(["active_workspace_checkpoint"]).where("id", "=", sessionId).executeTakeFirst();
    const manifest = s?.active_workspace_checkpoint as { checkpoint_id?: string; archive_sha256?: string; size?: number } | null;
    if (!manifest?.checkpoint_id) return;
    const bytes = await store.get(`snapshots/${sessionId}/${manifest.checkpoint_id}.json.gz`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== manifest.archive_sha256 || bytes.length !== manifest.size) {
      throw new InvariantError(`seed ${seed}: active checkpoint ${manifest.checkpoint_id} failed verification`);
    }
    const row = await db
      .selectFrom("workspace_checkpoints")
      .select(["state"])
      .where("checkpoint_id", "=", manifest.checkpoint_id)
      .executeTakeFirst();
    if (row?.state !== "active") {
      throw new InvariantError(`seed ${seed}: active pointer references non-active row (${row?.state})`);
    }
  };

  const assertOutputInvariant = async () => {
    const rows = await db
      .selectFrom("files")
      .select(["id", "filename", "sha256"])
      .where("scope_type", "=", "session")
      .where("scope_id", "=", sessionId)
      .execute();
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.filename}|${r.sha256}`;
      if (seen.has(k)) throw new InvariantError(`seed ${seed}: duplicate output file ${k}`);
      seen.add(k);
    }
  };

  /** 用（可能已过期的）fence 尝试 canonical 写；校验不变量 1/2。 */
  const tryAppend = async (o: Owner, type: string, sourceId: string) => {
    if (!o.execId) return;
    const row = await currentRow(o.execId);
    const stale = !row || Number(row.generation) !== o.generation || row.attempt_id !== o.attemptId || row.state === "failed";
    try {
      const ev = await appendEvent(db, {
        sessionId,
        executionId: o.execId,
        generation: o.generation,
        attemptId: o.attemptId,
        type,
        payload: type === "agent.message" ? { content: [{ type: "text", text: `m${msgCounter++}` }] } : type === "session.status_idle" ? { stop_reason: { type: "end_turn" } } : {},
        sourceEventId: sourceId,
      });
      if (stale) throw new InvariantError(`seed ${seed}: stale fence (gen ${o.generation} vs ${row ? row.generation : "gone"}) succeeded canonical write`);
      if (ev) canonicalWrites += 1;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        if (!stale) throw new InvariantError(`seed ${seed}: current fence rejected (${o.generation}/${o.attemptId} vs ${JSON.stringify(row)})`);
        rejectedStale += 1;
      } else {
        throw e;
      }
    }
    await assertSeqInvariant();
  };

  const step = async (i: number) => {
    const o = owners[Math.floor(rand() * owners.length)];
    const dice = rand();
    if (dice < 0.22 || !o.execId) {
      // claim（真实 SKIP LOCKED；被占即 null）
      const attemptId = `att_${seed}_${i}`;
      const exec = await claimNextExecution(db, sessionId, o.name, attemptId, 30);
      if (exec) {
        o.execId = exec.id;
        o.generation = Number(exec.generation);
        o.attemptId = attemptId;
        // 其他 owner 的 fence 视图自然过期（他们还拿着旧 generation）
      }
      return;
    }
    if (dice < 0.28) {
      // renew
      const ok = await renewExecution(db, o.execId, o.generation, o.attemptId, 30);
      if (!ok) o.execId = null;
      return;
    }
    if (dice < 0.34) {
      await markDelivered(db, o.execId, o.generation, o.attemptId);
      return;
    }
    if (dice < 0.62) {
      await tryAppend(o, rand() < 0.3 ? "session.status_idle" : "agent.message", `src_${seed}_${i}_${o.name}`);
      return;
    }
    if (dice < 0.74) {
      // checkpoint（真实提交协议；fence 过期时 CAS 必失败 → 候选作废）
      writeFileSync(join(home, "rollout.json"), JSON.stringify({ seed, step: i }));
      const r = await commitCheckpoint({
        db, store, sessionId,
        executionId: o.execId,
        generation: o.generation,
        attemptId: o.attemptId,
        watermarkExecutionId: o.execId,
        sourceDir: home,
        codexVersionDigest: "fake-codex@0.1.0",
        threadId: "thrx_chaos",
      });
      if (r.published) checkpointCommits += 1;
      await assertCheckpointInvariant();
      return;
    }
    if (dice < 0.84) {
      // output 收集（真实 §5.5；fence 过期时 CAS 不发布）
      if (rand() < 0.5) writeFileSync(join(home, "outputs", `o${outputCounter++}.txt`), `payload-${seed}-${i}`);
      const before = await db.selectFrom("files").select(["id"]).where("scope_type", "=", "session").where("scope_id", "=", sessionId).execute();
      await collectOutputs({
        db, store, sessionId,
        executionId: o.execId,
        generation: o.generation,
        attemptId: o.attemptId,
        outputsDir: join(home, "outputs"),
      });
      // 幂等重试（不变量 5）：同目录再收集一次，文件数不得变化
      await collectOutputs({
        db, store, sessionId,
        executionId: o.execId,
        generation: o.generation,
        attemptId: o.attemptId,
        outputsDir: join(home, "outputs"),
      });
      const after = await db.selectFrom("files").select(["id"]).where("scope_type", "=", "session").where("scope_id", "=", sessionId).execute();
      if (after.length < before.length) throw new InvariantError(`seed ${seed}: output files shrank`);
      await assertOutputInvariant();
      return;
    }
    if (dice < 0.92) {
      // 租约过期（种子驱动：等价的虚拟时钟推进）
      await db.updateTable("session_executions")
        .set({ lease_expires_at: new Date(Date.now() - 1000) })
        .where("id", "=", o.execId)
        .execute();
      return;
    }
    // settle（幂等重试，不变量 5）
    await settleExecution(db, o.execId, o.generation, o.attemptId, { state: "completed" });
    await settleExecution(db, o.execId, o.generation, o.attemptId, { state: "completed" });
    o.execId = null;
    // 不变量 6：settle/换主不删 canonical checkpoint 与 output
    await assertCheckpointInvariant();
    await assertOutputInvariant();
  };

  for (let i = 0; i < steps; i++) {
    await step(i);
    if (i % 5 === 0) {
      await assertSeqInvariant();
      await assertCheckpointInvariant();
    }
  }

  // 收尾不变量 6：换主后旧 checkpoint 仍可校验恢复
  const s = await db.selectFrom("sessions").select(["active_workspace_checkpoint"]).where("id", "=", sessionId).executeTakeFirst();
  const manifest = s?.active_workspace_checkpoint as Parameters<typeof restoreCheckpoint>[1] | null;
  if (manifest) {
    await restoreCheckpoint(store, manifest, join(home, "restored"));
  }
  rmSync(home, { recursive: true, force: true });
  const files = await db.selectFrom("files").select(["id"]).where("scope_type", "=", "session").where("scope_id", "=", sessionId).execute();
  return { seed, steps, canonicalWrites, rejectedStale, checkpointCommits, outputFiles: files.length };
}

/** 供 vitest / 脚本共用的固定种子集。 */
export function fixedSeeds(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 1_000_000 + i * 7919);
}

export function chaosStore(tag: string): FsSnapshotStore {
  return new FsSnapshotStore(join(tmpdir(), `mas-chaos-store-${tag}`));
}
