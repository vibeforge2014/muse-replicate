import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import type { Kysely } from "kysely";
import { openSecret } from "@mas/core";
import type { Database } from "@mas/db";
import { appendApiEvent } from "@mas/db";
import {
  evaluateEgressPolicy,
  hostMatches,
  isBlacklistedHost,
  issueEgressToken,
  verifyEgressToken,
  type EgressScope,
} from "@mas/egress";

/**
 * egress-proxy（spec §10.2/§10.4）：沙箱出站流量的强制点。
 * 沙箱 HTTP 客户端以 http_proxy 指向本服务；请求带 proxy-authorization: Bearer <出站 token>。
 * 每请求校验：token 签名/有效期 → fence（generation 仍当前，缓存 4s）→
 * 主机策略（黑名单/allowed_hosts/端口）→ 凭据命中则注入，否则按公共出网策略。
 * 被拒：403 + x-mas-denied-host + session.error{egress_denied}（同 host 每分钟至多一条）。
 * MVP：HTTP 绝对 URI 形态（无 CONNECT/TLS 终止——真实部署需镜像预置企业 CA，§10.1）。
 */

export interface EgressAppOptions {
  db: Kysely<Database>;
  /** 管理面密钥（签发 token 的内部端点用）。 */
  adminSecret?: string;
}

interface SessionEgressContext {
  workspaceId: string;
  envNetworking: { type: "unrestricted" | "limited"; allowed_hosts?: string[] } | undefined;
  credentials: {
    type: string;
    identityKey: string;
    secret: string;
    networking: { type?: string; allowed_hosts?: string[] };
  }[];
}

const FENCE_CACHE_TTL_MS = 4000; // < 5s 且短于租约（§10.4）

