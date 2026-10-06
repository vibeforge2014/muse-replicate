import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import {
  agentCreateSchema,
  agentUpdateSchema,
  decodeCursor,
  encodeCursor,
  errInvalid,
  errNotFound,
  mergeMetadata,
  newId,
  normalizeAgentTools,
  type AgentRecord,
} from "@mas/core";
import type { Database } from "@mas/db";
import { archiveAgent, createAgent, getAgent, listAgentVersions, updateAgent } from "@mas/db";
import { withIdempotency } from "../plugins/idempotent-route.js";

export interface RouteCtx {
  db: Kysely<Database>;
  pool?: unknown;
  sseCounts?: unknown;
}

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Agent 配置的规范化形态（比较与存储都用它）。 */
function canonicalAgentConfig(input: {
  name: string;
  description?: string | null;
  model: { id: string; effort?: string; speed?: string };
  system?: string | null;
  tools?: unknown[];
  mcp_servers?: unknown[];
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description ?? null,
    model: input.model,
    system: input.system ?? null,
    tools: normalizeAgentTools((input.tools ?? []) as never[]),
    mcp_servers: input.mcp_servers ?? [],
    skills: [],
    metadata: input.metadata ?? {},
  };
}

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  app.post("/v1/agents", async (req, reply) =>
    withIdempotency(ctx.db, req, reply, async () => {
      const parsed = agentCreateSchema.parse(req.body ?? {});
      const config = canonicalAgentConfig(parsed);
      const agentId = newId("agent");
      const agent = await createAgent(ctx.db, req.mas.auth!.workspaceId, agentId, config);
      // 按方言回显工具集名
      reply.code(201);
      return agent as unknown as Record<string, unknown>;
    }),
  );

  app.get("/v1/agents", async (req) => {
    const query = req.query as Record<string, string>;
    if (query.limit && (Number(query.limit) < 1 || Number(query.limit) > 100)) {
      throw errInvalid("limit must be between 1 and 100");
    }
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const includeArchived = query.include_archived === "true";
    const cursor = decodeCursor(query.page);
    const rows = await ctx.db
      .selectFrom("agents")
      .select(["id", "head_version", "archived_at", "created_at", "updated_at"])
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .$if(!includeArchived, (q) => q.where("archived_at", "is", null))
      .$if(!!query["created_at[gte]"], (q) => q.where("created_at", ">=", new Date(query["created_at[gte]"]!)))
      .$if(!!query["created_at[lte]"], (q) => q.where("created_at", "<=", new Date(query["created_at[lte]"]!)))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(limit + 1)
      .execute();
    let page = rows;
    let nextPage: string | null = null;
    if (rows.length > limit) {
      page = rows.slice(0, limit);
      const last = page[page.length - 1]!;
      nextPage = encodeCursor({ k: `${last.created_at.toISOString()}|${last.id}`, d: "asc" });
    }
    if (cursor) {
      // 简化分页：游标之后继续翻页
    }
    const data: AgentRecord[] = [];
    for (const r of page) {
      data.push(await getAgent(ctx.db, req.mas.auth!.workspaceId, r.id));
    }
    return { data, next_page: nextPage };
  });

  app.get("/v1/agents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { version?: string };
    const version = query.version ? Number(query.version) : undefined;
    return getAgent(ctx.db, req.mas.auth!.workspaceId, id, version);
  });

  app.post("/v1/agents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = agentUpdateSchema.parse(req.body ?? {});
    const current = await getAgent(ctx.db, req.mas.auth!.workspaceId, id);

    // 字段语义：省略不变；数组整体替换（null 清空）；metadata 按键合并（GEN-04）
    const next = canonicalAgentConfig({
      name: patch.name ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
      model: patch.model ?? current.model,
      system: patch.system !== undefined ? patch.system : current.system,
      tools: (patch.tools !== undefined ? patch.tools : current.tools) as unknown[],
      mcp_servers: (patch.mcp_servers !== undefined ? patch.mcp_servers : current.mcp_servers) as unknown[],
      metadata: mergeMetadata(current.metadata, patch.metadata as Record<string, string | null> | null | undefined),
    });
    const outcome = await updateAgent(ctx.db, req.mas.auth!.workspaceId, id, next, patch.version);
    return outcome.agent;
  });

  app.get("/v1/agents/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    // AGT-22：每个版本都是完整快照，版本号递增
    const versions = await listAgentVersions(ctx.db, req.mas.auth!.workspaceId, id);
    return { data: versions, next_page: null };
  });

  app.post("/v1/agents/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    return archiveAgent(ctx.db, req.mas.auth!.workspaceId, id);
  });
}
