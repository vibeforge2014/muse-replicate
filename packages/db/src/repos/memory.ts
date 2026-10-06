import { createHash } from "node:crypto";
import { type Kysely, type Selectable } from "kysely";
import { errConflict, errNotFound, newId, slugifyMemoryStore } from "@mas/core";
import type { Database } from "../schema.js";
import type { MemoryRow, MemoryStoreRow, MemoryVersionRow } from "../schema.js";

type StoreRow = Selectable<MemoryStoreRow>;
type MemRow = Selectable<MemoryRow>;
type VersionRow = Selectable<MemoryVersionRow>;
export type { StoreRow as MemoryStoreView, MemRow as MemoryView, VersionRow as MemoryVersionView };

/**
 * Memory Store 仓库层（plan M6 W11 / test-case-plan 5.12）：
 * - store：name 唯一化 slug（挂载点 /mnt/memory/<slug>）；
 * - memory：按 (store, path) 唯一，每次写入追加 memory_versions（head_version+1）；
 * - precondition（MEM-04）：content_sha256 与当前 head 不一致 → 409；
 * - redact（MEM-07）：只允许历史版本；redact 后 path/content/sha 置 null。
 */

export class PreconditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionFailedError";
  }
}

export async function getMemoryStore(
  db: Kysely<Database>,
  workspaceId: string,
  storeId: string,
): Promise<StoreRow> {
  const row = await db
    .selectFrom("memory_stores")
    .selectAll()
    .where("id", "=", storeId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw errNotFound(`memory store ${storeId} not found`);
  return row;
}

export async function createStore(
  db: Kysely<Database>,
  workspaceId: string,
  input: { name: string; description: string | null },
): Promise<StoreRow> {
  const base = slugifyMemoryStore(input.name);
  for (let i = 0; i < 6; i++) {
    const suffix = i === 0 ? "" : `-${Math.random().toString(36).slice(2, 6)}`;
    const slug = `${base}${suffix}`.slice(0, 64);
    const id = newId("mstr");
    try {
      const inserted = await db
        .insertInto("memory_stores")
        .values({ id, workspace_id: workspaceId, name: input.name, slug, description: input.description })
        .returningAll()
        .executeTakeFirst();
      return inserted!;
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (!msg.includes("memory_stores_workspace_id_slug_key")) throw e;
    }
  }
  throw errConflict("could not derive a unique slug for memory store");
}

export interface HeadVersionView {
  memory: MemRow;
  head: VersionRow | null;
}

export async function getMemoryWithHead(
  db: Kysely<Database>,
  workspaceId: string,
  storeId: string,
  memoryId: string,
): Promise<HeadVersionView> {
  const memory = await db
    .selectFrom("memories")
    .selectAll()
    .where("id", "=", memoryId)
    .where("store_id", "=", storeId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!memory) throw errNotFound(`memory ${memoryId} not found`);
  const head = await db
    .selectFrom("memory_versions")
    .selectAll()
    .where("memory_id", "=", memoryId)
    .where("version_no", "=", memory.head_version)
    .executeTakeFirst();
  return { memory, head: head ?? null };
}

export interface UpsertMemoryResult {
  memory: MemRow;
  version: VersionRow;
  created: boolean;
}

/**
 * 写入（创建或更新）一条 memory；precondition 与当前 head 的 content_sha256
 * 不一致时抛 PreconditionFailedError（MEM-04）。
 */
export async function upsertMemory(
  db: Kysely<Database>,
  args: {
    workspaceId: string;
    storeId: string;
    path: string;
    content: string;
    preconditionSha?: string;
  },
): Promise<UpsertMemoryResult> {
  const bytes = Buffer.from(args.content, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");

  return await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("memories")
      .forUpdate()
      .selectAll()
      .where("store_id", "=", args.storeId)
      .where("path", "=", args.path)
      .executeTakeFirst();

    if (!existing) {
      if (args.preconditionSha !== undefined) {
        throw new PreconditionFailedError(
          `precondition failed: memory ${args.path} does not exist (head sha unavailable)`,
        );
      }
      const memoryId = newId("mem");
      const memory = await tx
        .insertInto("memories")
        .values({ id: memoryId, store_id: args.storeId, workspace_id: args.workspaceId, path: args.path, head_version: 1 })
        .returningAll()
        .executeTakeFirst();
      const version = await tx
        .insertInto("memory_versions")
        .values({
          id: newId("memv"),
          memory_id: memoryId,
          workspace_id: args.workspaceId,
          version_no: 1,
          path: args.path,
          content: args.content,
          content_sha256: sha,
          size_bytes: bytes.length,
        })
        .returningAll()
        .executeTakeFirst();
      return { memory: memory!, version: version!, created: true };
    }

    const head = await tx
      .selectFrom("memory_versions")
      .selectAll()
      .where("memory_id", "=", existing.id)
      .where("version_no", "=", existing.head_version)
      .executeTakeFirst();
    const headSha = head?.content_sha256 ?? null;
    if (args.preconditionSha !== undefined && args.preconditionSha !== headSha) {
      throw new PreconditionFailedError(
        `precondition failed: head content_sha256 is ${headSha ?? "null"}, expected ${args.preconditionSha}`,
      );
    }
    if (headSha === sha && args.preconditionSha === undefined) {
      // 内容与 head 完全一致：幂等返回当前版本（不产生空版本）
      return { memory: existing, version: head!, created: false };
    }
    const nextNo = existing.head_version + 1;
    const version = await tx
      .insertInto("memory_versions")
      .values({
        id: newId("memv"),
        memory_id: existing.id,
        workspace_id: args.workspaceId,
        version_no: nextNo,
        path: args.path,
        content: args.content,
        content_sha256: sha,
        size_bytes: bytes.length,
      })
      .returningAll()
      .executeTakeFirst();
    const memory = await tx
      .updateTable("memories")
      .set({ head_version: nextNo, updated_at: new Date() })
      .where("id", "=", existing.id)
      .where("head_version", "=", existing.head_version)
      .returningAll()
      .executeTakeFirst();
    // head_version 条件更新失败 = 并发写入者已抢先；让调用方感知为 precondition 冲突
    if (!memory) throw new PreconditionFailedError("concurrent write to memory; retry");
    return { memory: memory!, version: version!, created: false };
  });
}

