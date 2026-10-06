import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { Client } from "pg";
import {
  errConflict,
  errInvalid,
  errNotFound,
  isEventType,
  newId,
  userInputEventSchema,
  type UserInputEvent,
} from "@mas/core";
import type { Database } from "@mas/db";
import { admitEvents, getSessionRow, listEvents, appendApiEvent } from "@mas/db";
import { beginIdempotent, finishIdempotent } from "../plugins/idempotency.js";
import { parseTimeFilter } from "@mas/core";
import type { RouteCtx } from "./agents.js";

/** POST events 的状态前置校验（spec §6 / §12.3；TOOL-07/08、EVT-S09）。 */
function checkBatchAgainstStatus(
  session: { status: string; stop_reason: Record<string, unknown> | null; archived_at: Date | null },
  events: UserInputEvent[],
): "user_message" | "tool_confirmation" | "interrupt" {
  if (session.archived_at) throw errConflict("session is archived");
  if (session.status === "terminated") throw errInvalid("session is terminated");
  const requiresAction = session.status === "idle" && session.stop_reason?.type === "requires_action";
  const hasMessage = events.some((e) => e.type === "user.message");
  const hasInterrupt = events.some((e) => e.type === "user.interrupt");
  const hasConfirmation = events.some((e) => e.type === "user.tool_confirmation");

  if (requiresAction) {
    if (hasMessage) throw errInvalid("session is awaiting a tool confirmation; user.message is not accepted now");
    if (hasInterrupt && hasConfirmation) throw errInvalid("cannot mix user.interrupt with other events");
    if (hasInterrupt) return "interrupt";
    return "tool_confirmation";
  }
  if (hasInterrupt && (hasMessage || hasConfirmation)) {
    throw errInvalid("cannot mix user.interrupt with other events");
  }
  if (hasInterrupt) return "interrupt";
  // 非 requires_action 下的 confirmation：404（tool_use 不存在）/ 409（存在但未在等待）由下方 resolution 校验决定（TOOL-10/11）
  return hasConfirmation ? "tool_confirmation" : "user_message";
}

