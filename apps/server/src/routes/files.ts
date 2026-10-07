import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Selectable } from "kysely";
import { errInvalid, errNotFound, newId } from "@mas/core";
import type { Database, FileRow } from "@mas/db";
import { objectStoreFromEnv, type SnapshotStore } from "@mas/db";
import type { RouteCtx } from "./agents.js";
import { withIdempotency } from "../plugins/idempotent-route.js";

/**
 * Files API（spec §5.5 / §11.4）：org 级上传与 session 输出共用 files 表；
 * 内容走内容存储（SnapshotStore：默认本地 FS，MAS_OBJECT_STORE=s3 切 MinIO/S3）。
 * 分页用 before_id / after_id（C-06），二者同传 400。
 */

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const MAX_FILE_BYTES = Number(process.env.MAS_MAX_FILE_BYTES ?? 500 * 1024 * 1024);

/** 非法文件名（FILE-02）`.`、`..`、Windows/Linux 保留字符、控制字符、>255。 */
export function validateFilename(name: string): string | null {
  if (!name || name === "." || name === "..") return "filename must not be '.' or '..'";
  if (name.length > 255) return "filename exceeds 255 characters";
  if (/[<>:"|?*\\/]/.test(name)) return "filename contains illegal characters";
  if (/[\x00-\x1f]/.test(name)) return "filename contains control characters";
  return null;
}

function fileJson(f: Selectable<FileRow>) {
  return {
    id: f.id,
    type: "file",
    scope: f.scope_type === "session" ? { type: "session", id: f.scope_id } : { type: "org" },
    filename: f.filename,
    mime: f.mime,
    size: Number(f.size),
    sha256: f.sha256,
    created_at: iso(f.created_at),
    expires_at: f.expires_at ? iso(f.expires_at) : null,
  };
}

async function getFileRow(ctx: RouteCtx, ws: string, id: string): Promise<Selectable<FileRow>> {
  const row = await ctx.db
    .selectFrom("files")
    .selectAll()
    .where("id", "=", id)
    .where("workspace_id", "=", ws)
    .executeTakeFirst();
  if (!row) throw errNotFound(`file ${id} not found`);
  return row;
}

export function contentStore(): SnapshotStore {
  // MAS_OBJECT_STORE=s3 → MinIO/S3（key 布局与 FS 一致）；默认本地 FS
  return objectStoreFromEnv(process.env, process.env.MAS_FILES_DIR ?? "/tmp/mas-files");
}

export function registerFileRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  app.post("/v1/files", async (req, reply) => {
    const ws = req.mas.auth!.workspaceId;
    if (!req.isMultipart?.()) throw errInvalid("upload must be multipart/form-data with a 'file' part");

    const part = await req.file();
    if (!part) throw errInvalid("multipart body must contain a 'file' part");
    const filename = part.filename ?? "";
    const invalid = validateFilename(filename);
    if (invalid) throw errInvalid(invalid);

    const store = contentStore();
    const bytes: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) throw errInvalid(`file exceeds ${MAX_FILE_BYTES} bytes`);
      bytes.push(chunk as Buffer);
    }
    const content = Buffer.concat(bytes);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const mime = part.mimetype?.trim() || "application/octet-stream";
    // multipart 幂等（偏差 #10）：指纹 = 文件名 + 内容哈希 + mime，重放不重复登记 File
    const fingerprint = `multipart file filename=${filename} sha256=${sha256} mime=${mime}`;
    return withIdempotency(ctx.db, req, reply, async () => {
      const id = newId("file");
      const objectKey = `files/${ws}/${id}`;
      await store.put(objectKey, content);
      await ctx.db
        .insertInto("files")
        .values({
          id,
          workspace_id: ws,
          scope_type: "org",
          scope_id: null,
          filename,
          mime,
          size: content.length,
          sha256,
          object_key: objectKey,
        })
        .execute();
      return fileJson(await getFileRow(ctx, ws, id));
    }, fingerprint);
  });

  app.get("/v1/files", async (req) => {
    const ws = req.mas.auth!.workspaceId;
    const query = req.query as Record<string, string | string[]>;
    if (query.before_id && query.after_id) {
      throw errInvalid("before_id and after_id are mutually exclusive");
    }
    const limitRaw = Number((query.limit as string) ?? 100);
    if (Number.isNaN(limitRaw) || limitRaw < 1) throw errInvalid("limit must be >= 1");
    const limit = Math.min(Math.trunc(limitRaw), 1000);
    const scopeId = query.scope_id as string | undefined;

    const rows = await ctx.db
      .selectFrom("files")
      .selectAll()
      .where("workspace_id", "=", ws)
      .$if(!!scopeId, (q) => q.where("scope_type", "=", "session").where("scope_id", "=", scopeId!))
      .$if(!scopeId, (q) => q.where("scope_type", "=", "org"))
      .$if(!!query.before_id, (q) => q.where("id", "<", query.before_id!))
      .$if(!!query.after_id, (q) => q.where("id", ">", query.after_id!))
      .orderBy("id", query.before_id ? "desc" : "asc")
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const nextPage =
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({ before_id: page[page.length - 1]!.id, direction: query.before_id ? "before" : "after" }),
          ).toString("base64url")
        : null;
    return { data: page.map(fileJson), next_page: nextPage };
  });

  app.get("/v1/files/:id", async (req) => {
    const { id } = req.params as { id: string };
    return fileJson(await getFileRow(ctx, req.mas.auth!.workspaceId, id));
  });

  app.get("/v1/files/:id/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getFileRow(ctx, req.mas.auth!.workspaceId, id);
    const store = contentStore();
    const content = await store.get(row.object_key);
    reply.header("content-type", row.mime);
    reply.header("content-length", String(content.length));
    return reply.send(content);
  });

  app.delete("/v1/files/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    const row = await getFileRow(ctx, ws, id);
    // 内容对象尽力删除；行删除后不可再访问
    await contentStore().delete(row.object_key).catch(() => undefined);
    await ctx.db.deleteFrom("files").where("id", "=", id).execute();
    return { id, type: "file_deleted" };
  });
}
