import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import {
  errConflict,
  errInvalid,
  errNotFound,
  newId,
  sessionCreateSchema,
  sessionUpdateSchema,
} from "@mas/core";
import type { Database } from "@mas/db";
import {
  admitEvents,
  appendApiEvent,
  getAgent,
  getEnvironmentRow,
  getSessionRow,
  listSessionResources,
  sessionRowToJson,
} from "@mas/db";
import type { RouteCtx } from "./agents.js";
import { withIdempotency } from "../plugins/idempotent-route.js";

export function registerSessionRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  app.post("/v1/sessions", async (req, reply) =>
    withIdempotency(ctx.db, req, reply, async () => {
    const parsed = sessionCreateSchema.parse(req.body ?? {});
    const ws = req.mas.auth!.workspaceId;

    // 解析 agent 三形态 → 固定版本快照（SES-01/02/04）
    let agentId: string;
    let agentVersion: number | undefined;
    let overrides: { system?: string | null; tools?: unknown[]; mcp_servers?: unknown[]; model?: unknown } | undefined;
    if (typeof parsed.agent === "string") {
      agentId = parsed.agent;
    } else if (parsed.agent.type === "agent") {
      agentId = parsed.agent.id;
      agentVersion = parsed.agent.version;
    } else {
      overrides = parsed.agent;
      const inner = parsed.agent.agent;
      agentId = typeof inner === "string" ? inner : inner.id;
      agentVersion = typeof inner === "string" ? undefined : inner.version;
    }
    const head = await ctx.db
      .selectFrom("agents")
      .select(["head_version", "archived_at"])
      .where("id", "=", agentId)
      .where("workspace_id", "=", ws)
      .executeTakeFirst();
    if (!head) throw errNotFound(`agent ${agentId} not found`);
    if (head.archived_at) throw errInvalid(`agent ${agentId} is archived`); // AGT-25
    if (agentVersion !== undefined && agentVersion > head.head_version) {
      throw errInvalid(`agent ${agentId} has no version ${agentVersion}; latest is ${head.head_version}`);
    }
    const agent = await getAgent(ctx.db, ws, agentId, agentVersion);

    const env = await getEnvironmentRow(ctx.db, ws, parsed.environment_id);
    if (env.archived_at) throw errInvalid("environment is archived"); // ENV-11

    // vault_ids 校验：存在、同 workspace、未归档（spec §10.1 解析时机）
    for (const vid of parsed.vault_ids ?? []) {
      const vault = await ctx.db
        .selectFrom("vaults")
        .select(["id", "archived_at"])
        .where("id", "=", vid)
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      if (!vault) throw errNotFound(`vault ${vid} not found`);
      if (vault.archived_at) throw errConflict(`vault ${vid} is archived`);
    }

    // 快照：overrides 整体替换（SES-04）
    const snapshot: Record<string, unknown> = {
      type: "agent",
      id: agent.id,
      version: agent.version,
      name: agent.name,
      model: overrides?.model ?? agent.model,
      system: overrides?.system !== undefined ? overrides.system : agent.system,
      tools: overrides?.tools !== undefined ? overrides.tools : agent.tools,
      mcp_servers: overrides?.mcp_servers !== undefined ? overrides.mcp_servers : agent.mcp_servers,
      skills: agent.skills ?? [],
      metadata: agent.metadata,
    };

    const sessionId = newId("sesn");
    await ctx.db
      .insertInto("sessions")
      .values({
        id: sessionId,
        workspace_id: ws,
        agent_snapshot: snapshot,
        environment_id: env.id,
        environment_snapshot: {
          id: env.id,
          type: "environment",
          name: env.name,
          config: env.config,
        },
        status: "idle",
        title: parsed.title ?? null,
        metadata: parsed.metadata ?? {},
        vault_ids: parsed.vault_ids ?? [],
      })
      .execute();

    // 挂载资源（RES-01 / MEM-08 / SES-10）：校验文件与 memory store 存在、路径重叠与重复挂载
    const mounted = new Set<string>();
    for (const r of parsed.resources ?? []) {
      if (r.type === "memory_store") {
        const store = await ctx.db
          .selectFrom("memory_stores")
          .select(["id", "slug", "archived_at"])
          .where("id", "=", r.memory_store_id)
          .where("workspace_id", "=", ws)
          .executeTakeFirst();
        if (!store) throw errNotFound(`memory store ${r.memory_store_id} not found`);
        if (store.archived_at) throw errConflict(`memory store ${r.memory_store_id} is archived`);
        await ctx.db
          .insertInto("session_resources")
          .values({
            id: newId("sesrsc"),
            session_id: sessionId,
            type: "memory_store",
            file_id: null,
            memory_store_id: r.memory_store_id,
            read_only: r.read_only ?? true,
            // 挂载点由平台固定（spec §19）：/mnt/memory/<slug>
            mount_path: `/mnt/memory/${store.slug}`,
          })
          .execute();
        continue;
      }
      if (r.type === "skill") {
        const skill = await ctx.db
          .selectFrom("skills")
          .select(["id", "directory", "latest_version", "archived_at"])
          .where("id", "=", r.skill_id)
          .where("workspace_id", "=", ws)
          .executeTakeFirst();
        if (!skill) throw errNotFound(`skill ${r.skill_id} not found`);
        if (skill.archived_at) throw errConflict(`skill ${r.skill_id} is archived`);
        if (r.version !== undefined && r.version > skill.latest_version) {
          throw errInvalid(`skill ${r.skill_id} has no version ${r.version}; latest is ${skill.latest_version}`);
        }
        await ctx.db
          .insertInto("session_resources")
          .values({
            id: newId("sesrsc"),
            session_id: sessionId,
            type: "skill",
            file_id: null,
            skill_id: r.skill_id,
            skill_version: r.version ?? null,
            // 挂载点固定（plan M6 W12 / SKL-06）：/workspace/skills/<directory>
            mount_path: `/workspace/skills/${skill.directory}`,
          })
          .execute();
        continue;
      }
      const file = await ctx.db
        .selectFrom("files")
        .select(["id"])
        .where("id", "=", r.file_id)
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      if (!file) throw errNotFound(`file ${r.file_id} not found`);
      const norm = normalizeMountPath(r.mount_path);
      for (const m of mounted) {
        if (m === norm || m.startsWith(`${norm}/`) || norm.startsWith(`${m}/`)) {
          throw errInvalid(`mount_path ${r.mount_path} overlaps with ${m}`);
        }
      }
      mounted.add(norm);
      await ctx.db
        .insertInto("session_resources")
        .values({ id: newId("sesrsc"), session_id: sessionId, type: "file", file_id: r.file_id, mount_path: r.mount_path })
        .execute();
    }

    // initial_events（SES-06）：与 POST events 相同的准入路径
    if (parsed.initial_events?.length) {
      const events = parsed.initial_events.map((e) => ({
        id: newId("sevt"),
        type: e.type,
        payload: e as Record<string, unknown>,
      }));
      await admitEvents(ctx.db, {
        sessionId,
        workspaceId: ws,
        events,
        executionKind: "user_message",
      });
    }

    const row = await getSessionRow(ctx.db, ws, sessionId);
    const resources = await listSessionResources(ctx.db, sessionId);
    return sessionRowToJson(row, resources) as unknown as Record<string, unknown>;
    }),
  );

  app.get("/v1/sessions", async (req) => {
    const query = req.query as Record<string, string | string[]>;
    const ws = req.mas.auth!.workspaceId;
    if (query.agent_version && !query.agent_id) {
      throw errInvalid("agent_version requires agent_id");
    }
    const statuses = Array.isArray(query.statuses)
      ? query.statuses
      : query.statuses
        ? String(query.statuses).split(",").filter(Boolean)
        : [];
    for (const s of statuses) {
      if (!["idle", "running", "rescheduling", "terminated"].includes(s)) {
        throw errInvalid(`invalid status ${s}`);
      }
    }
    const limit = Math.min(Number((query.limit as string) ?? 20) || 20, 100);
    const rows = await ctx.db
      .selectFrom("sessions")
      .selectAll()
      .where("workspace_id", "=", ws)
      .$if(!!query.agent_id, (q) => q.where(sql`agent_snapshot->>'id'`, "=", query.agent_id as string))
      .$if(!!query.agent_id && !!query.agent_version, (q) =>
        q.where(sql`(agent_snapshot->>'version')::int`, "=", Number(query.agent_version)),
      )
      .$if(statuses.length > 0, (q) => q.where("status", "in", statuses))
      .$if(!!query["created_at[gte]"], (q) => q.where("created_at", ">=", new Date(String(query["created_at[gte]"]))))
      .$if(!!query["created_at[lte]"], (q) => q.where("created_at", "<=", new Date(String(query["created_at[lte]"]))))
      .$if(query.include_archived !== "true", (q) => q.where("archived_at", "is", null))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const data = [];
    for (const r of page) {
      data.push(sessionRowToJson(r, await listSessionResources(ctx.db, r.id)));
    }
    return { data, next_page: rows.length > limit ? String(page[page.length - 1]!.id) : null };
  });

  app.get("/v1/sessions/:id", async (req) => {
    const { id } = req.params as { id: string };
    const row = await getSessionRow(ctx.db, req.mas.auth!.workspaceId, id);
    return sessionRowToJson(row, await listSessionResources(ctx.db, id));
  });

  app.post("/v1/sessions/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = sessionUpdateSchema.parse(req.body ?? {});
    if (Object.keys(patch).length === 0) throw errInvalid("empty update body");
    const row = await getSessionRow(ctx.db, req.mas.auth!.workspaceId, id);
    if (row.archived_at) throw errConflict("session is archived");

    if (patch.agent) {
      // SES-17/18：agent.tools 只能在 idle 时修改
      if (row.status !== "idle") throw errConflict("session_not_idle");
      if (row.stop_reason?.type === "requires_action") throw errConflict("session_not_idle");
      const snapshot = { ...row.agent_snapshot };
      if (patch.agent.tools !== undefined) snapshot.tools = patch.agent.tools ?? [];
      if (patch.agent.mcp_servers !== undefined) snapshot.mcp_servers = patch.agent.mcp_servers ?? [];
      await ctx.db.updateTable("sessions").set({ agent_snapshot: snapshot, updated_at: new Date() }).where("id", "=", id).execute();
    }
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.metadata !== undefined) {
      set.metadata = patch.metadata === null ? {} : mergeMeta(row.metadata, patch.metadata);
    }
    await ctx.db.updateTable("sessions").set(set).where("id", "=", id).execute();
    const updated = await getSessionRow(ctx.db, req.mas.auth!.workspaceId, id);
    return sessionRowToJson(updated, await listSessionResources(ctx.db, id));
  });

  app.post("/v1/sessions/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    return dbTransactionArchive(ctx, req.mas.auth!.workspaceId, id);
  });

  app.delete("/v1/sessions/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    const row = await getSessionRow(ctx.db, ws, id);
    if (row.status === "running") throw errConflict("cannot delete a running session");
    if (row.status === "rescheduling") throw errConflict("cannot delete a rescheduling session");
    // 写 session.deleted 后删除事件与资源（spec §11.4）；SSE 通过 'deleted' NOTIFY 推送合成帧
    await appendApiEvent(ctx.db, id, "session.deleted", { id, type: "session.deleted" });
    await ctx.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("session_events").where("session_id", "=", id).execute();
      await tx.deleteFrom("session_resources").where("session_id", "=", id).execute();
      await tx.deleteFrom("session_executions").where("session_id", "=", id).execute();
      await tx.deleteFrom("sessions").where("id", "=", id).execute();
    });
    const pool = ctx.pool as { query: (q: string) => Promise<unknown> } | undefined;
    if (pool) await pool.query(`SELECT pg_notify('session:${id}', 'deleted')`);
    return { id, type: "session_deleted" as const };
  });

  // 运行中挂载资源（RES-02 / MEM-08 / SKL-06）
  app.post("/v1/sessions/:id/resources", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      type?: string;
      file_id?: string;
      mount_path?: string;
      memory_store_id?: string;
      read_only?: boolean;
      skill_id?: string;
      version?: number;
    };
    const row = await getSessionRow(ctx.db, req.mas.auth!.workspaceId, id);
    if (row.archived_at) throw errConflict("session is archived");

    if (body.type === "skill") {
      if (!body.skill_id) throw errInvalid("skill resources require skill_id");
      const ws = req.mas.auth!.workspaceId;
      const skill = await ctx.db
        .selectFrom("skills")
        .select(["id", "directory", "latest_version", "archived_at"])
        .where("id", "=", body.skill_id)
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      if (!skill) throw errNotFound(`skill ${body.skill_id} not found`);
      if (skill.archived_at) throw errConflict(`skill ${body.skill_id} is archived`);
      const existing = await listSessionResources(ctx.db, id);
      if (existing.filter((e) => e.type === "skill").length >= 16) {
        throw errInvalid("at most 16 skill resources per session");
      }
      const pinned = body.version ?? null;
      if (pinned !== null && pinned > skill.latest_version) {
        throw errInvalid(`skill ${body.skill_id} has no version ${pinned}; latest is ${skill.latest_version}`);
      }
      const rid = newId("sesrsc");
      await ctx.db
        .insertInto("session_resources")
        .values({
          id: rid,
          session_id: id,
          type: "skill",
          file_id: null,
          skill_id: body.skill_id,
          skill_version: pinned,
          mount_path: `/workspace/skills/${skill.directory}`,
        })
        .execute();
      return { id: rid, type: "skill", skill_id: body.skill_id, version: pinned, mount_path: `/workspace/skills/${skill.directory}` };
    }

    if (body.type === "memory_store") {
      if (!body.memory_store_id) throw errInvalid("memory_store resources require memory_store_id");
      if (body.read_only !== undefined && typeof body.read_only !== "boolean") {
        throw errInvalid("read_only must be a boolean");
      }
      const ws = req.mas.auth!.workspaceId;
      const store = await ctx.db
        .selectFrom("memory_stores")
        .select(["id", "slug", "archived_at"])
        .where("id", "=", body.memory_store_id)
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      if (!store) throw errNotFound(`memory store ${body.memory_store_id} not found`);
      if (store.archived_at) throw errConflict(`memory store ${body.memory_store_id} is archived`);
      const existing = await listSessionResources(ctx.db, id);
      const memCount = existing.filter((e) => e.type === "memory_store").length;
      if (memCount >= 8) throw errInvalid("at most 8 memory_store resources per session");
      for (const e of existing) {
        if (e.memory_store_id === body.memory_store_id) {
          throw errConflict(`memory store ${body.memory_store_id} is already mounted`);
        }
      }
      const rid = newId("sesrsc");
      const readOnly = body.read_only ?? true;
      await ctx.db
        .insertInto("session_resources")
        .values({
          id: rid,
          session_id: id,
          type: "memory_store",
          file_id: null,
          memory_store_id: body.memory_store_id,
          read_only: readOnly,
          mount_path: `/mnt/memory/${store.slug}`,
        })
        .execute();
      return { id: rid, type: "memory_store", memory_store_id: body.memory_store_id, read_only: readOnly, mount_path: `/mnt/memory/${store.slug}` };
    }

    if (!body.file_id || !body.mount_path || body.type !== "file") {
      throw errInvalid("resources require type=file (file_id, mount_path) or type=memory_store (memory_store_id)");
    }
    const existing = await listSessionResources(ctx.db, id);
    if (existing.filter((e) => e.type === "file").length >= 500) {
      throw errInvalid("at most 500 file resources per session");
    }
    const file = await ctx.db
      .selectFrom("files")
      .select(["id"])
      .where("id", "=", body.file_id)
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .executeTakeFirst();
    if (!file) throw errNotFound(`file ${body.file_id} not found`);
    const norm = normalizeMountPath(body.mount_path);
    for (const e of existing.filter((r) => r.type === "file")) {
      const en = normalizeMountPath(e.mount_path);
      if (en === norm || en.startsWith(`${norm}/`) || norm.startsWith(`${en}/`)) {
        throw errInvalid(`mount_path ${body.mount_path} overlaps with ${e.mount_path}`);
      }
    }
    const rid = newId("sesrsc");
    await ctx.db
      .insertInto("session_resources")
      .values({ id: rid, session_id: id, type: "file", file_id: body.file_id, mount_path: body.mount_path })
      .execute();
    return { id: rid, type: "file", file_id: body.file_id, mount_path: body.mount_path };
  });

  app.get("/v1/sessions/:id/resources", async (req) => {
    const { id } = req.params as { id: string };
    await getSessionRow(ctx.db, req.mas.auth!.workspaceId, id);
    const resources = await listSessionResources(ctx.db, id);
    return { data: resources, next_page: null };
  });

  app.delete("/v1/sessions/:id/resources/:rid", async (req) => {
    const { id, rid } = req.params as { id: string; rid: string };
    await getSessionRow(ctx.db, req.mas.auth!.workspaceId, id);
    const deleted = await ctx.db
      .deleteFrom("session_resources")
      .where("id", "=", rid)
      .where("session_id", "=", id)
      .returning(["id"])
      .execute();
    if (deleted.length === 0) throw errNotFound(`resource ${rid} not found`);
    return { id: rid, type: "session_resource_deleted" as const };
  });
}

function mergeMeta(
  current: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

function normalizeMountPath(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0 && s !== ".");
  if (parts.includes("..")) throw errInvalid("mount_path must not contain '..'");
  return parts.join("/");
}

async function dbTransactionArchive(ctx: RouteCtx, ws: string, id: string) {
  const row = await getSessionRow(ctx.db, ws, id);
  if (row.archived_at) throw errConflict("session_archived");
  if (row.status === "running" || row.status === "rescheduling") {
    throw errConflict("cannot archive a running session");
  }
  await appendApiEvent(ctx.db, id, "session.updated", { id, archived: true });
  const updated = await ctx.db
    .updateTable("sessions")
    .set({ archived_at: new Date(), updated_at: new Date() })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  return sessionRowToJson(updated!, await listSessionResources(ctx.db, id));
}
