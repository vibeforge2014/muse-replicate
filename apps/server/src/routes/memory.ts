import type { FastifyInstance } from "fastify";
import { errConflict, errInvalid, memoryStoreCreateSchema, memoryUpsertSchema } from "@mas/core";
import type { Kysely } from "kysely";
import type { Database, MemoryStoreView, MemoryVersionView } from "@mas/db";
import {
  createStore,
  deleteMemory,
  getMemoryStore,
  getMemoryWithHead,
  listMemoriesWithHead,
  listVersions,
  redactVersion,
  upsertMemory,
  PreconditionFailedError,
} from "@mas/db";
import type { RouteCtx } from "./agents.js";
import { withIdempotency } from "../plugins/idempotent-route.js";

/**
 * Memory Stores（plan M6 W11 / test-case-plan 5.12 MEM-01~07）：
 * 版本化键值树——每次写入追加 memory_versions；precondition 按 head content_sha256；
 * redact 只允许历史版本；list 支持 path_prefix/depth/view=full（含 memory_prefix 元素）。
 */

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function storeJson(s: MemoryStoreView) {
  return {
    id: s.id,
    type: "memory_store",
    name: s.name,
    slug: s.slug,
    description: s.description,
    archived_at: s.archived_at ? iso(s.archived_at) : null,
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
  };
}

function versionJson(v: MemoryVersionView, opts: { includeContent?: boolean } = {}) {
  const redacted = v.redacted_at !== null;
  const out: Record<string, unknown> = {
    id: v.id,
    version: v.version_no,
    path: redacted ? null : v.path,
    content_sha256: redacted ? null : v.content_sha256,
    size_bytes: Number(v.size_bytes),
    created_at: iso(v.created_at),
    redacted_at: redacted ? iso(v.redacted_at) : null,
  };
  if (opts.includeContent) out.content = redacted ? null : v.content;
  return out;
}

function memoryJson(m: { id: string; path: string; head_version: number; updated_at: Date }, head: MemoryVersionView | null, withContent = false) {
  const redacted = head ? head.redacted_at !== null : false;
  const out: Record<string, unknown> = {
    id: m.id,
    type: "memory",
    path: m.path,
    head_version: m.head_version,
    content_sha256: head && !redacted ? head.content_sha256 : null,
    size_bytes: head ? Number(head.size_bytes) : 0,
    updated_at: iso(m.updated_at),
  };
  if (withContent) out.content = head && !redacted ? head.content : null;
  return out;
}

function throwIfArchived(s: MemoryStoreView): void {
  if (s.archived_at) throw errConflict(`memory store ${s.id} is archived`);
}

