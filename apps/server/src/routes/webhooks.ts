import type { FastifyInstance } from "fastify";
import { errInvalid } from "@mas/core";
import type { Kysely } from "kysely";
import type { Database, WebhookDeliverySel, WebhookSel } from "@mas/db";
import { createWebhook, deleteWebhook, getWebhook, listDeliveries } from "@mas/db";
import type { RouteCtx } from "./agents.js";
import { withIdempotency } from "../plugins/idempotent-route.js";

/**
 * Webhooks（plan M6 W13 / spec §19）：订阅会话事件 → outbox → Standard Webhooks 签名投递。
 * secret 只在创建时回显一次（whsec_...）；投递重试/状态经 /v1/webhooks/:id/deliveries 观察。
 */

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function webhookJson(w: WebhookSel) {
  return {
    id: w.id,
    type: "webhook",
    url: w.url,
    events: w.events ?? [],
    description: w.description,
    archived_at: w.archived_at ? iso(w.archived_at) : null,
    created_at: iso(w.created_at),
    updated_at: iso(w.updated_at),
  };
}

function deliveryJson(d: WebhookDeliverySel) {
  return {
    id: d.id,
    type: "webhook_delivery",
    webhook_id: d.webhook_id,
    event_id: d.event_id,
    event_type: d.event_type,
    status: d.status,
    attempts: d.attempts,
    last_status_code: d.last_status_code,
    last_error: d.last_error,
    delivered_at: d.delivered_at ? iso(d.delivered_at) : null,
    next_attempt_at: iso(d.next_attempt_at),
    created_at: iso(d.created_at),
  };
}

export function registerWebhookRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const db = ctx.db as unknown as Kysely<Database>;

  app.post("/v1/webhooks", async (req, reply) =>
    withIdempotency(db, req, reply, async () => {
      const body = (req.body ?? {}) as { url?: string; events?: string[]; description?: string | null };
      const ws = req.mas.auth!.workspaceId;
      if (!body.url || !/^https?:\/\//.test(body.url)) throw errInvalid("url must be an http(s) URL");
      if (body.events !== undefined && (!Array.isArray(body.events) || body.events.some((e) => typeof e !== "string"))) {
        throw errInvalid("events must be an array of event type strings");
      }
      const created = await createWebhook(db, {
        workspaceId: ws,
        url: body.url,
        events: body.events ?? [],
        description: body.description ?? null,
      });
      reply.code(201);
      return { ...webhookJson(created), secret: created.secret }; // 仅创建时回显
    }),
  );

  app.get("/v1/webhooks", async (req) => {
    const rows = await db
      .selectFrom("webhooks")
      .selectAll()
      .where("workspace_id", "=", req.mas.auth!.workspaceId)
      .where("archived_at", "is", null)
      .orderBy("created_at", "asc")
      .execute();
    return { data: rows.map(webhookJson), next_page: null };
  });

  app.get("/v1/webhooks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return webhookJson(await getWebhook(db, req.mas.auth!.workspaceId, id));
  });

  app.delete("/v1/webhooks/:id", async (req) => {
    const { id } = req.params as { id: string };
    await deleteWebhook(db, req.mas.auth!.workspaceId, id);
    return { id, type: "webhook_deleted" as const };
  });

  app.get("/v1/webhooks/:id/deliveries", async (req) => {
    const { id } = req.params as { id: string };
    await getWebhook(db, req.mas.auth!.workspaceId, id);
    const query = req.query as Record<string, string | string[]>;
    const limitRaw = query.limit !== undefined ? Number(query.limit) : 50;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
      throw errInvalid("limit must be between 1 and 200");
    }
    const status = typeof query.status === "string" ? query.status : undefined;
    if (status !== undefined && !["pending", "delivered", "failed"].includes(status)) {
      throw errInvalid("status must be pending, delivered or failed");
    }
    const rows = await listDeliveries(db, req.mas.auth!.workspaceId, { webhookId: id, status, limit: limitRaw });
    return { data: rows.map(deliveryJson), next_page: null };
  });
}
