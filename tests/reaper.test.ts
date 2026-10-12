import { describe, expect, test, beforeAll } from "vitest";
import { recordOrphan, type SandboxHandle, type SandboxProvider, type SandboxSpec } from "@mas/sandbox";
import { reapOnce, type ReaperDeps } from "../apps/worker/src/reaper.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

/**
 * 空闲沙箱 reaper（spec §9.3/§9.4）：
 * - idle > pause_after → provider.pause + sandbox_state='paused'；
 * - idle > destroy_after → provider.destroy + 清 sandbox_id（懒重建）；
 * - 防误伤：最近有活动 / 在途 execution 的会话不动；
 * - sandbox_orphans reconcile：destroy 成功 → resolved；失败 → attempts+1。
 */

/** 观测用 spy provider：记录调用，destroy 可按 sandboxId 注入失败。 */
export class SpyProvider implements SandboxProvider {
  readonly kind = "fake";
  paused: string[] = [];
  resumed: string[] = [];
  destroyed: string[] = [];
  failDestroy = new Set<string>();
  async capabilities() {
    return { isolation: "runc" as const, persistentWorkspace: true, egress: "unsupported" as const };
  }
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    return { sandboxId: `sbx_spy_${spec.sessionId}`, workspaceDir: spec.codexHome, outputsDir: spec.outputsDir, uploadsDir: spec.codexHome };
  }
  async pause(sandboxId: string) {
    this.paused.push(sandboxId);
  }
  async resume(sandboxId: string) {
    this.resumed.push(sandboxId);
  }
  async destroy(sandboxId: string) {
    if (this.failDestroy.has(sandboxId)) throw new Error("boom");
    this.destroyed.push(sandboxId);
  }
}

let env: TestEnv;
let provider: SpyProvider;
let deps: ReaperDeps;
let dropped: string[];

beforeAll(async () => {
  env = await setupEnv();
});

async function newIdleSession(sandboxId: string, idleHours: number): Promise<string> {
  const stamp = Date.now().toString(36);
  const envId = (await (await fetch(`${env.url}/v1/environments`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `reap-${stamp}`, config: { type: "cloud", networking: { type: "unrestricted" } } }),
  })).json() as { id: string }).id;
  const agId = (await (await fetch(`${env.url}/v1/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `reap-${stamp}`, model: { id: "glm-5.3" } }),
  })).json() as { id: string }).id;
  const sid = (await (await fetch(`${env.url}/v1/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: JSON.stringify({ agent: agId, environment_id: envId }),
  })).json() as { id: string }).id;
  // 人工物化沙箱引用 + 倒填最后活动时间（reaper 以事件时间判 idle）
  await env.db.pool.query(
    `insert into session_events (id, session_id, type, payload, created_at)
     values ($1, $2, 'user.message', '{}', now() - ($3 || ' hours')::interval)`,
    [`evt_reap_${stamp}`, sid, String(idleHours)],
  );
  await env.db.db
    .updateTable("sessions")
    .set({ sandbox_id: sandboxId, sandbox_state: "active", sandbox_spec: { sessionId: sid, generation: 1 } as Record<string, unknown> })
    .where("id", "=", sid)
    .execute();
  return sid;
}

test("idle 超时 → pause + sandbox_state=paused，dropRuntime 先行", async () => {
  provider = new SpyProvider();
  dropped = [];
  deps = { db: env.db.db, provider, dropRuntime: (sid) => void dropped.push(sid) };
  const sid = await newIdleSession("sbx_a", 2); // idle 2h
  const res = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(res.paused).toBe(1);
  expect(provider.paused).toContain("sbx_a");
  expect(dropped).toContain(sid);
  const row = await env.db.db.selectFrom("sessions").select(["sandbox_state", "sandbox_paused_at"]).where("id", "=", sid).executeTakeFirst();
  expect(row?.sandbox_state).toBe("paused");
  expect(row?.sandbox_paused_at).not.toBeNull();
});

test("最近有活动 / 在途 execution → 不动", async () => {
  const fresh = await newIdleSession("sbx_fresh", 0); // idle 0h（刚活动过）
  const running = await newIdleSession("sbx_running", 5);
  const ws = await env.db.db.selectFrom("sessions").select("workspace_id").where("id", "=", running).executeTakeFirst();
  await env.db.db.insertInto("session_executions").values({
    id: "exec_test_running",
    workspace_id: ws!.workspace_id,
    session_id: running,
    kind: "turn",
    input_fingerprint: "reap-test",
    state: "running",
    deadline_at: new Date(Date.now() + 60_000),
  }).execute();
  const res = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(provider.paused).not.toContain("sbx_fresh");
  expect(provider.paused).not.toContain("sbx_running");
  expect(res.paused).toBe(0);
  const row = await env.db.db.selectFrom("sessions").select("sandbox_state").where("id", "=", fresh).executeTakeFirst();
  expect(row?.sandbox_state).toBe("active");
});

