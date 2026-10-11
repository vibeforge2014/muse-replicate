import { createServer, request as httpRequest, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";
import { buildEgressApp } from "../apps/egress-proxy/src/app.ts";
import { egressEnvForSandbox, loadOrCreateEgressCA, parseProxyAuthorization } from "@mas/egress";
import { fakeCodexHome } from "@mas/db";
import { FakeSandboxProvider } from "@mas/sandbox";
import { FakeCodexDriver } from "@mas/runtime";
import { SessionRunner } from "../apps/worker/src/session-runner.ts";

/**
 * egress 生命周期接线验收（spec §10.4）：claim → prepare → create（网络策略）→
 * attach（HTTP(S)_PROXY + 企业 CA 写入沙箱）→ revoke。
 * token 经 env userinfo（Basic 形态）与显式 Bearer 头都能通过代理。
 */

let env: TestEnv;
let url: string;
let key: string;
let proxy: ReturnType<typeof buildEgressApp>;
let proxyPort: number;
let proxyCA: ReturnType<typeof loadOrCreateEgressCA>;
let echo: Server;
let echoPort: number;
let runner: SessionRunner;
let provider: FakeSandboxProvider;

const seenAuth: string[] = [];

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
  env.pauseWorker(); // 手动驱动 worker，控制 attach 时点

  echo = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as AddressInfo).port;

  proxyCA = loadOrCreateEgressCA({});
  proxy = buildEgressApp({ db: env.db.db, adminSecret: "test-admin-secret", ca: proxyCA });
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;

  // worker 侧接线（MAS_EGRESS_URL 在 SessionRunner 构造时读取）
  process.env.MAS_EGRESS_URL = `http://127.0.0.1:${proxyPort}`;
  process.env.MAS_EGRESS_ADMIN = "test-admin-secret";
  provider = new FakeSandboxProvider("gvisor");
  runner = new SessionRunner(env.db.db, new FakeCodexDriver(), "worker_egress_attach", undefined, provider);
});

afterAll(async () => {
  delete process.env.MAS_EGRESS_URL;
  delete process.env.MAS_EGRESS_ADMIN;
  await runner.dispose().catch(() => undefined);
  await proxy.close().catch(() => undefined);
  await new Promise<void>((r) => echo.close(() => r()));
});

function proxyGet(target: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: target, headers: { host: u.host, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function driveTurn(sid: string): Promise<void> {
  await runner.processSession(sid);
  await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
}

describe("egress 生命周期（prepare → attach → revoke）", () => {
  test("attach：沙箱 env 带 token 代理 + 企业 CA 落会话 home，binding 真实可用", async () => {
    // limited 网络 + environment_variable 凭据（allowed: 127.0.0.1）
    const envRow = await call(url, key, "POST", "/v1/environments", {
      name: `attach-env-${Date.now()}`,
      config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["127.0.0.1"] } },
    });
    const vault = await call(url, key, "POST", "/v1/vaults", { display_name: `attach-${Date.now()}` });
    await call(url, key, "POST", `/v1/vaults/${vault.json.id}/credentials`, {
      auth: {
        type: "environment_variable",
        secret_name: "EGRESS_TOKEN",
        secret_value: "real-attach-secret-ZQ44",
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
    await driveTurn(sid);

    // 1) attach 落盘：沙箱 spec 的 env 与 CA 文件
    const spec = provider.lastSpecs.at(-1)!;
    expect(spec.sessionId).toBe(sid);
    expect(spec.env?.HTTP_PROXY).toContain(`http://`);
    expect(spec.env?.HTTP_PROXY).toContain("@127.0.0.1:");
    expect(spec.env?.SSL_CERT_FILE).toBeTruthy();
    const caFile = join(fakeCodexHome(sid), "egress-ca.crt");
    expect(existsSync(caFile)).toBe(true);
    expect(readFileSync(caFile, "utf8")).toContain("BEGIN CERTIFICATE");
    expect(readFileSync(caFile, "utf8")).toBe(proxyCA.caCertPem);

    // 2) binding 可用：env userinfo 里的 token 走代理 → 占位符被替换
    const token = new URL(spec.env!.HTTP_PROXY).username; // userinfo 编码的 token
    const r = await proxyGet(`http://127.0.0.1:${echoPort}/ping`, {
      "proxy-authorization": `Bearer ${decodeURIComponent(token)}`,
      authorization: "Bearer mas_ph_attach",
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).authorization).toBe("Bearer real-attach-secret-ZQ44");
  }, 30_000);

  test("Basic userinfo 形态（标准客户端从 HTTP_PROXY 自动编码）同样通过", async () => {
    const spec = provider.lastSpecs.at(-1)!;
    const token = decodeURIComponent(new URL(spec.env!.HTTP_PROXY).username);
    const basic = Buffer.from(`${token}:`).toString("base64");
    const r = await proxyGet(`http://127.0.0.1:${echoPort}/ping`, { "proxy-authorization": `Basic ${basic}` });
    expect(r.status).toBe(200);
  });

  test("revoke（dispose）：撤销后同 token 立即 403", async () => {
    const spec = provider.lastSpecs.at(-1)!;
    const token = decodeURIComponent(new URL(spec.env!.HTTP_PROXY).username);
    await runner.dispose();
    const r = await proxyGet(`http://127.0.0.1:${echoPort}/ping`, {
      "proxy-authorization": `Bearer ${token}`,
    });
    expect(r.status).toBe(403);
  });
});

describe("attach 辅助（单元）", () => {
  test("egressEnvForSandbox：userinfo 编码、NO_PROXY 内网段、CA 三家变量", () => {
    const env2 = egressEnvForSandbox({ proxyUrl: "http://mas-egress:8089/", token: "maseg_v1.abc.def", caPath: "/session/.codex/egress-ca.crt" });
    expect(env2.HTTP_PROXY).toBe("http://maseg_v1.abc.def@mas-egress:8089");
    expect(env2.https_proxy).toBe(env2.HTTP_PROXY);
    expect(env2.NO_PROXY).toContain(".cluster.local");
    expect(env2.SSL_CERT_FILE).toBe("/session/.codex/egress-ca.crt");
    expect(env2.NODE_EXTRA_CA_CERTS).toBe(env2.SSL_CERT_FILE);
  });

  test("parseProxyAuthorization：Bearer / Basic(<token>[:…]) / 垃圾", () => {
    expect(parseProxyAuthorization("Bearer maseg_v1.x.y")).toBe("maseg_v1.x.y");
    expect(parseProxyAuthorization(`Basic ${Buffer.from("maseg_v1.x.y:").toString("base64")}`)).toBe("maseg_v1.x.y");
    expect(parseProxyAuthorization(`Basic ${Buffer.from("maseg_v1.x.y:pw").toString("base64")}`)).toBe("maseg_v1.x.y");
    expect(parseProxyAuthorization("Basic !!!not-base64!!!")).toBeNull();
    expect(parseProxyAuthorization("Digest xyz")).toBeNull();
    expect(parseProxyAuthorization("")).toBeNull();
  });
});


