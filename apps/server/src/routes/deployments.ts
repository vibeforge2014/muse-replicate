import type { FastifyInstance } from "fastify";
import { errConflict, errInvalid } from "@mas/core";
import type { Kysely } from "kysely";
import type { Database, DeploymentRunSel, DeploymentSel } from "@mas/db";
import { createDeployment, enqueueManualRun, getDeployment, listRuns } from "@mas/db";
import { DEPLOYMENT_TZ, upcomingFires, validateCronForDeployment } from "@mas/core";
import type { RouteCtx } from "./agents.js";
import { withIdempotency } from "../plugins/idempotent-route.js";

/**
 * Deployments（plan M6 W12 / DEP-01~09）：cron 调度 + 手动 run + 归档联动。
 * upcoming_runs_at 实时计算（active 且有 schedule 时最多 5 项；paused/archived 为空）。
 */

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function deploymentJson(d: DeploymentSel): Record<string, unknown> {
  const upcoming =
    d.status === "active" && d.schedule ? upcomingFires(d.schedule, 5).map((t) => new Date(t).toISOString()) : [];
  return {
    id: d.id,
    type: "deployment",
    agent: { type: "agent", id: d.agent_id, version: d.agent_version },
    environment_id: d.environment_id,
    schedule: d.schedule,
    timezone: d.timezone,
    input: d.input,
    status: d.status,
    upcoming_runs_at: upcoming,
    last_run_at: null,
    archived_at: d.archived_at ? iso(d.archived_at) : null,
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
  };
}

function runJson(r: DeploymentRunSel): Record<string, unknown> {
  return {
    id: r.id,
    type: "deployment_run",
    deployment_id: r.deployment_id,
    session_id: r.session_id,
    trigger_type: r.trigger_type,
    trigger_context: r.trigger_context,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    scheduled_for: r.scheduled_for ? iso(r.scheduled_for) : null,
    started_at: r.started_at ? iso(r.started_at) : null,
    finished_at: r.finished_at ? iso(r.finished_at) : null,
    created_at: iso(r.created_at),
  };
}