export function registerEventRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  // ---- 发送事件（spec §7.3 准入：同一事务写排队事件 + execution）----
  app.post("/v1/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    // Idempotency-Key：同 key 同 body 回放首次响应（REC-07）
    const idem = await beginIdempotent(ctx.db, req);
    if (idem.replayed && idem.response) {
      reply.code(idem.response.status);
      return idem.response.body as Record<string, unknown>;
    }
    const body = req.body as { events?: unknown[] };
    if (!Array.isArray(body?.events)) throw errInvalid("body must be {events: [...]}");
    if (body.events.length < 1 || body.events.length > 10) {
      throw errInvalid("events must contain 1 to 10 events");
    }
    const events = body.events.map((e) => {
      const r = userInputEventSchema.safeParse(e);
      if (!r.success) throw errInvalid(`invalid event: ${r.error.issues[0]?.message ?? "schema mismatch"}`);
      return r.data;
    });

    const session = await getSessionRow(ctx.db, ws, id);
    const kind = checkBatchAgainstStatus(session, events);
    // requires_action 时的 interrupt：作废未决审批（TOOL-09）→ 生成 interrupt 执行
    const interruptExecution =
      kind === "interrupt" && session.stop_reason?.type === "requires_action";

    // tool_confirmation 的 resolution 校验（TOOL-10/11）
    const pendingIds = new Set(
      ((session.stop_reason as { event_ids?: string[] } | null)?.event_ids ?? []).map(String),
    );
    for (const e of events) {
      if (e.type !== "user.tool_confirmation") continue;
      const target = await ctx.db
        .selectFrom("session_events")
        .select(["id", "type"])
        .where("session_id", "=", id)
        .where("id", "=", e.tool_use_id)
        .executeTakeFirst();
      if (!target || target.type !== "agent.tool_use") {
        throw errNotFound(`tool_use ${e.tool_use_id} not found`);
      }
      if (!pendingIds.has(e.tool_use_id)) {
        throw errConflict(`tool_use ${e.tool_use_id} is not awaiting confirmation`);
      }
    }

    const rows = events.map((e) => ({
      id: newId("sevt"),
      type: e.type,
      payload: e as Record<string, unknown>,
    }));
    const admitted = await admitEvents(ctx.db, {
      sessionId: id,
      workspaceId: ws,
      events: rows,
      executionKind: interruptExecution ? "interrupt" : kind === "tool_confirmation" ? "tool_confirmation" : "user_message",
    });
    const out = { data: admitted.events };
    await finishIdempotent(ctx.db, req, { status: 200, body: out });
    return out;
  });

  // ---- 历史事件（spec §7.3 第 5 条）----
  app.get("/v1/sessions/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    await getSessionRow(ctx.db, ws, id);
    const query = req.query as Record<string, string | string[]>;
    const limitRaw = Number((query.limit as string) ?? 100);
    const limit = Math.min(Number.isNaN(limitRaw) ? 100 : Math.trunc(limitRaw), 100);
    if (limit < 1) throw errInvalid("limit must be >= 1");

    let types: string[] | undefined;
    if (query.types !== undefined) {
      const raw = Array.isArray(query.types) ? query.types : String(query.types).split(",");
      types = [...new Set(raw.flatMap((r) => r.split(",")).filter(Boolean))];
      for (const t of types) {
        if (!isEventType(t)) throw errInvalid(`unknown event type ${t}`);
      }
    }
    const order = query.order === "desc" ? "desc" : "asc";
    const timeFilter = parseTimeFilter(query);
    const afterSeq = query.after_seq !== undefined ? Number(query.after_seq) : undefined;

    const events = await listEvents(ctx.db, {
      sessionId: id,
      types,
      timeFilter,
      order,
      limit,
      afterSeq,
    });
    // 剔除内部字段
    const data = events.map((e) => {
      const { seq, ...rest } = e as { seq?: number };
      void seq;
      return rest;
    });
    const nextPage = events.length === limit ? Buffer.from(`{"k":"${events[events.length - 1]?.id}","d":"${order}"}`).toString("base64url") : null;
    return { data, next_page: nextPage };
  });

  // ---- SSE 实时流（spec §11.5）----
  app.get("/v1/sessions/:id/events/stream", { config: {} }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    await getSessionRow(ctx.db, ws, id);

    const query = req.query as Record<string, string>;
    // 白名单参数（EVT-R04）
    for (const key of Object.keys(query)) {
      if (!["after_seq", "event_deltas", "beta", "types", "limit"].includes(key)) {
        throw errInvalid(`query parameter ${key} is not allowed on the stream endpoint`);
      }
    }
    if (query.types !== undefined || query.limit !== undefined) {
      throw errInvalid("types/limit are not allowed on the stream endpoint");
    }
    if (query.beta !== undefined && query.beta !== "true") throw errInvalid("beta must be true");
    if (query.event_deltas !== undefined) {
      for (const d of query.event_deltas.split(",")) {
        if (!["agent.message", "agent.thinking"].includes(d)) throw errInvalid(`invalid event_deltas value ${d}`);
      }
    }

    const lastEventId = req.headers["last-event-id"];
    let afterSeq: number;
    if (typeof lastEventId === "string" && lastEventId) {
      afterSeq = Number(lastEventId);
      if (Number.isNaN(afterSeq)) throw errInvalid("invalid Last-Event-ID");
    } else if (query.after_seq !== undefined) {
      afterSeq = Number(query.after_seq);
      if (Number.isNaN(afterSeq)) throw errInvalid("invalid after_seq");
    } else {
      // 默认只推实时事件（EVT-R02）：从当前最大 seq 起步，不回放历史
      const maxRow = await sql`SELECT COALESCE(MAX(seq), 0) AS m FROM session_events WHERE session_id = ${id}`.execute(ctx.db);
      afterSeq = Number((maxRow.rows[0] as { m: string | number }).m ?? 0);
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (chunk: string) => raw.write(chunk);
    const sendEvent = (seq: number | null, type: string, data: unknown) => {
      write(`id: ${seq ?? ""}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const connStr = process.env.DATABASE_URL ?? "postgres://mas@localhost:5433/mas_dev";
    const client = new Client({ connectionString: connStr });
    await client.connect();
    let wake: (() => void) | null = null;
    await client.query(`LISTEN "session:${id}"`);
    client.on("notification", (msg) => {
      if (msg.payload === "deleted") {
        // 删除会话：行已被物理删除，推送合成帧后关闭（spec §11.5）
        write(`event: session.deleted\ndata: ${JSON.stringify({ id, type: "session.deleted" })}\n\n`);
        raw.end();
        void client.end().catch(() => undefined);
        return;
      }
      wake?.();
    });
    client.on("error", () => raw.end());

    const metrics = (app as unknown as { masMetrics?: { sseConnections: number } }).masMetrics ?? null;
    if (metrics) metrics.sseConnections += 1;
    req.raw.on("close", () => {
      if (metrics) metrics.sseConnections -= 1;
      void client.end().catch(() => undefined);
    });

    // 先 LISTEN 再回补，再按 seq 去重（避免空窗，spec §11.5）
    let lastSentSeq = afterSeq;
    let closed = false;
    const pump = async () => {
      while (!closed && !raw.writableEnded) {
        const events = await listEvents(ctx.db, { sessionId: id, afterSeq: lastSentSeq, limit: 100 });
        for (const e of events) {
          const seq = (e as { seq?: number }).seq;
          if (seq === null || seq === undefined) continue;
          if (seq <= lastSentSeq) continue;
          lastSentSeq = seq;
          sendEvent(seq, e.type, e);
        }
        // 等 NOTIFY 或心跳超时
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            write(": ping\n\n"); // 15 秒心跳
            resolve();
          }, 15_000);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }
    };
    void pump().catch(() => {
      if (!closed && !raw.writableEnded) raw.end();
    });
    await new Promise<void>((resolve) => raw.on("close", () => resolve()));
  });
}