export function buildEgressApp(opts: EgressAppOptions): FastifyInstance {
  const app = Fastify({
    logger: process.env.MAS_LOG === "0" ? false : { level: process.env.MAS_LOG_LEVEL ?? "warn" },
    bodyLimit: 16 * 1024 * 1024,
  });
  // 任意 content-type 一律按原始 buffer 透传
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  const adminSecret = opts.adminSecret ?? process.env.MAS_EGRESS_SECRET ?? "mas-dev-egress-secret";
  const fenceCache = new Map<string, { ok: boolean; at: number }>();
  const deniedLogLimiter = new Map<string, number>(); // `${sessionId}|${host}` → last ts

  async function fenceStillCurrent(executionId: string, generation: number): Promise<boolean> {
    const key = `${executionId}|${generation}`;
    const hit = fenceCache.get(key);
    if (hit && Date.now() - hit.at < FENCE_CACHE_TTL_MS) return hit.ok;
    const row = await opts.db
      .selectFrom("session_executions")
      .select(["id", "generation", "state"])
      .where("id", "=", executionId)
      .executeTakeFirst();
    // pg 的 bigint 以字符串返回，统一数值比较
    const ok = !!row && Number(row.generation) === generation && row.state !== "failed";
    fenceCache.set(key, { ok, at: Date.now() });
    return ok;
  }

  async function loadSessionContext(sessionId: string): Promise<SessionEgressContext | null> {
    const session = await opts.db
      .selectFrom("sessions")
      .select(["workspace_id", "vault_ids", "environment_snapshot"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!session) return null;
    const envNetworking = (
      session.environment_snapshot as {
        config?: { networking?: { type: "unrestricted" | "limited"; allowed_hosts?: string[] } };
      }
    ).config?.networking;
    const credentials: SessionEgressContext["credentials"] = [];
    for (const vid of session.vault_ids) {
      const rows = await opts.db
        .selectFrom("credentials")
        .selectAll()
        .where("vault_id", "=", vid)
        .where("workspace_id", "=", session.workspace_id)
        .where("archived_at", "is", null)
        .execute();
      for (const r of rows) {
        credentials.push({
          type: r.type,
          identityKey: r.identity_key,
          secret: openSecret(r.secret_ciphertext),
          networking: (r.networking ?? {}) as { type?: string; allowed_hosts?: string[] },
        });
      }
    }
    return { workspaceId: session.workspace_id, envNetworking, credentials };
  }

  async function recordDenied(sessionId: string, host: string, reason: string): Promise<void> {
    const key = `${sessionId}|${host}`;
    const last = deniedLogLimiter.get(key) ?? 0;
    if (Date.now() - last < 60_000) return; // 同 host 每分钟至多一条（§10.2）
    deniedLogLimiter.set(key, Date.now());
    await appendApiEvent(opts.db, sessionId, "session.error", {
      error: { type: "egress_denied", message: `egress to ${host} denied (${reason})`, retry_status: "terminal" },
    }).catch(() => undefined);
  }

  // ---- 内部：签发出站授权 token（worker prepare 调用；管理密钥保护）----
  app.post("/internal/bindings", async (req, reply) => {
    const auth = req.headers["x-egress-admin"];
    if (auth !== adminSecret) {
      reply.code(403);
      return { error: "unauthorized" };
    }
    let body = req.body as Partial<EgressScope> | Buffer | undefined;
    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString("utf8")) as Partial<EgressScope>;
      } catch {
        body = undefined;
      }
    }
    const generation = Number(body?.generation);
    if (!body?.workspaceId || !body.sessionId || !body.executionId || !Number.isFinite(generation)) {
      reply.code(400);
      return { error: "scope required" };
    }
    return issueEgressToken({ ...body, generation } as EgressScope);
  });

  app.get("/healthz", async () => ({ ok: true }));

  // ---- 代理入口：绝对 URI 请求（http_proxy 客户端行为）----
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.originalUrl;
    if (!/^http:\/\//i.test(url)) {
      reply.code(404);
      return { error: "not found (only http absolute-URI proxying is supported)" };
    }
    const target = new URL(url);
    const host = target.hostname;
    const port = target.port ? Number(target.port) : 80;

    const token = String(req.headers["proxy-authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const verdict = verifyEgressToken(token);
    if (!verdict.ok) {
      reply.code(403);
      return { error: `egress token ${verdict.error}` };
    }
    const claims = verdict.claims;
    // 旧 generation / 已 failed 的 execution：立即拒绝（§10.4 第 2 条）
    if (!(await fenceStillCurrent(claims.executionId, claims.generation))) {
      reply.code(403);
      return { error: "stale fence" };
    }

    const ctx = await loadSessionContext(claims.sessionId);
    if (!ctx) {
      reply.code(403);
      return { error: "unknown session" };
    }

    // 1) 平台黑名单（元数据服务 / RFC1918）
    if (isBlacklistedHost(host)) {
      reply.header("x-mas-denied-host", host);
      await recordDenied(claims.sessionId, host, "blacklisted");
      reply.code(403);
      return { error: "host denied" };
    }

    // 重建转发头：剥离逐跳与代理凭据头
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "proxy-authorization", "proxy-connection", "connection", "content-length", "transfer-encoding"].includes(k)) continue;
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }

    // 2) 凭据命中：先缩小到本会话 vault_ids，再按 host 匹配（§10.4 第 3 条）
    const matched = ctx.credentials.find((c) => {
      if (c.type === "environment_variable") {
        return c.networking.type === "unrestricted"
          ? true
          : (c.networking.allowed_hosts ?? []).some((p) => hostMatches(p, host));
      }
      try {
        return new URL(c.identityKey).hostname === host;
      } catch {
        return false;
      }
    });
    if (matched) {
      // 剥离竞争凭据头（§10.4 第 4 条），占位符替换 / 直接注入
      delete headers.authorization;
      delete headers["x-api-key"];
      // 占位符替换（environment_variable）或直接附加（static_bearer/bearer）
      headers.authorization = `Bearer ${matched.secret}`;
    } else {
      // 3) 公共出网策略（env networking；unrestricted 只放行 80/443）
      const decision = evaluateEgressPolicy(host, port, ctx.envNetworking);
      if (decision.action === "deny") {
        reply.header("x-mas-denied-host", host);
        await recordDenied(claims.sessionId, host, decision.reason);
        reply.code(403);
        return { error: `host denied (${decision.reason})` };
      }
    }

    // 4) 转发（审计面只记 host/method/status，不落请求体）
    reply.hijack();
    const upstream = httpRequest(
      { hostname: host, port, path: target.pathname + target.search, method: req.method, headers },
      (res) => {
        const head: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (["transfer-encoding", "connection", "content-length", "keep-alive"].includes(k)) continue;
          if (typeof v === "string" || typeof v === "number") head[k] = String(v);
        }
        reply.raw.writeHead(res.statusCode ?? 502, res.statusMessage ?? undefined, head);
        res.on("data", (chunk) => reply.raw.write(chunk));
        res.on("end", () => reply.raw.end());
      },
    );
    upstream.on("error", () => {
      reply.raw.writeHead(502, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: "upstream unreachable" }));
    });
    if (Buffer.isBuffer(req.body) && req.body.length > 0) upstream.write(req.body);
    upstream.end();
  });

  return app;
}
