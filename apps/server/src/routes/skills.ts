import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { errInvalid } from "@mas/core";
import type { Database, SkillView, SkillVersionView } from "@mas/db";
import { addSkillVersion, createSkill, deleteSkill, getSkill, getSkillVersion, InvalidSkillZipError, normalizeSkillZip } from "@mas/db";
import type { RouteCtx } from "./agents.js";
import { withIdempotency } from "../plugins/idempotent-route.js";
import { contentStore } from "./files.js";

/**
 * Skills（plan M6 W12 / test-case-plan 5.13 SKL-01~07）：
 * multipart zip 上传 → 规范化（≤200 文件、越界剔除）→ 版本化存储；
 * 目录名冲突 409 skill_directory_conflict；下载版本 zip；source=zai 为内置。
 */

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const MAX_SKILL_ZIP_BYTES = 100 * 1024 * 1024;

function skillJson(s: SkillView) {
  return {
    id: s.id,
    type: "skill",
    source: s.source,
    directory: s.directory,
    description: s.description,
    latest_version: s.latest_version,
    archived_at: s.archived_at ? iso(s.archived_at) : null,
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
  };
}

function versionJson(v: SkillVersionView) {
  return {
    id: v.id,
    skill_id: v.skill_id,
    version: v.version,
    file_count: v.file_count,
    size_bytes: Number(v.size_bytes),
    sha256: v.sha256,
    created_at: iso(v.created_at),
  };
}

function validateDirectory(name: string): string | null {
  if (!name || name === "." || name === "..") return "directory must not be '.' or '..'";
  if (name.length > 255) return "directory exceeds 255 characters";
  if (/[<>:"|?*\\/]/.test(name)) return "directory contains illegal characters";
  if (/[\x00-\x1f]/.test(name)) return "directory contains control characters";
  return null;
}

/** 读 multipart：file part（zip 字节）+ 可选 directory/description 字段。 */
async function readUpload(req: any): Promise<{ bytes: Buffer; directory?: string; description: string | null }> {
  if (!req.isMultipart?.()) throw errInvalid("upload must be multipart/form-data with a 'file' part");
  let fileBytes: Buffer | null = null;
  let directory: string | undefined;
  let description: string | null = null;
  for await (const part of req.parts()) {
    if (part.type !== "file") {
      if (part.fieldname === "directory") directory = String(part.value);
      if (part.fieldname === "description") description = String(part.value);
      continue;
    }
    if (part.fieldname !== "file") continue;
    const bytes: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > MAX_SKILL_ZIP_BYTES) throw errInvalid(`skill zip exceeds ${MAX_SKILL_ZIP_BYTES} bytes`);
      bytes.push(chunk as Buffer);
    }
    fileBytes = Buffer.concat(bytes);
  }
  if (!fileBytes) throw errInvalid("multipart body must contain a 'file' part");
  return { bytes: fileBytes, directory, description };
}

export function registerSkillRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const db = ctx.db as unknown as import("kysely").Kysely<Database>;

  // ---- 上传（SKL-01/02/03）----
  app.post("/v1/skills", async (req, reply) => {
    const ws = req.mas.auth!.workspaceId;
    const upload = await readUpload(req);
    let normalized;
    try {
      normalized = normalizeSkillZip(upload.bytes);
    } catch (e) {
      if (e instanceof InvalidSkillZipError) throw errInvalid(e.message);
      throw e;
    }
    const dir = upload.directory ?? normalized.rootDirectory ?? "skill";
    const invalid = validateDirectory(dir);
    if (invalid) throw errInvalid(invalid);
    // multipart 幂等（偏差 #10）：指纹 = 目录 + 描述 + 规范化文件集
    const fingerprint = `multipart skill directory=${dir} description=${upload.description ?? ""} files=${JSON.stringify(normalized.files.map((f) => [f.path, createHash("sha256").update(f.content).digest("hex")]))}`;
    return withIdempotency(db, req, reply, async () => {
      const stored = await createSkill(db, contentStore(), {
        workspaceId: ws,
        directory: dir,
        description: upload.description,
        files: normalized.files,
      });
      reply.code(201);
      // version 字段在前，skill 的 id 在后（顶层 id 是 skill id）
      return { ...versionJson(stored.version), ...skillJson(stored.skill) };
    }, fingerprint);
  });

  // ---- 列表 / 单个（SKL-07）----
  app.get("/v1/skills", async (req) => {
    const query = req.query as Record<string, string | string[]>;
    const source = query.source === "zai" ? "zai" : query.source === "user" ? "user" : undefined;
    const rows = await db
      .selectFrom("skills")
      .selectAll()
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .$if(source !== undefined, (q) => q.where("source", "=", source!))
      .$if(query.include_archived !== "true", (q) => q.where("archived_at", "is", null))
      .orderBy("created_at", "asc")
      .execute();
    return { data: rows.map(skillJson), next_page: null };
  });

  app.get("/v1/skills/:id", async (req) => {
    const { id } = req.params as { id: string };
    return skillJson(await getSkill(db, req.mas.auth!.workspaceId, id));
  });

  app.get("/v1/skills/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    await getSkill(db, req.mas.auth!.workspaceId, id);
    const rows = await db
      .selectFrom("skill_versions")
      .selectAll()
      .where("skill_id", "=", id)
      .orderBy("version", "desc")
      .execute();
    return { data: rows.map(versionJson), next_page: null };
  });

  // ---- 新版本（SKL-04）----
  app.post("/v1/skills/:id/versions", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    const upload = await readUpload(req);
    let normalized;
    try {
      normalized = normalizeSkillZip(upload.bytes);
    } catch (e) {
      if (e instanceof InvalidSkillZipError) throw errInvalid(e.message);
      throw e;
    }
    const fingerprint = `multipart skill-version skill=${id} files=${JSON.stringify(normalized.files.map((f) => [f.path, createHash("sha256").update(f.content).digest("hex")]))}`;
    return withIdempotency(db, req, reply, async () => {
      const stored = await addSkillVersion(db, contentStore(), { workspaceId: ws, skillId: id, files: normalized.files });
      reply.code(201);
      return versionJson(stored.version);
    }, fingerprint);
  });

  // ---- 下载版本 zip（SKL-03/04）----
  app.get("/v1/skills/:id/versions/:version/content", async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string };
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1) throw errInvalid("version must be an integer >= 1");
    const { version: row } = await getSkillVersion(db, req.mas.auth!.workspaceId, id, v);
    const content = await contentStore().get(row.object_key);
    if (!content) throw errInvalid("skill content is missing from object store");
    reply.header("content-type", "application/zip");
    reply.header("content-length", String(content.length));
    return reply.send(content);
  });
  app.get("/v1/skills/:id/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const skill = await getSkill(db, req.mas.auth!.workspaceId, id);
    const { version: row } = await getSkillVersion(db, req.mas.auth!.workspaceId, id, skill.latest_version);
    const content = await contentStore().get(row.object_key);
    if (!content) throw errInvalid("skill content is missing from object store");
    reply.header("content-type", "application/zip");
    reply.header("content-length", String(content.length));
    return reply.send(content);
  });

  // ---- 归档 / 删除（SKL-05）----
  app.post("/v1/skills/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const skill = await getSkill(db, req.mas.auth!.workspaceId, id);
    if (skill.archived_at) return skillJson(skill);
    const updated = await db
      .updateTable("skills")
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return skillJson(updated!);
  });

  app.delete("/v1/skills/:id", async (req) => {
    const { id } = req.params as { id: string };
    await deleteSkill(db, req.mas.auth!.workspaceId, id);
    return { id, type: "skill_deleted" as const };
  });
}
