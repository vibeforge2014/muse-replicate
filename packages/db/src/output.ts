import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { newId } from "@mas/core";
import type { Database } from "./schema.js";
import type { SnapshotStore } from "./checkpoint.js";

/**
 * 输出清单协议（spec §5.5）：
 *  1. turn 结束时枚举沙箱 outputs 目录，逐文件计算 sha256，按
 *     `outputs/{session}/{sha256}` 内容寻址上传（字节一致 = 幂等重试）；
 *  2. 生成 manifest，只有当前 execution fence 能 CAS 发布为
 *     `sessions.active_output_manifest`；
 *  3. 每个条目登记为 session 范围 File，身份 `(session_id, path, sha256)`
 *     唯一 —— 重复收集不产生重复 File（REC-08）；
 *  4. 上传失败的条目标记 incomplete，并写 `session.error{output_incomplete}`。
 */

export interface OutputManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface OutputManifest {
  session_id: string;
  turn_seq: number;
  generation: number;
  execution_id: string;
  entries: OutputManifestEntry[];
  incomplete: string[];
}

export interface CollectOutputsResult {
  manifest: OutputManifest;
  published: boolean;
  registeredFiles: number;
}

export async function collectOutputs(input: {
  db: Kysely<Database>;
  store: SnapshotStore;
  sessionId: string;
  executionId: string;
  generation: number;
  attemptId: string;
  outputsDir: string;
}): Promise<CollectOutputsResult> {
  const entries: OutputManifestEntry[] = [];
  const incomplete: string[] = [];

  const names = safeListDir(input.outputsDir);
  for (const name of names) {
    const p = join(input.outputsDir, name);
    try {
      const bytes = readFileSync(p);
      const st = statSync(p);
      if (!st.isFile()) continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // 内容寻址上传：key 即内容的承诺，重试/重复收集天然幂等
      await input.store.putIfAbsent(`outputs/${input.sessionId}/${sha256}`, bytes);
      entries.push({ path: name, sha256, size: bytes.length });
    } catch {
      incomplete.push(name);
    }
  }

  const turnSeqRow = await input.db
    .selectFrom("sessions")
    .select(["last_event_seq"])
    .where("id", "=", input.sessionId)
    .executeTakeFirst();
  const manifest: OutputManifest = {
    session_id: input.sessionId,
    turn_seq: Number(turnSeqRow?.last_event_seq ?? 0),
    generation: input.generation,
    execution_id: input.executionId,
    entries,
    incomplete,
  };

  // CAS 发布：fence 仍归本 attempt 持有才允许推进 canonical 指针
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
      .updateTable("sessions")
      .set({ active_output_manifest: manifest as unknown as Record<string, unknown> })
      .where("id", "=", input.sessionId)
      .execute();
    return true;
  });

  // 登记为 session 范围 File：(scope_id, filename, sha256) 唯一 → 去重
  let registeredFiles = 0;
  for (const e of entries) {
    const r = await sql<{ id: string }>`
      INSERT INTO files (id, workspace_id, scope_type, scope_id, filename, mime, size, sha256, object_key)
      VALUES (${newId("file")},
              (SELECT workspace_id FROM sessions WHERE id = ${input.sessionId}),
              'session', ${input.sessionId}, ${e.path}, 'application/octet-stream',
              ${e.size}, ${e.sha256}, ${`outputs/${input.sessionId}/${e.sha256}`})
      ON CONFLICT (scope_id, filename, sha256) WHERE scope_type = 'session' DO NOTHING
      RETURNING id`.execute(input.db);
    registeredFiles += r.rows.length;
  }

  return { manifest, published, registeredFiles };
}

function safeListDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
