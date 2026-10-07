import { createServer as httpCreateServer, request as httpRequest } from "node:http";
import { createServer as tlsCreateServer, connect as tlsConnect } from "node:tls";
import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { call, makeAgentAndEnv, setupEnv, type TestEnv } from "./helpers.ts";
import { buildEgressApp } from "../apps/egress-proxy/src/app.ts";
import { loadOrCreateEgressCA, mintServerCert, resetEgressCertCacheForTest } from "@mas/egress";

/**
 * egress TLS 终止验收（spec §10.1：HTTPS 需要代理做 TLS 终止，按 SNI 签发证书，
 * 沙箱预置企业 CA）：CONNECT 隧道 → 代理终止 TLS（自建 CA 叶子证书）→
 * 同一套凭据/策略管线（占位符替换）→ 以真实 TLS 重新出站。
 */

let env: TestEnv;
let url: string;
let key: string;
let proxy: ReturnType<typeof buildEgressApp>;
let proxyPort: number;
let proxyCA: ReturnType<typeof loadOrCreateEgressCA>;
let originCA: ReturnType<typeof loadOrCreateEgressCA>;
let origin: ReturnType<typeof tlsCreateServer>;
let originPort: number;

const UPSTREAM_HOST = "egress-upstream.test";
const seenAuth: string[] = [];

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
  env.pauseWorker(); // 冻结 execution 状态，fence 可控

  // 上游：真实 HTTPS 服务（自签 originCA；代理以 CA 信任出站）
  originCA = loadOrCreateEgressCA({});
  const originLeaf = mintServerCert(originCA, UPSTREAM_HOST);
  const originHttp = httpCreateServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenAuth.push(String(req.headers.authorization ?? ""));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url, authorization: req.headers.authorization ?? null, body }));
    });
  });
  origin = tlsCreateServer({ cert: originLeaf.certPem, key: originLeaf.keyPem }, (s) => originHttp.emit("connection", s));
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;

  // 代理：企业 CA + 测试用上游解析/信任注入
  proxyCA = loadOrCreateEgressCA({});
  proxy = buildEgressApp({
    db: env.db.db,
    adminSecret: "test-admin-secret",
    ca: proxyCA,
    upstream: {
      ca: Buffer.from(originCA.caCertPem),
      portOverride: originPort,
      lookup: ((hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        // Node≥20 autoSelectFamily 会以 all:true 调用（期望 [{address,family}]），两种形态都答
        if (options?.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
        else cb(null, "127.0.0.1", 4);
      }) as never,
    },
  });
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await proxy.close().catch(() => undefined);
  await new Promise<void>((r) => origin.close(() => r()));
  resetEgressCertCacheForTest();
});