export async function listMemoriesWithHead(
  db: Kysely<Database>,
  storeId: string,
  opts: { pathPrefix?: string },
): Promise<{ memory: MemRow; head: VersionRow | null }[]> {
  const rows = await db
    .selectFrom("memories")
    .selectAll()
    .where("store_id", "=", storeId)
    .$if(opts.pathPrefix !== undefined, (q) =>
      q.where((eb) =>
        eb.or([eb("path", "=", opts.pathPrefix!), eb("path", "like", `${opts.pathPrefix}/%`)]),
      ),
    )
    .orderBy("path", "asc")
    .execute();
  const out: HeadVersionView[] = [];
  for (const m of rows) {
    const head = await db
      .selectFrom("memory_versions")
      .selectAll()
      .where("memory_id", "=", m.id)
      .where("version_no", "=", m.head_version)
      .executeTakeFirst();
    out.push({ memory: m, head: head ?? null });
  }
  return out;
}

export async function deleteMemory(
  db: Kysely<Database>,
  workspaceId: string,
  storeId: string,
  memoryId: string,
  expectedSha?: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const memory = await tx
      .selectFrom("memories")
      .forUpdate()
      .selectAll()
      .where("id", "=", memoryId)
      .where("store_id", "=", storeId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!memory) throw errNotFound(`memory ${memoryId} not found`);
    if (expectedSha !== undefined) {
      const head = await tx
        .selectFrom("memory_versions")
        .selectAll()
        .where("memory_id", "=", memoryId)
        .where("version_no", "=", memory.head_version)
        .executeTakeFirst();
      if ((head?.content_sha256 ?? null) !== expectedSha) {
        throw new PreconditionFailedError(
          `expected_content_sha256 mismatch: head is ${head?.content_sha256 ?? "null"}`,
        );
      }
    }
    await tx.deleteFrom("memory_versions").where("memory_id", "=", memoryId).execute();
    await tx.deleteFrom("memories").where("id", "=", memoryId).execute();
  });
}

export async function listVersions(
  db: Kysely<Database>,
  memoryId: string,
): Promise<VersionRow[]> {
  return db
    .selectFrom("memory_versions")
    .selectAll()
    .where("memory_id", "=", memoryId)
    .orderBy("version_no", "desc")
    .execute();
}

/** MEM-07：head 版本不可 redact（409）；历史版本 redact 后 path/content/sha 置 null。 */
export async function redactVersion(
  db: Kysely<Database>,
  workspaceId: string,
  storeId: string,
  memoryId: string,
  versionId: string,
): Promise<VersionRow> {
  return await db.transaction().execute(async (tx) => {
    const memory = await tx
      .selectFrom("memories")
      .forUpdate()
      .selectAll()
      .where("id", "=", memoryId)
      .where("store_id", "=", storeId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!memory) throw errNotFound(`memory ${memoryId} not found`);
    const version = await tx
      .selectFrom("memory_versions")
      .selectAll()
      .where("id", "=", versionId)
      .where("memory_id", "=", memoryId)
      .executeTakeFirst();
    if (!version) throw errNotFound(`memory version ${versionId} not found`);
    if (version.redacted_at) return version;
    if (version.version_no === memory.head_version) {
      throw errConflict("cannot redact the current head version");
    }
    const updated = await tx
      .updateTable("memory_versions")
      .set({ path: null, content: null, content_sha256: null, redacted_at: new Date() })
      .where("id", "=", versionId)
      .returningAll()
      .executeTakeFirst();
    return updated!;
  });
}
