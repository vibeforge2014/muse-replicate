import { beforeAll, afterEach, describe, expect, test } from "vitest";
import { call, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * M5：幂等全量（POST agents/environments/sessions/vaults/credentials）、
 * 指标端点、管理员 debug 接口。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

afterEach(() => {
  delete process.env.MAS_INTERNAL_TOKEN;
});

describe("M5 幂等全量", () => {
  test("agents 创建：同 key 同 body 回放同 id；异 body 409", async () => {
    const idem = `m5-agt-${Date.now()}`;
    const body = { name: `idem-agent-${Date.now()}`, model: { id: "glm-5.3-flash" } };
    const r1 = await call(url, key, "POST", "/v1/agents", body, { "idempotency-key": idem });
    expect(r1.status).toBe(201);
    const r2 = await call(url, key, "POST", "/v1/agents", body, { "idempotency-key": idem });
    expect(r2.status).toBe(201);
    expect(r2.json.id).toBe(r1.json.id);
    const r3 = await call(url, key, "POST", "/v1/agents", { ...body, name: "different" }, { "idempotency-key": idem });
    expect(r3.status).toBe(409);
    expect(r3.json.error?.type).toBe("idempotency_conflict");
  });

  test("environments / vaults / sessions 创建回放", async () => {
    const k1 = `m5-env-${Date.now()}`;
    const envBody = { name: `idem-env-${Date.now()}`, config: { type: "cloud" } };
    const e1 = await call(url, key, "POST", "/v1/environments", envBody, { "idempotency-key": k1 });
    const e2 = await call(url, key, "POST", "/v1/environments", envBody, { "idempotency-key": k1 });
    expect(e2.json.id).toBe(e1.json.id);

    const k2 = `m5-vlt-${Date.now()}`;
    const vltBody = { display_name: `idem-vault-${Date.now()}` };
    const v1 = await call(url, key, "POST", "/v1/vaults", vltBody, { "idempotency-key": k2 });
    const v2 = await call(url, key, "POST", "/v1/vaults", vltBody, { "idempotency-key": k2 });
    expect(v2.json.id).toBe(v1.json.id);

    const k3 = `m5-ses-${Date.now()}`;
    const agent = await call(url, key, "POST", "/v1/agents", { name: `a-${Date.now()}`, model: { id: "glm-5.3-flash" } });
    const sesBody = { agent: agent.json.id, environment_id: e1.json.id };
    const s1 = await call(url, key, "POST", "/v1/sessions", sesBody, { "idempotency-key": k3 });
    const s2 = await call(url, key, "POST", "/v1/sessions", sesBody, { "idempotency-key": k3 });
    expect(s2.json.id).toBe(s1.json.id);

    // 数据库里确实只有一个
    const rows = await env.db.db.selectFrom("sessions").select(["id"]).where("id", "=", s1.json.id).execute();
    expect(rows.length).toBe(1);
  });

  test("credential 创建回放（机密不因重放而重复登记）", async () => {
    const v = await call(url, key, "POST", "/v1/vaults", { display_name: `cv-${Date.now()}` });
    const k = `m5-cred-${Date.now()}`;
    const body = {
      auth: {
        type: "environment_variable",
        secret_name: "K_M5",
        secret_value: "m5-secret-value",
        networking: { type: "unrestricted" },
      },
    };
    const c1 = await call(url, key, "POST", `/v1/vaults/${v.json.id}/credentials`, body, { "idempotency-key": k });
    const c2 = await call(url, key, "POST", `/v1/vaults/${v.json.id}/credentials`, body, { "idempotency-key": k });
    expect(c2.json.id).toBe(c1.json.id);
    const rows = await env.db.db
      .selectFrom("credentials")
      .select(["id"])
      .where("vault_id", "=", v.json.id)
      .execute();
    expect(rows.length).toBe(1);
  });
});

describe("M5 可观测与调试", () => {
  test("GET /internal/metrics 输出 Prometheus 文本（含请求计数与会话 gauge）", async () => {
    // 先制造一些流量
    await call(url, key, "GET", "/v1/agents");
    const res = await fetch(`${url}/internal/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# TYPE mas_api_requests_total counter");
    expect(text).toContain('mas_api_requests_total{route="/v1/agents"');
    expect(text).toContain("# TYPE mas_sessions gauge");
    expect(text).toContain("mas_sse_connections");
  });

  test("metrics 受 MAS_INTERNAL_TOKEN 保护", async () => {
    process.env.MAS_INTERNAL_TOKEN = "ops-secret";
    const noToken = await fetch(`${url}/internal/metrics`);
    expect(noToken.status).toBe(404);
    const withToken = await fetch(`${url}/internal/metrics`, { headers: { "x-internal-token": "ops-secret" } });
    expect(withToken.status).toBe(200);
  });

  test("GET /internal/sessions/:id/debug：runtime/checkpoint/output/内部事件全景", async () => {
    const agent = await call(url, key, "POST", "/v1/agents", { name: `dbg-${Date.now()}`, model: { id: "glm-5.3-flash" } });
    const envr = await call(url, key, "POST", "/v1/environments", { name: `dbg-env-${Date.now()}`, config: { type: "cloud" } });
    const s = await call(url, key, "POST", "/v1/sessions", {
      agent: agent.json.id,
      environment_id: envr.json.id,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hello debug" }] }],
    });
    const sid = s.json.id;
    // 等轮真正跑完（fake 沙箱 home 目录随 runtime 启动创建）
    const start = Date.now();
    for (;;) {
      const es = (await call(url, key, "GET", `/v1/sessions/${sid}/events`)).json.data;
      if (es.some((e: any) => e.type === "agent.message")) break;
      if (Date.now() - start > 15_000) throw new Error("debug target turn not completed");
      await new Promise((r) => setTimeout(r, 150));
    }

    // 状态回 idle 晚于 agent.message 落库（checkpoint/settle 其后），慢盘宿主必须等状态而非等事件
    await waitFor(url, key, sid, (s: any) => s.status === "idle");

    const res = await fetch(`${url}/internal/sessions/${sid}/debug`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.session.id).toBe(sid);
    expect(j.session.status).toBe("idle");
    expect(Array.isArray(j.executions)).toBe(true);
    expect(j.sandbox.exists ?? j.sandbox).toBeTruthy();

    // token 保护生效
    process.env.MAS_INTERNAL_TOKEN = "ops-secret";
    const denied = await fetch(`${url}/internal/sessions/${sid}/debug`);
    expect(denied.status).toBe(404);
    const ok2 = await fetch(`${url}/internal/sessions/${sid}/debug`, { headers: { "x-internal-token": "ops-secret" } });
    expect(ok2.status).toBe(200);
  });
});
