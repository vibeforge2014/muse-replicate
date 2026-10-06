import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { fakeCodexHome } from "@mas/db";
import { internalTokenOk } from "../plugins/metrics.js";
import type { RouteCtx } from "./agents.js";

/**
 * 管理员调试接口（spec §16 / M5 5.4）：`GET /internal/sessions/:id/debug`。
 * 内部事件、runtime/沙箱状态、checkpoint/output manifest、fake 沙箱目录统计。
 * 鉴权：设置 `MAS_INTERNAL_TOKEN` 时要求 `x-internal-token`；未配置时仅限开发形态开放。
 */
export function registerInternalRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  app.get("/internal/sessions/:id/debug", async (req, reply) => {
    if (!internalTokenOk(req)) {
      reply.code(404);
      return { error: "not found" };
    }
    const { id } = req.params as { id: string };
    const session = await ctx.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!session) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }

    const internalEvents = await ctx.db
      .selectFrom("session_internal_events")
      .select(["type", "payload", "created_at"])
      .where("session_id", "=", id)
      .orderBy("id", "desc")
      .limit(100)
      .execute();

    const executions = await ctx.db
      .selectFrom("session_executions")
      .select(["id", "kind", "state", "generation", "attempt_count", "admitted_at", "settled_at", "failure"])
      .where("session_id", "=", id)
      .orderBy("admitted_at", "desc")
      .limit(20)
      .execute();

    const checkpoints = await ctx.db
      .selectFrom("workspace_checkpoints")
      .select(["checkpoint_id", "state", "created_at"])
      .where("session_id", "=", id)
      .orderBy("created_at", "desc")
      .limit(10)
      .execute();

    const outputFiles = await ctx.db
      .selectFrom("files")
      .select(["id", "filename", "sha256", "size"])
      .where("scope_type", "=", "session")
      .where("scope_id", "=", id)
      .execute();

    // fake 沙箱目录统计（真实部署换成 provider.stats()）
    const home = fakeCodexHome(id);
    const sandbox: Record<string, unknown> = { home, exists: existsSync(home) };
    if (sandbox.exists) {
      const entries = readdirSync(home).map((name) => {
        const st = statSync(join(home, name));
        return { name, type: st.isDirectory() ? "dir" : "file", size: st.size };
      });
      sandbox.entries = entries;
    }

    return {
      session: {
        id: session.id,
        status: session.status,
        stop_reason: session.stop_reason,
        sandbox_id: session.sandbox_id,
        codex_thread_id: session.codex_thread_id,
        codex_version_digest: session.codex_version_digest,
        last_completed_execution_id: session.last_completed_execution_id,
        active_workspace_checkpoint: session.active_workspace_checkpoint,
        active_output_manifest: session.active_output_manifest,
        last_event_seq: Number(session.last_event_seq),
      },
      internal_events: internalEvents.reverse(),
      executions,
      checkpoints,
      output_files: outputFiles,
      sandbox,
    };
  });
}
