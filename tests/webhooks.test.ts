import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { runWebhookDispatchTick } from "@mas/db";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * Webhooks（plan M6 W13 / spec §19）：outbox + Standard Webhooks 签名 + 重试。
 * 用本地 http 接收端验证：签名可校验、失败重试退避、events 过滤、删除后停投。
 */

let env: TestEnv;
let url: string;
let key: string;

interface Received {
  headers: Record<string, string>;
  body: any;
}
let received: Received[] = [];
let respondWith: (req: Received) => number = () => 200;
let receiver: Server;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : String(v ?? "");
      const item: Received = { headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
      received.push(item);
      res.statusCode = respondWith(item);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

function receiverUrl(): string {
  const addr = receiver.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/hook`;
}

function verifySignature(r: Received, secret: string): boolean {
  const id = r.headers["webhook-id"];
  const ts = r.headers["webhook-timestamp"];
  const sig = r.headers["webhook-signature"];
  if (!id || !ts || !sig) return false;
  const body = JSON.stringify(r.body);
  const mac = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return sig === `v1,${mac}`;
}

async function tickUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await runWebhookDispatchTick(env.db.db);
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("tickUntil timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForDelivery(webhookId: string, predicate: (d: any) => boolean, timeoutMs = 15_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    await runWebhookDispatchTick(env.db.db);
    const list = await call(url, key, "GET", `/v1/webhooks/${webhookId}/deliveries?limit=200`);
    const hit = list.json.data.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForDelivery timeout; got ${JSON.stringify(list.json.data).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("Webhooks", () => {
  test("创建：secret 只回显一次；非法 url 400", async () => {
    const bad = await call(url, key, "POST", "/v1/webhooks", { url: "ftp://x" });
    expect(bad.status).toBe(400);
    const created = await call(url, key, "POST", "/v1/webhooks", { url: receiverUrl(), events: [] });
    expect(created.status).toBe(201);
    expect(created.json.secret).toMatch(/^whsec_/);
    // at-rest：落库的是信封密文，不是明文（偏差 #14 收尾）
    const row = await env.db.db
      .selectFrom("webhooks")
      .select(["secret"])
      .where("id", "=", created.json.id)
      .executeTakeFirst();
    expect(row?.secret.startsWith("{")).toBe(true);
    expect(row?.secret).not.toContain(created.json.secret);
    expect(() => JSON.parse(row?.secret ?? "")).not.toThrow(); // 合法 envelope JSON
    const listed = await call(url, key, "GET", "/v1/webhooks");
    expect(listed.json.data.some((w: any) => w.id === created.json.id)).toBe(true);
    expect(JSON.stringify(listed.json)).not.toContain(created.json.secret);
    await call(url, key, "DELETE", `/v1/webhooks/${created.json.id}`);
  });

  test("事件投递：签名可校验，payload 为事件内容", async () => {
    const created = await call(url, key, "POST", "/v1/webhooks", { url: receiverUrl() });
    const secret = created.json.secret;
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", { agent: agentId, environment_id: envId });
    const sid = session.json.id;
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi webhook" }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");

    await waitForDelivery(created.json.id, (d) => d.status === "delivered" && d.event_type === "agent.message");
    const delivered = received.filter((r) => r.body?.type === "agent.message");
    expect(delivered.length).toBeGreaterThan(0);
    for (const r of delivered.slice(-3)) {
      expect(verifySignature(r, secret)).toBe(true);
      expect(r.body.data?.content?.[0]?.type).toBe("text");
    }
    // outbox 状态可见
    const deliveries = await call(url, key, "GET", `/v1/webhooks/${created.json.id}/deliveries`);
    expect(deliveries.json.data.length).toBeGreaterThanOrEqual(2); // 至少 user.message 定序 + agent.message
    await call(url, key, "DELETE", `/v1/webhooks/${created.json.id}`);
  });

  test("失败重试：500 → attempts 递增、退避后重试成功 delivered", async () => {
    const created = await call(url, key, "POST", "/v1/webhooks", { url: receiverUrl() });
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "retry me" }] }],
    });
    const sid = session.json.id;
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");

    // 先全部 500，等到出现 attempts>=1 的 pending（退避 4s）
    let failCount = 0;
    respondWith = () => {
      failCount++;
      return 500;
    };
    const firstFail = await waitForDelivery(created.json.id, (d) => d.attempts >= 1 && d.status === "pending");
    expect(firstFail.last_status_code).toBe(500);
    const nextAt = new Date(firstFail.next_attempt_at).getTime();
    expect(nextAt).toBeGreaterThan(Date.now()); // 未到退避时间不再投

    // 退避后恢复 200 → delivered
    await new Promise((r) => setTimeout(r, Math.max(0, nextAt - Date.now()) + 50));
    respondWith = () => 200;
    const ok = await waitForDelivery(created.json.id, (d) => d.id === firstFail.id && d.status === "delivered", 20_000);
    expect(ok.attempts).toBeGreaterThanOrEqual(2);
    expect(failCount).toBeGreaterThanOrEqual(2);
    respondWith = () => 200;
    await call(url, key, "DELETE", `/v1/webhooks/${created.json.id}`);
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
  });

  test("events 过滤：只订阅 session.error 的事件不入 outbox", async () => {
    const created = await call(url, key, "POST", "/v1/webhooks", {
      url: receiverUrl(),
      events: ["session.error"],
    });
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", { agent: agentId, environment_id: envId });
    const sid = session.json.id;
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "filtered" }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
    await tickUntil(async () => true);
    const deliveries = await call(url, key, "GET", `/v1/webhooks/${created.json.id}/deliveries`);
    expect(deliveries.json.data.length).toBe(0); // 正常会话没有 session.error
    await call(url, key, "DELETE", `/v1/webhooks/${created.json.id}`);
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
  });

  test("删除后不再投递", async () => {
    const created = await call(url, key, "POST", "/v1/webhooks", { url: receiverUrl() });
    await call(url, key, "DELETE", `/v1/webhooks/${created.json.id}`);
    expect((await call(url, key, "GET", `/v1/webhooks/${created.json.id}`)).status).toBe(404);
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", { agent: agentId, environment_id: envId });
    const sid = session.json.id;
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "after delete" }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
    await tickUntil(async () => true);
    const none = received.filter((r) => r.body?.data?.content?.[0]?.text === "after delete");
    expect(none.length).toBe(0);
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
  });

  test("历史明文 secret 行兼容（信封升级前创建的 webhook 仍可投递）", async () => {
    const legacySecret = `whsec_${Buffer.from("legacy-raw-key-32-bytes-aaaaaaaaaa").toString("base64")}`;
    const wsRow = await env.db.db.selectFrom("workspaces").select(["id"]).limit(1).executeTakeFirst();
    const whkId = "whk_legacycompat01";
    await env.db.db
      .insertInto("webhooks")
      .values({
        id: whkId,
        workspace_id: wsRow!.id,
        url: receiverUrl(),
        events: JSON.stringify([]) as unknown as string[],
        secret: legacySecret, // 明文（升级前形态）
        description: null,
      })
      .execute();
    await env.db.db
      .insertInto("webhook_deliveries")
      .values({
        id: "whd_legacycompat01",
        workspace_id: wsRow!.id,
        webhook_id: whkId,
        event_id: "sevt_legacy_test",
        event_type: "test.legacy",
        payload: { hello: "legacy" },
      })
      .execute();
    await tickUntil(async () => {
      const d = await env.db.db
        .selectFrom("webhook_deliveries")
        .select(["status"])
        .where("id", "=", "whd_legacycompat01")
        .executeTakeFirst();
      return d?.status === "delivered";
    });
    const hit = received.find((r) => r.body?.id === "whd_legacycompat01");
    expect(hit).toBeTruthy();
    expect(verifySignature(hit!, legacySecret)).toBe(true);
    await env.db.db.deleteFrom("webhook_deliveries").where("id", "=", "whd_legacycompat01").execute();
    await env.db.db.deleteFrom("webhooks").where("id", "=", whkId).execute();
  });
});
