import type { FastifyInstance } from "fastify";
import { encodeCursor, errInvalid, newId } from "@mas/core";
import {
  environmentCreateSchema,
  environmentUpdateSchema,
  normalizeEnvironmentConfig,
} from "@mas/core";
import type { Database } from "@mas/db";
import { withIdempotency } from "../plugins/idempotent-route.js";
import {
  archiveEnvironment,
  createEnvironment,
  deleteEnvironment,
  getEnvironmentRow,
  updateEnvironmentRow,
  environmentRowToJson,
} from "@mas/db";
import type { RouteCtx } from "./agents.js";

export function registerEnvironmentRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  // 创建返回 200（与 BigModel 一致，spec §11.3）
  app.post("/v1/environments", async (req, reply) =>
    withIdempotency(ctx.db, req, reply, async () => {
    const parsed = environmentCreateSchema.parse(req.body ?? {});
    const config = normalizeEnvironmentConfig(parsed.config);
    return (await createEnvironment(ctx.db, {
      id: newId("env"),
      workspace_id: req.mas.auth!.workspaceId,
      name: parsed.name,
      description: parsed.description ?? null,
      config: config as unknown as Record<string, unknown>,
      metadata: parsed.metadata ?? {},
      archived_at: null,
    })) as unknown as Record<string, unknown>;
    }),
  );

  app.get("/v1/environments", async (req) => {
    const query = req.query as Record<string, string>;
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const includeArchived = query.include_archived === "true";
    const rows = await ctx.db
      .selectFrom("environments")
      .selectAll()
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .$if(!includeArchived, (q) => q.where("archived_at", "is", null))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const nextPage =
      rows.length > limit
        ? encodeCursor({ k: `${page[page.length - 1]!.created_at.toISOString()}|${page[page.length - 1]!.id}`, d: "asc" })
        : null;
    return { data: page.map(environmentRowToJson), next_page: nextPage };
  });

  app.get("/v1/environments/:id", async (req) => {
    const { id } = req.params as { id: string };
    return environmentRowToJson(await getEnvironmentRow(ctx.db, req.mas.auth!.workspaceId, id));
  });

  // 更新：config 整体替换（不传 packages 时被清空）；metadata 按键合并（ENV-09）
  app.post("/v1/environments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = environmentUpdateSchema.parse(req.body ?? {});
    if (patch.name === null) throw errInvalid("name cannot be set to null");
    const current = await getEnvironmentRow(ctx.db, req.mas.auth!.workspaceId, id);
    let config: Record<string, unknown> | undefined;
    if (patch.config !== undefined) {
      if (patch.config === null) throw errInvalid("config cannot be set to null");
      config = normalizeEnvironmentConfig(patch.config) as unknown as Record<string, unknown>;
    }
    let metadata: Record<string, string> | undefined;
    if (patch.metadata !== undefined) {
      if (patch.metadata === null) metadata = {};
      else {
        const merged = { ...current.metadata };
        for (const [k, v] of Object.entries(patch.metadata)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        metadata = merged;
      }
    }
    return updateEnvironmentRow(ctx.db, req.mas.auth!.workspaceId, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  });

  app.post("/v1/environments/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    return archiveEnvironment(ctx.db, req.mas.auth!.workspaceId, id);
  });

  app.delete("/v1/environments/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deleteEnvironment(ctx.db, req.mas.auth!.workspaceId, id);
  });
}