async function issueToken(scope: { workspaceId: string; sessionId: string; executionId: string; generation: number }) {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/internal/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-egress-admin": "test-admin-secret" },
    body: JSON.stringify(scope),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

/** CONNECT + 客户端 TLS（只信任代理的企业 CA）+ 隧道内 origin-form 请求。 */
function tunnelRequest(
  host: string,
  token: string,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
  body?: string,
): Promise<{ statusLine: string; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: `${host}:443`,
        headers: { host: `${host}:443`, "proxy-authorization": `Bearer ${token}` },
      },
    );
    req.on("connect", (res, socket) => {
      const statusLine = `${res.statusCode} ${res.statusMessage ?? ""}`.trim();
      const deniedHost = String(res.headers["x-mas-denied-host"] ?? "");
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ statusLine, headers: { "x-mas-denied-host": deniedHost }, body: "" });
        return;
      }
      const tls = tlsConnect({ socket, servername: host, ca: proxyCA.caCertPem, rejectUnauthorized: true }, () => {
        const lines = [
          `${method} ${path} HTTP/1.1`,
          `host: ${host}`,
          ...(body !== undefined ? [`content-length: ${Buffer.byteLength(body)}`] : []),
          ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
          "connection: close",
          "",
          "",
        ];
        tls.write(lines.join("\r\n") + (body ?? ""));
      });
      let raw = "";
      tls.on("data", (c) => (raw += c.toString("utf8")));
      tls.on("end", () => {
        const [head, ...rest] = raw.split("\r\n\r\n");
        const [line, ...headerLines] = (head ?? "").split("\r\n");
        const headers: Record<string, string> = {};
        for (const h of headerLines) {
          const i = h.indexOf(":");
          if (i > 0) headers[h.slice(0, i).toLowerCase()] = h.slice(i + 1).trim();
        }
        let body = rest.join("\r\n\r\n");
        if ((headers["transfer-encoding"] ?? "").includes("chunked")) {
          // 最小去块
          let out = "";
          let buf = body;
          for (;;) {
            const i = buf.indexOf("\r\n");
            if (i < 0) break;
            const size = parseInt(buf.slice(0, i), 16);
            if (!Number.isFinite(size) || size === 0) break;
            out += buf.slice(i + 2, i + 2 + size);
            buf = buf.slice(i + 2 + size + 2);
          }
          body = out;
        }
        resolve({ statusLine: (line ?? "").trim(), headers, body });
      });
      tls.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("TLS 终止证书（单元）", () => {
  test("叶子证书：SAN 命中主机、CA 签发链、按主机缓存", () => {
    resetEgressCertCacheForTest();
    const a = mintServerCert(proxyCA, "a.example.com");
    const a2 = mintServerCert(proxyCA, "a.example.com");
    expect(a.certPem).toBe(a2.certPem); // 缓存命中
    const x = new X509Certificate(a.certPem);
    expect(x.subjectAltName).toContain("DNS:a.example.com");
    expect(x.checkIssued(new X509Certificate(proxyCA.caCertPem))).toBe(true);
    const b = mintServerCert(proxyCA, "b.example.com");
    expect(b.certPem).not.toBe(a.certPem);
  });
});

describe("egress-proxy TLS 终止（集成）", () => {
  test("CONNECT 隧道：TLS 终止 + 占位符替换 + 真实 TLS 出站", async () => {
    const envRow = await call(url, key, "POST", "/v1/environments", {
      name: `egress-tls-env-${Date.now()}`,
      config: { type: "cloud", networking: { type: "limited", allowed_hosts: [UPSTREAM_HOST] } },
    });
    const vault = await call(url, key, "POST", "/v1/vaults", { display_name: `eg-tls-${Date.now()}` });
    await call(url, key, "POST", `/v1/vaults/${vault.json.id}/credentials`, {
      auth: {
        type: "environment_variable",
        secret_name: "EGRESS_TOKEN",
        secret_value: "real-tls-secret-ZQ43",
        networking: { type: "limited", allowed_hosts: [UPSTREAM_HOST] },
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
    const token = await issueToken({ workspaceId: exec!.workspace_id, sessionId: sid, executionId: exec!.id, generation: Number(exec!.generation) });

    const r = await tunnelRequest(UPSTREAM_HOST, token, "POST", "/v1/data", { authorization: "Bearer mas_ph_deadbeefcafe" }, '{"k":1}');
    expect(r.statusLine).toContain("200");
    const body = JSON.parse(r.body);
    expect(body.authorization).toBe("Bearer real-tls-secret-ZQ43"); // 代理替换，占位符未出站
    expect(body.path).toBe("/v1/data");
    expect(body.body).toBe('{"k":1}');
    expect(seenAuth.at(-1)).not.toContain("mas_ph_");
  }, 20_000);

  test("CONNECT 黑名单 → 403 + x-mas-denied-host（TLS 之前拒绝）", async () => {
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
    const r = await tunnelRequest("169.254.169.254", token, "GET", "/");
    expect(r.statusLine).toContain("403");
    expect(r.headers["x-mas-denied-host"]).toBe("169.254.169.254");
  });

  test("CA 分发端点（沙箱预置用）：管理密钥保护", async () => {
    const nope = await fetch(`http://127.0.0.1:${proxyPort}/internal/ca`);
    expect(nope.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${proxyPort}/internal/ca`, { headers: { "x-egress-admin": "test-admin-secret" } });
    expect(ok.status).toBe(200);
    const { cert } = (await ok.json()) as { cert: string };
    expect(cert).toContain("BEGIN CERTIFICATE");
    expect(cert).toBe(proxyCA.caCertPem);
  });
});
