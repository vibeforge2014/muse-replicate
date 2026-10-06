import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/**
 * Workspace checkpoint 提交协议（spec §9.4）：
 *  1. 静默：每轮结束、execution settle 之后由 worker 调用；
 *  2. 写不可变候选（checkpoint_id 永不覆盖已有对象）；
 *  3. 生成 manifest 并重新读取校验 sha256；
 *  4. CAS 发布：只有当前 execution fence 仍有效才能把 manifest 写入
 *     sessions.active_workspace_checkpoint；
 *  5. GC：保留最近 N 个（active/superseded），其余删除。
 *
 * 归档格式：`json.gz/v1`（目录文件集 {name, base64} 的 gzip JSON）。
 * 对象存储用 SnapshotStore 抽象：MVP 为本地文件系统实现，接 MinIO 时换 S3 实现。
 */

export interface SnapshotStore {
  /** 写入新对象；key 已存在时抛错（不可变候选，永不覆盖）。 */
  put(key: string, bytes: Buffer): Promise<void>;
  /** 内容寻址写入：已存在且字节一致视为幂等成功，字节不一致抛错。 */
  putIfAbsent(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class FsSnapshotStore implements SnapshotStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }
  private path(key: string): string {
    if (key.includes("..")) throw new Error(`illegal snapshot key ${key}`);
    return join(this.root, key);
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    mkdirSync(join(p, ".."), { recursive: true });
    if (existsSync(p)) throw new Error(`snapshot object already exists: ${key}`);
    writeFileSync(p, bytes);
  }
  async putIfAbsent(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    mkdirSync(join(p, ".."), { recursive: true });
    if (!existsSync(p)) {
      writeFileSync(p, bytes);
      return;
    }
    // 已存在：字节一致（内容寻址 key）→ 幂等成功；不一致 → 损坏，拒绝
    const existing = readFileSync(p);
    if (!existing.equals(bytes)) throw new Error(`snapshot object ${key} exists with different bytes`);
  }
  async get(key: string): Promise<Buffer> {
    return readFileSync(this.path(key));
  }
  async delete(key: string): Promise<void> {
    const p = this.path(key);
    if (existsSync(p)) rmSync(p);
  }
}

export interface CheckpointManifest {
  checkpoint_id: string;
  session_id: string;
  generation: number;
  execution_id: string;
  completed_execution_watermark: string;
  archive_sha256: string;
  size: number;
  format: "json.gz/v1";
  codex_version_digest: string;
  thread_id: string;
  created_at: string;
}

export interface CommitCheckpointInput {
  db: Kysely<Database>;
  store: SnapshotStore;
  sessionId: string;
  executionId: string;
  generation: number;
  attemptId: string;
  /** 已完成的 execution id（水位线，§14.2.1）。 */
  watermarkExecutionId: string;
  /** 快照源目录（fake CODEX_HOME / 真实 /session）。 */
  sourceDir: string;
  codexVersionDigest: string;
  threadId: string;
  keep?: number;
}

export interface CommitCheckpointResult {
  checkpointId: string;
  published: boolean;
  manifest: CheckpointManifest;
}

/** 把目录打包为归档字节（json.gz/v1：{files:[{name,data(base64)}]}，递归子目录）。 */
function packDir(sourceDir: string): Buffer {
  const files: { name: string; data: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else files.push({ name: `${prefix}${name}`, data: readFileSync(p).toString("base64") });
    }
  };
  walk(sourceDir, "");
  return gzipSync(JSON.stringify({ format: "json.gz/v1", files }));
}

