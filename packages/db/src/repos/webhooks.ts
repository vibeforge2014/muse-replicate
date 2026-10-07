import { createHmac, randomBytes } from "node:crypto";
import { type Kysely, type Selectable } from "kysely";
import { errNotFound, newId, openSecret, sealSecret } from "@mas/core";
import type { Database } from "../schema.js";
import type { WebhookDeliveryRow, WebhookRow } from "../schema.js";

/**
 * Webhooks（plan M6 W13 / spec §19）：outbox + Standard Webhooks 签名 + 指数退避重试。
 * - 投递事件源：session_events 定序/写入路径（appendEvent / appendApiEvent）调用 enqueue；
 * - 签名：webhook-id / webhook-timestamp / webhook-signature: v1,<base64(HMAC-SHA256(key, "id.ts.body"))>；
 *   secret 为 `whsec_` + base64(32B)，创建时回显一次；
 * - at-rest：secret 以 MAS_MASTER_KEY 信封加密存储（与 credential 同一 sealSecret），
 *   仅投递签名时在内存解密；历史明文行兼容（按 `{` 前缀识别）；
 * - 重试：非 2xx / 网络错误 → attempts+1，backoff = 2^attempts 秒；attempts ≥ 6 → failed。
 */

export const WEBHOOK_MAX_ATTEMPTS = 6;
const WEBHOOK_TIMEOUT_MS = 10_000;

export type WebhookSel = Selectable<WebhookRow>;
export type WebhookDeliverySel = Selectable<WebhookDeliveryRow>;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/** 存储态 → 签名用明文（历史明文行兼容）。 */
export function unwrapWebhookSecret(stored: string): string {
  return stored.startsWith("{") ? openSecret(stored) : stored;
}

export async function createWebhook(
  db: Kysely<Database>,
  args: { workspaceId: string; url: string; events: string[]; description: string | null },
): Promise<WebhookSel> {
  const secret = newWebhookSecret();
  const row = (
    await db
      .insertInto("webhooks")
      .values({
        id: newId("whk"),
        workspace_id: args.workspaceId,
        url: args.url,
        // node-pg 会把 JS 数组转成 PG 数组字面量，jsonb 列必须显式 stringify
        events: JSON.stringify(args.events) as unknown as string[],
        secret: sealSecret(secret),
        description: args.description,
      })
      .returningAll()
      .executeTakeFirst()
  )!;
  // 返回行上的 secret 用明文覆盖：创建响应一次性回显（落库的是信封密文）
  return { ...row, secret };
}

export async function getWebhook(db: Kysely<Database>, workspaceId: string, id: string): Promise<WebhookSel> {
  const row = await db
    .selectFrom("webhooks")
    .selectAll()
    .where("id", "=", id)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw errNotFound(`webhook ${id} not found`);
  return row;
}

export async function deleteWebhook(db: Kysely<Database>, workspaceId: string, id: string): Promise<void> {
  await getWebhook(db, workspaceId, id);
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("webhook_deliveries").where("webhook_id", "=", id).execute();
    await tx.deleteFrom("webhooks").where("id", "=", id).execute();
  });
}

/** 事件写入路径调用：按订阅过滤入 outbox（无订阅者时一次 join 查询即返回）。 */
export async function enqueueWebhookDeliveries(
  db: Kysely<Database>,
  args: { sessionId: string; eventId: string; eventType: string; payload: Record<string, unknown> },
): Promise<void> {
  const hooks = await db
    .selectFrom("webhooks")
    .innerJoin("sessions", (join) => join.onRef("sessions.workspace_id", "=", "webhooks.workspace_id"))
    .select(["webhooks.id", "webhooks.events"])
    .where("sessions.id", "=", args.sessionId)
    .where("webhooks.archived_at", "is", null)
    .execute();
  const matched = hooks.filter((h) => {
    const events = (h.events ?? []) as string[];
    return events.length === 0 || events.includes(args.eventType);
  });
  if (matched.length === 0) return;
  const rows = matched.map((h) => ({
    id: newId("whd"),
    workspace_id: "",
    webhook_id: h.id,
    event_id: args.eventId,
    event_type: args.eventType,
    payload: args.payload,
  }));
  // workspace_id 从会话补齐（避免再查一次）
  const ws = await db
    .selectFrom("sessions")
    .select(["workspace_id"])
    .where("id", "=", args.sessionId)
    .executeTakeFirst();
  if (!ws) return;
  for (const r of rows) r.workspace_id = ws.workspace_id;
  await db.insertInto("webhook_deliveries").values(rows).execute();
}

/** Standard Webhooks v1 签名：base64(HMAC-SHA256(base64decode(secret), `${id}.${ts}.${body}`))。 */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

async function deliverOne(
  db: Kysely<Database>,
  d: { id: string; event_type: string; payload: Record<string, unknown>; created_at: Date | string; attempts: number },
  url: string,
  secret: string,
): Promise<void> {
  const body = JSON.stringify({
    id: d.id,
    type: d.event_type,
    timestamp: new Date(d.created_at).toISOString(),
    data: d.payload,
  });
  const ts = Math.floor(Date.now() / 1000);
  const signature = signWebhook(secret, d.id, ts, body);
  let statusCode: number | null = null;
  let errorText: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": d.id,
        "webhook-timestamp": String(ts),
        "webhook-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    statusCode = res.status;
    if (!res.ok) errorText = `http ${res.status}`;
  } catch (e) {
    errorText = String((e as Error)?.message ?? e).slice(0, 200);
  }
  const attempts = d.attempts + 1;
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    await db
      .updateTable("webhook_deliveries")
      .set({ status: "delivered", attempts, delivered_at: new Date(), last_status_code: statusCode, last_error: null })
      .where("id", "=", d.id)
      .execute();
    return;
  }
  const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
  await db
    .updateTable("webhook_deliveries")
    .set({
      status: exhausted ? "failed" : "pending",
      attempts,
      last_status_code: statusCode,
      last_error: errorText,
      next_attempt_at: new Date(Date.now() + Math.pow(2, attempts) * 1000),
    })
    .where("id", "=", d.id)
    .execute();
}

/** 分发 tick（幂等）：到期 pending ≤10 条逐条 POST。 */
export async function runWebhookDispatchTick(db: Kysely<Database>): Promise<void> {
  const due = await db
    .selectFrom("webhook_deliveries")
    .innerJoin("webhooks", (join) => join.onRef("webhooks.id", "=", "webhook_deliveries.webhook_id"))
    .selectAll(["webhook_deliveries"])
    .select(["webhooks.url", "webhooks.secret"])
    .where("webhook_deliveries.status", "=", "pending")
    .where("webhook_deliveries.next_attempt_at", "<=", new Date())
    .limit(10)
    .execute();
  for (const d of due) {
    await deliverOne(db, d, d.url, unwrapWebhookSecret(d.secret));
  }
}

export function startWebhookScheduler(
  db: Kysely<Database>,
  intervalMs = Number(process.env.MAS_WEBHOOK_TICK_MS ?? 1000),
): () => void {
  const timer = setInterval(() => {
    void runWebhookDispatchTick(db).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function listDeliveries(
  db: Kysely<Database>,
  workspaceId: string,
  filters: { webhookId?: string; status?: string; limit: number },
): Promise<WebhookDeliverySel[]> {
  return db
    .selectFrom("webhook_deliveries")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .$if(filters.webhookId !== undefined, (q) => q.where("webhook_id", "=", filters.webhookId!))
    .$if(filters.status !== undefined, (q) => q.where("status", "=", filters.status!))
    .orderBy("created_at", "desc")
    .limit(filters.limit)
    .execute();
}