export function registerDeploymentRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const db = ctx.db as unknown as Kysely<Database>;

  // ---- 创建（DEP-01/02/03）----
  app.post("/v1/deployments", async (req, reply) =>
    withIdempotency(db, req, reply, async () => {
      const body = (req.body ?? {}) as {
        agent?: string;
        environment_id?: string;
        schedule?: string | null;
        timezone?: string;
        input?: Record<string, unknown>;
      };
      const ws = req.mas.auth!.workspaceId;
      if (!body.agent || !body.environment_id) throw errInvalid("agent and environment_id are required");
      if (body.timezone !== undefined && body.timezone !== DEPLOYMENT_TZ) {
        throw errInvalid(`timezone must be ${DEPLOYMENT_TZ}`);
      }
      if (body.schedule !== undefined && body.schedule !== null) {
        const check = validateCronForDeployment(body.schedule);
        if (!check.ok) throw errInvalid(check.error!);
      }
      if (body.input !== undefined && (typeof body.input !== "object" || Array.isArray(body.input))) {
        throw errInvalid("input must be an object");
      }

      // agent 解析 + 版本固定（DEP-01）
      const agentRef = body.agent;
      const agentId = agentRef;
      const head = await db
        .selectFrom("agents")
        .select(["head_version", "archived_at"])
        .where("id", "=", agentId)
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      if (!head) throw errInvalid(`agent ${agentId} not found`);
      if (head.archived_at) throw errConflict(`agent ${agentId} is archived`);
      const env = await db
        .selectFrom("environments")
        .select(["id", "archived_at"])
        .where("id", "=", body.environment_id)
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      if (!env) throw errInvalid(`environment ${body.environment_id} not found`);

      const dep = await createDeployment(db, {
        workspaceId: ws,
        agentId,
        agentVersion: head.head_version,
        environmentId: body.environment_id,
        schedule: body.schedule ?? null,
        input: body.input ?? {},
      });
      reply.code(201);
      return deploymentJson(dep);
    }),
  );

  app.get("/v1/deployments", async (req) => {
    const query = req.query as Record<string, string | string[]>;
    const rows = await db
      .selectFrom("deployments")
      .selectAll()
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .$if(query.include_archived !== "true", (q) => q.where("status", "!=", "archived"))
      .orderBy("created_at", "asc")
      .execute();
    return { data: rows.map(deploymentJson), next_page: null };
  });

  app.get("/v1/deployments/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deploymentJson(await getDeployment(db, req.mas.auth!.workspaceId, id));
  });

  // ---- pause / unpause / archive（DEP-05/06）----
  app.post("/v1/deployments/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    const dep = await getDeployment(db, req.mas.auth!.workspaceId, id);
    if (dep.status === "archived") throw errConflict(`deployment ${id} is archived`);
    const updated = await db
      .updateTable("deployments")
      .set({ status: "paused", updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return deploymentJson(updated!);
  });

  app.post("/v1/deployments/:id/unpause", async (req) => {
    const { id } = req.params as { id: string };
    const dep = await getDeployment(db, req.mas.auth!.workspaceId, id);
    if (dep.status === "archived") throw errConflict(`deployment ${id} is archived`);
    // upcoming 以当前时间为锚重新计算（DEP-05）：upcoming_runs_at 实时计算天然满足
    const updated = await db
      .updateTable("deployments")
      .set({ status: "active", updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return deploymentJson(updated!);
  });

  app.post("/v1/deployments/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const dep = await getDeployment(db, req.mas.auth!.workspaceId, id);
    if (dep.status === "archived") return deploymentJson(dep); // DEP-06 幂等
    const updated = await db
      .updateTable("deployments")
      .set({ status: "archived", archived_at: new Date(), updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return deploymentJson(updated!);
  });

  // ---- 手动 run（DEP-04/05/06）----
  app.post("/v1/deployments/:id/runs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { input?: Record<string, unknown> } | null;
    const run = await enqueueManualRun(db, req.mas.auth!.workspaceId, id, body?.input);
    reply.code(202);
    return runJson(run);
  });

  // ---- runs 过滤（DEP-07）----
  app.get("/v1/deployment_runs", async (req) => {
    const query = req.query as Record<string, string | string[]>;
    const ws = req.mas.auth!.workspaceId;
    const limitRaw = query.limit !== undefined ? Number(query.limit) : 50;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
      throw errInvalid("limit must be between 1 and 200");
    }
    let hasError: boolean | undefined;
    if (query.has_error === "true") hasError = true;
    if (query.has_error === "false") hasError = false;
    let triggerType: string | undefined;
    if (query.trigger_type !== undefined) {
      const t = Array.isArray(query.trigger_type) ? String(query.trigger_type[0]) : String(query.trigger_type);
      if (!["manual", "schedule"].includes(t)) throw errInvalid("trigger_type must be manual or schedule");
      triggerType = t;
    }
    const depFilter = query.deployment_id !== undefined
      ? Array.isArray(query.deployment_id) ? String(query.deployment_id[0]) : String(query.deployment_id)
      : undefined;
    const rows = await listRuns(db, ws, {
      deploymentId: depFilter || undefined,
      hasError,
      triggerType,
      createdAfter: query["created_at[gte]"] ? new Date(String(query["created_at[gte]"])) : undefined,
      createdBefore: query["created_at[lte]"] ? new Date(String(query["created_at[lte]"])) : undefined,
      limit: limitRaw,
    });
    return { data: rows.map(runJson), next_page: null };
  });

  app.get("/v1/deployments/:id/runs", async (req) => {
    const { id } = req.params as { id: string };
    await getDeployment(db, req.mas.auth!.workspaceId, id);
    const query = req.query as Record<string, string | string[]>;
    const rows = await listRuns(db, req.mas.auth!.workspaceId, { deploymentId: id, limit: 50 });
    void query;
    return { data: rows.map(runJson), next_page: null };
  });
}
