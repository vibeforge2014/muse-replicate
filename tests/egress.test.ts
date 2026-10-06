import { createServer, request as httpRequest, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { call, makeAgentAndEnv, setupEnv, type TestEnv } from "./helpers.ts";
import { buildEgressApp } from "../apps/egress-proxy/src/app.ts";
import { hostMatches, isBlacklistedHost, isPlaceholder, issueEgressToken, verifyEgressToken } from "@mas/egress";

/**
 * egress-proxy 验收（spec §10.2/§10.4；VLT-07 的自建 echo 形态）：
 * token 校验、fence 时效、主机策略、占位符注入、拒绝事件与限频。
 */

let env: TestEnv;
let url: string;
let key: string;
let echo: Server;
let echoPort: number;
let proxy: ReturnType<typeof buildEgressApp>;
let proxyPort: number;

const seenAuth: string[] = [];

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
  env.pauseWorker(); // 冻结 execution 状态，fence 可控

  echo = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, path: req.url, authorization: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as AddressInfo).port;

  proxy = buildEgressApp({ db: env.db.db, adminSecret: "test-admin-secret" });
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await proxy.close().catch(() => undefined);
  await new Promise<void>((r) => echo.close(() => r()));
});

afterEach(() => {
  seenAuth.length = 0;
});