export function registerMemoryRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const db: Kysely<Database> = ctx.db;

  // ---- Stores（MEM-01）----
  app.post("/v1/memory-stores", async (req, reply) =>
    withIdempotency(db, req, reply, async () => {
      const parsed = memoryStoreCreateSchema.parse(req.body ?? {});
      const store = await createStore(db, req.mas.auth!.workspaceId, {
        name: parsed.name,
        description: parsed.description ?? null,
      });
      reply.code(201);
      return storeJson(store) as unknown as Record<string, unknown>;
    }),
  );

  app.get("/v1/memory-stores", async (req) => {
    const query = req.query as Record<string, string | string[]>;
    const rows = await db
      .selectFrom("memory_stores")
      .selectAll()
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .$if(query.include_archived !== "true", (q) => q.where("archived_at", "is", null))
      .orderBy("created_at", "asc")
      .execute();
    return { data: rows.map(storeJson), next_page: null };
  });

  app.get("/v1/memory-stores/:id", async (req) => {
    const { id } = req.params as { id: string };
    return storeJson(await getMemoryStore(db, req.mas.auth!.workspaceId, id));
  });

  app.post("/v1/memory-stores/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    const store = await getMemoryStore(db, ws, id);
    if (store.archived_at) throw errConflict("memory_store_archived");
    const updated = await db
      .updateTable("memory_stores")
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return storeJson(updated!);
  });

  app.delete("/v1/memory-stores/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    await getMemoryStore(db, ws, id);
    const refs = await db
      .selectFrom("session_resources")
      .select(["id"])
      .where("memory_store_id", "=", id)
      .execute();
    if (refs.length > 0) throw errConflict(`memory store ${id} is still mounted by ${refs.length} session(s)`);
    await db.transaction().execute(async (tx) => {
      const mems = await tx.selectFrom("memories").select(["id"]).where("store_id", "=", id).execute();
      for (const m of mems) {
        await tx.deleteFrom("memory_versions").where("memory_id", "=", m.id).execute();
      }
      await tx.deleteFrom("memories").where("store_id", "=", id).execute();
      await tx.deleteFrom("memory_stores").where("id", "=", id).execute();
    });
    return { id, type: "memory_store_deleted" as const };
  });

  // ---- 写入 memory（MEM-02/03/04）----
  app.post("/v1/memory-stores/:id/memories", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    throwIfArchived(await getMemoryStore(db, ws, id));
    const parsed = memoryUpsertSchema.parse(req.body ?? {});
    try {
      const result = await upsertMemory(db, {
        workspaceId: ws,
        storeId: id,
        path: parsed.path,
        content: parsed.content,
        preconditionSha: parsed.precondition?.content_sha256,
      });
      reply.code(result.created ? 201 : 200);
      const out = memoryJson(result.memory, result.version);
      out.version = result.version.version_no;
      return out;
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw errConflict(e.message);
      throw e;
    }
  });

  // ---- list（MEM-06）----
  app.get("/v1/memory-stores/:id/memories", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    await getMemoryStore(db, ws, id);
    const query = req.query as Record<string, string | string[]>;
    const view = query.view === "full" ? "full" : "metadata";
    const limitMax = view === "full" ? 20 : 100;
    const limitRaw = query.limit !== undefined ? Number(query.limit) : 20;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > limitMax) {
      throw errInvalid(`limit must be between 1 and ${limitMax} for view=${view}`);
    }
    let depth: number | undefined;
    if (query.depth !== undefined) {
      depth = Number(query.depth);
      if (!Number.isInteger(depth) || depth < 1) throw errInvalid("depth must be an integer >= 1");
    }
    const pathPrefix = query.path_prefix !== undefined ? String(query.path_prefix) : undefined;
    if (pathPrefix !== undefined && (pathPrefix.startsWith("/") || pathPrefix.endsWith("/"))) {
      throw errInvalid("path_prefix must not start or end with '/'");
    }

    const entries = await listMemoriesWithHead(db, id, { pathPrefix });
    const out: Record<string, unknown>[] = [];
    const prefixes = new Set<string>();
    for (const e of entries) {
      if (depth === undefined) {
        out.push(memoryJson(e.memory, e.head, view === "full"));
        continue;
      }
      const segs = e.memory.path.split("/");
      if (segs.length <= depth) {
        out.push(memoryJson(e.memory, e.head, view === "full"));
      } else {
        prefixes.add(segs.slice(0, depth).join("/"));
      }
    }
    for (const p of prefixes) out.push({ type: "memory_prefix", path: p });
    out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    const page = out.slice(0, limitRaw);
    return { data: page, next_page: null };
  });

  app.get("/v1/memory-stores/:id/memories/:mid", async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const { memory, head } = await getMemoryWithHead(db, req.mas.auth!.workspaceId, id, mid);
    return memoryJson(memory, head, true);
  });

  // ---- 删除（MEM-05）----
  app.delete("/v1/memory-stores/:id/memories/:mid", async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const query = req.query as Record<string, string | string[]>;
    let expected: string | undefined;
    const body = req.body as { expected_content_sha256?: string } | null;
    if (body?.expected_content_sha256 !== undefined) expected = String(body.expected_content_sha256);
    if (query.expected_content_sha256 !== undefined) expected = String(query.expected_content_sha256);
    if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) {
      throw errInvalid("expected_content_sha256 must be a 64-char hex string");
    }
    try {
      await deleteMemory(db, req.mas.auth!.workspaceId, id, mid, expected);
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw errConflict(e.message);
      throw e;
    }
    return { id: mid, type: "memory_deleted" as const };
  });

  // ---- 版本与 redact（MEM-07）----
  app.get("/v1/memory-stores/:id/memories/:mid/versions", async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const query = req.query as Record<string, string | string[]>;
    const view = query.view === "full" ? "full" : "metadata";
    const { memory } = await getMemoryWithHead(db, req.mas.auth!.workspaceId, id, mid);
    void memory;
    const rows = await listVersions(db, mid);
    return { data: rows.map((v) => versionJson(v, { includeContent: view === "full" })), next_page: null };
  });

  app.post("/v1/memory-stores/:id/memories/:mid/versions/:vid/redact", async (req) => {
    const { id, mid, vid } = req.params as { id: string; mid: string; vid: string };
    try {
      const updated = await redactVersion(db, req.mas.auth!.workspaceId, id, mid, vid);
      return versionJson(updated, { includeContent: true });
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw errConflict(e.message);
      throw e;
    }
  });
}