function unpackDir(bytes: Buffer, targetDir: string): void {
  const parsed = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
    format: string;
    files: { name: string; data: string }[];
  };
  if (parsed.format !== "json.gz/v1") throw new Error(`unknown archive format ${parsed.format}`);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const f of parsed.files) {
    const target = join(targetDir, f.name);
    // 归档条目只允许相对路径内的嵌套文件
    if (!resolve(target).startsWith(resolve(targetDir))) throw new Error(`illegal archive entry ${f.name}`);
    if (f.name.endsWith("/") || f.name.includes("..")) throw new Error(`illegal archive entry ${f.name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(f.data, "base64"));
  }
}

export async function commitCheckpoint(input: CommitCheckpointInput): Promise<CommitCheckpointResult> {
  const checkpointId = `ckp_${ulid()}`;
  const archive = packDir(input.sourceDir);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const manifest: CheckpointManifest = {
    checkpoint_id: checkpointId,
    session_id: input.sessionId,
    generation: input.generation,
    execution_id: input.executionId,
    completed_execution_watermark: input.watermarkExecutionId,
    archive_sha256: sha256,
    size: archive.length,
    format: "json.gz/v1",
    codex_version_digest: input.codexVersionDigest,
    thread_id: input.threadId,
    created_at: new Date().toISOString(),
  };
  const key = `snapshots/${input.sessionId}/${checkpointId}.json.gz`;
  // 2. 不可变候选
  await input.store.put(key, archive);
  // 3. 重新读取校验 sha256（§9.4 第 3 步）
  const reread = await input.store.get(key);
  if (createHash("sha256").update(reread).digest("hex") !== sha256) {
    await input.store.delete(key).catch(() => undefined);
    throw new Error(`checkpoint ${checkpointId} failed post-write sha256 verification`);
  }
  await input.db
    .insertInto("workspace_checkpoints")
    .values({
      checkpoint_id: checkpointId,
      session_id: input.sessionId,
      generation: input.generation,
      execution_id: input.executionId,
      manifest: manifest as unknown as Record<string, unknown>,
      state: "candidate",
    })
    .execute();

  // 4. CAS 发布：fence 有效才更新 active 指针（§9.4 第 4 步）
  const published = await input.db.transaction().execute(async (tx) => {
    const fence = await tx
      .selectFrom("session_executions")
      .select(["id"])
      .where("id", "=", input.executionId)
      .where("generation", "=", input.generation)
      .where("attempt_id", "=", input.attemptId)
      .executeTakeFirst();
    if (!fence) return false;
    await tx
      .updateTable("workspace_checkpoints")
      .set({ state: "superseded" })
      .where("session_id", "=", input.sessionId)
      .where("state", "=", "active")
      .execute();
    await tx
      .updateTable("workspace_checkpoints")
      .set({ state: "active" })
      .where("checkpoint_id", "=", checkpointId)
      .execute();
    await tx
      .updateTable("sessions")
      .set({ active_workspace_checkpoint: manifest as unknown as Record<string, unknown> })
      .where("id", "=", input.sessionId)
      .execute();
    return true;
  });

  if (!published) {
    // fence 已失效：候选作废（state 保持 candidate，由 GC 回收）
    await input.db
      .updateTable("workspace_checkpoints")
      .set({ state: "corrupt" })
      .where("checkpoint_id", "=", checkpointId)
      .execute();
  }

  // 5. GC：保留最近 N=3 个有效候选（§9.4 第 5 步）
  await gcCheckpoints(input.db, input.store, input.sessionId, input.keep ?? 3);

  return { checkpointId, published, manifest };
}

async function gcCheckpoints(
  db: Kysely<Database>,
  store: SnapshotStore,
  sessionId: string,
  keep: number,
): Promise<void> {
  const rows = await db
    .selectFrom("workspace_checkpoints")
    .select(["checkpoint_id", "state"])
    .where("session_id", "=", sessionId)
    .where("state", "in", ["active", "superseded", "candidate"])
    .orderBy("created_at desc")
    .execute();
  const doomed = rows.slice(keep);
  for (const row of doomed) {
    await store.delete(`snapshots/${sessionId}/${row.checkpoint_id}.json.gz`).catch(() => undefined);
    await db.deleteFrom("workspace_checkpoints").where("checkpoint_id", "=", row.checkpoint_id).execute();
  }
}

/** 校验并解包到目标目录；sha256 不符抛错（§9.4 恢复失败语义）。 */
export async function restoreCheckpoint(
  store: SnapshotStore,
  manifest: CheckpointManifest,
  targetDir: string,
): Promise<void> {
  const bytes = await store.get(`snapshots/${manifest.session_id}/${manifest.checkpoint_id}.json.gz`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== manifest.archive_sha256) {
    throw new Error(`checkpoint ${manifest.checkpoint_id} sha256 mismatch`);
  }
  if (bytes.length !== manifest.size) {
    throw new Error(`checkpoint ${manifest.checkpoint_id} size mismatch`);
  }
  unpackDir(bytes, targetDir);
}

export async function loadActiveCheckpoint(
  db: Kysely<Database>,
  sessionId: string,
): Promise<CheckpointManifest | null> {
  const row = await db
    .selectFrom("workspace_checkpoints")
    .select(["manifest"])
    .where("session_id", "=", sessionId)
    .where("state", "=", "active")
    .orderBy("created_at desc")
    .limit(1)
    .executeTakeFirst();
  return (row?.manifest as unknown as CheckpointManifest) ?? null;
}

/** 回退候选：按时间倒序的 superseded（REC-05）。 */
export async function listFallbackCheckpoints(
  db: Kysely<Database>,
  sessionId: string,
): Promise<CheckpointManifest[]> {
  const rows = await db
    .selectFrom("workspace_checkpoints")
    .select(["manifest"])
    .where("session_id", "=", sessionId)
    .where("state", "=", "superseded")
    .orderBy("created_at desc")
    .execute();
  return rows.map((r) => r.manifest as unknown as CheckpointManifest);
}

/** 标记 active checkpoint 为 corrupt（恢复校验失败时）。 */
export async function markCheckpointCorrupt(
  db: Kysely<Database>,
  sessionId: string,
  checkpointId: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("workspace_checkpoints")
      .set({ state: "corrupt" })
      .where("checkpoint_id", "=", checkpointId)
      .execute();
    await tx
      .updateTable("sessions")
      .set({ active_workspace_checkpoint: null })
      .where("id", "=", sessionId)
      .execute();
  });
}

/** 内部事件（runtime.recovered 等，spec §12.2）。 */
export async function appendInternalEvent(
  db: Kysely<Database>,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db
    .insertInto("session_internal_events")
    .values({ session_id: sessionId, type, payload })
    .execute();
}

/** fake codex 的会话目录（CODEX_HOME）。 */
export function fakeCodexHome(sessionId: string): string {
  return join(tmpdir(), "mas-fake-codex", sessionId);
}

export const FAKE_CODEX_DIGEST = "fake-codex@0.1.0";

export const newWatermarkAttemptId = (): string => `w_${randomUUID().slice(0, 8)}`;