function proxyGet(target: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: target,
        headers: { host: u.host, ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function issueToken(scope: { workspaceId: string; sessionId: string; executionId: string; generation: number }) {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/internal/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-egress-admin": "test-admin-secret" },
    body: JSON.stringify(scope),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

describe("egress token（单元）", () => {
  test("签发/校验往返；篡改与过期拒绝", async () => {
    const binding = issueEgressToken({
      workspaceId: "ws_x", sessionId: "sesn_x", executionId: "exe_x",
      generation: 3, sandboxId: "sbx_x", ttlSeconds: 60,
    });
    const v = verifyEgressToken(binding.token);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.generation).toBe(3);

    expect(verifyEgressToken(binding.token + "x").ok).toBe(false);
    const expired = issueEgressToken({ workspaceId: "w", sessionId: "s", executionId: "e", generation: 1, sandboxId: "b", ttlSeconds: -1 });
    expect(verifyEgressToken(expired.token)).toMatchObject({ ok: false, error: "expired" });
    expect(verifyEgressToken("garbage")).toMatchObject({ ok: false, error: "malformed" });
  });

  test("host 通配与黑名单", () => {
    expect(hostMatches("*.example.com", "api.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(false);
    expect(hostMatches("api.example.com", "api.example.com")).toBe(true);
    expect(isBlacklistedHost("169.254.169.254")).toBe(true);
    expect(isBlacklistedHost("10.1.2.3")).toBe(true);
    expect(isBlacklistedHost("192.168.1.1")).toBe(true);
    expect(isBlacklistedHost("example.com")).toBe(false);
    expect(isPlaceholder("mas_ph_abc123")).toBe(true);
    expect(isPlaceholder("real-token")).toBe(false);
  });
});

describe("egress-proxy（集成）", () => {
  test("凭据命中：占位符在代理处替换为真实机密，上游收到真实值", async () => {
    // limited 网络 + environment_variable 凭据（allowed: 127.0.0.1）
    const envRow = await call(url, key, "POST", "/v1/environments", {
      name: `egress-env-${Date.now()}`,
      config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["127.0.0.1"] } },
    });
    const vault = await call(url, key, "POST", "/v1/vaults", { display_name: `eg-${Date.now()}` });
    await call(url, key, "POST", `/v1/vaults/${vault.json.id}/credentials`, {
      auth: {
        type: "environment_variable",
        secret_name: "EGRESS_TOKEN",
        secret_value: "real-secret-ZQ42",
        networking: { type: "limited", allowed_hosts: ["127.0.0.1"] },
      },
    });
    const { agentId } = await makeAgentAndEnv(url, key);
    const sesn = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envRow.json.id,
      vault_ids: [vault.json.id],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    const sid = sesn.json.id;
    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["id", "generation", "workspace_id"])
      .where("session_id", "=", sid)
      .executeTakeFirst();
    expect(exec).toBeTruthy();

    const token = await issueToken({ workspaceId: exec!.workspace_id, sessionId: sid, executionId: exec!.id, generation: Number(exec!.generation) });
    const r = await proxyGet(`http://127.0.0.1:${echoPort}/ping`, {
      "proxy-authorization": `Bearer ${token}`,
      authorization: "Bearer mas_ph_deadbeefcafe",
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.authorization).toBe("Bearer real-secret-ZQ42");
    // 占位符从未离开代理
    expect(seenAuth[0]).not.toContain("mas_ph_");
  });

  test("黑名单（元数据服务）→ 403 + x-mas-denied-host + session.error{egress_denied}（限频 1/分钟）", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sesn = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    const sid = sesn.json.id;
    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["id", "generation", "workspace_id"])
      .where("session_id", "=", sid)
      .executeTakeFirst();
    const token = await issueToken({ workspaceId: exec!.workspace_id, sessionId: sid, executionId: exec!.id, generation: Number(exec!.generation) });

    for (let i = 0; i < 2; i++) {
      const r = await proxyGet("http://169.254.169.254/latest/meta-data/", {
        "proxy-authorization": `Bearer ${token}`,
      });
      expect(r.status).toBe(403);
      expect(r.headers["x-mas-denied-host"]).toBe("169.254.169.254");
    }
    // 两次拒绝只落一条 session.error（同 host 每分钟一条）
    const events = (await call(url, key, "GET", `/v1/sessions/${sid}/events`)).json.data;
    const denied = events.filter((e: any) => e.type === "session.error" && e.error?.type === "egress_denied");
    expect(denied.length).toBe(1);
    expect(denied[0].error?.message).toContain("169.254.169.254");
  });

  test("limited 网络下未列主机 → 403；无凭据但端口 80 → 放行（502 证明过了策略）", async () => {
    const envRow = await call(url, key, "POST", "/v1/environments", {
      name: `lim-env-${Date.now()}`,
      config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["allowed.example.com"] } },
    });
    const { agentId } = await makeAgentAndEnv(url, key);
    const sesn = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envRow.json.id,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    const sid = sesn.json.id;
    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["id", "generation", "workspace_id"])
      .where("session_id", "=", sid)
      .executeTakeFirst();
    const token = await issueToken({ workspaceId: exec!.workspace_id, sessionId: sid, executionId: exec!.id, generation: Number(exec!.generation) });

    // 未列主机（回环但不在 allowed_hosts）
    const denied = await proxyGet(`http://127.0.0.1:${echoPort}/x`, { "proxy-authorization": `Bearer ${token}` });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("not_allowed_host");

    // unrestricted 会话：非标准端口拒绝、80 端口放行（上游不存在 → 502）
    const env2 = await call(url, key, "POST", "/v1/environments", {
      name: `unres-env-${Date.now()}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    const sesn2 = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: env2.json.id,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    const sid2 = sesn2.json.id;
    const exec2 = await env.db.db
      .selectFrom("session_executions")
      .select(["id", "generation", "workspace_id"])
      .where("session_id", "=", sid2)
      .executeTakeFirst();
    const token2 = await issueToken({ workspaceId: exec2!.workspace_id, sessionId: sid2, executionId: exec2!.id, generation: Number(exec2!.generation) });
    const nonStd = await proxyGet(`http://127.0.0.1:${echoPort}/y`, { "proxy-authorization": `Bearer ${token2}` });
    expect(nonStd.status).toBe(403);
    expect(nonStd.body).toContain("non_standard_port");
    const port80 = await proxyGet("http://127.0.0.1/none", { "proxy-authorization": `Bearer ${token2}` });
    // 策略放行：未被 403 拦截（本机 80 可能有服务 → 200，无服务 → 502）
    expect([200, 502]).toContain(port80.status);
  });

  test("坏 token / 旧 generation fence → 403", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sesn = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    const sid = sesn.json.id;
    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["id", "workspace_id"])
      .where("session_id", "=", sid)
      .executeTakeFirst();

    const bad = await proxyGet(`http://127.0.0.1:${echoPort}/z`, { "proxy-authorization": "Bearer garbage" });
    expect(bad.status).toBe(403);
    expect(bad.body).toContain("egress token");

    const staleToken = await issueToken({ workspaceId: exec!.workspace_id, sessionId: sid, executionId: exec!.id, generation: 99 });
    const stale = await proxyGet(`http://127.0.0.1:${echoPort}/z`, { "proxy-authorization": `Bearer ${staleToken}` });
    expect(stale.status).toBe(403);
    expect(stale.body).toContain("stale fence");
  });
});