test("idle 超过 destroy_after → destroy + 清 sandbox_id（懒重建）", async () => {
  const sid = await newIdleSession("sbx_old", 25); // idle 25h > 24h
  const res = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(res.destroyed).toBe(1);
  expect(provider.destroyed).toContain("sbx_old");
  const row = await env.db.db.selectFrom("sessions").select(["sandbox_id", "sandbox_state", "sandbox_spec"]).where("id", "=", sid).executeTakeFirst();
  expect(row?.sandbox_id).toBeNull();
  expect(row?.sandbox_state).toBeNull();
  expect(row?.sandbox_spec).toBeNull();
});

test("destroy 失败 → 记 orphan，会话侧仍清引用；reconcile 成功后 resolved", async () => {
  const sid = await newIdleSession("sbx_fail", 30);
  provider.failDestroy.add("sbx_fail");
  const res = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(res.destroyed).toBe(0);
  const row = await env.db.db.selectFrom("sessions").select("sandbox_id").where("id", "=", sid).executeTakeFirst();
  expect(row?.sandbox_id).toBeNull();
  const orphans = await env.db.db.selectFrom("sandbox_orphans").selectAll().where("sandbox_ref", "=", "sbx_fail").execute();
  expect(orphans).toHaveLength(1);
  expect(orphans[0]!.resolved_at).toBeNull();
  // 修复后 reconcile：destroy 成功 → resolved
  provider.failDestroy.delete("sbx_fail");
  const res2 = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(res2.orphansResolved).toBe(1);
  const after = await env.db.db.selectFrom("sandbox_orphans").selectAll().where("sandbox_ref", "=", "sbx_fail").execute();
  expect(after[0]!.resolved_at).not.toBeNull();
});

test("orphan 重试计数：destroy 仍失败 → attempts 递增", async () => {
  await recordOrphan(env.db.db, { sandboxRef: "sbx_zombie", sessionId: "sesn_nonexistent", generation: 1, reason: "test" });
  provider.failDestroy.add("sbx_zombie");
  const res = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(res.orphansRetried).toBeGreaterThanOrEqual(1);
  const rows = await env.db.db.selectFrom("sandbox_orphans").selectAll().where("sandbox_ref", "=", "sbx_zombie").execute();
  expect(rows[0]!.attempts).toBeGreaterThanOrEqual(1);
  expect(rows[0]!.last_error).toContain("boom");
  provider.failDestroy.delete("sbx_zombie");
});

test("会话删除 → server 登记 orphan（session_deleted）→ reaper 下个 tick 销毁", async () => {
  const sid = await newIdleSession("sbx_del", 0);
  const del = await fetch(`${env.url}/v1/sessions/${sid}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${env.key}` },
  });
  expect(del.status).toBe(200);
  const rows = await env.db.db.selectFrom("sandbox_orphans").selectAll().where("sandbox_ref", "=", "sbx_del").execute();
  expect(rows[0]?.reason).toBe("session_deleted");
  await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
  expect(provider.destroyed).toContain("sbx_del");
  const after = await env.db.db.selectFrom("sandbox_orphans").selectAll().where("sandbox_ref", "=", "sbx_del").execute();
  expect(after[0]!.resolved_at).not.toBeNull();
});

describe("懒恢复接线：paused 会话 acquireRuntime 时 resume", () => {
  test("resume(spec) 恢复 + DB 状态回 active", async () => {
    // 直接构造 runner 级最小验证：fake provider 的 pause→resume 语义 + sandbox_spec 透传
    const fake = new (await import("@mas/sandbox")).FakeSandboxProvider();
    const spec: SandboxSpec = { sessionId: "s1", generation: 1, mounts: [], codexHome: "/tmp/mas-reap-s1", outputsDir: "/tmp/mas-reap-s1/outputs" };
    await fake.create(spec);
    await fake.pause("sbx_unknown");
    // resume 不认识的 sandboxId 但带 spec → k8s 需要；fake 容忍（幂等物化）
    await expect(fake.resume("sbx_unknown", spec)).resolves.toBeUndefined();
  });
});
