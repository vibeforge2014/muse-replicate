import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { appendApiEvent } from "@mas/db";
import type { Database } from "@mas/db";

/**
 * model-gateway（spec §10.3）：
 * - 对 Codex 暴露 OpenAI Responses API 兼容端点 `POST /v1/responses`（支持流式）；
 * - 鉴权用会话 token（HMAC，claims 绑定 workspace/session）；转发上游时注入真实
 *   API key —— 会话 token 永不出网；
 * - 计量：从（流式或非流式）响应的 usage 累加，写 `span.model_request_start/end`
 *   与累计的 `session.usage` 事件（api 侧写入，物化 sessions.usage）。
 */

export interface GatewayOptions {
  db: Kysely<Database>;
  upstream: { baseUrl: string; apiKey: string };
  adminSecret?: string;
}

interface UsageDelta {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

interface ModelUsage extends UsageDelta {
  model: string;
}

function gatewaySecret(): string {
  return process.env.MAS_GATEWAY_SECRET ?? "mas-dev-gateway-secret";
}

export interface SessionTokenClaims {
  workspaceId: string;
  sessionId: string;
  exp: number;
  jti: string;
}

/** 签发会话 token（worker 启动 runtime 时调用；claims 不含任何上游凭据）。 */
export function issueSessionToken(workspaceId: string, sessionId: string, ttlSeconds = 3600): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const claims: SessionTokenClaims = { workspaceId, sessionId, exp, jti: randomBytes(8).toString("hex") };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", gatewaySecret()).update(payload).digest("base64url");
  return { token: `masmt_v1.${payload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifySessionToken(token: string): { ok: true; claims: SessionTokenClaims } | { ok: false; error: "malformed" | "bad_signature" | "expired" } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "masmt_v1") return { ok: false, error: "malformed" };
  const [, payload, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", gatewaySecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionTokenClaims;
    if (claims.exp * 1000 < Date.now()) return { ok: false, error: "expired" };
    return { ok: true, claims };
  } catch {
    return { ok: false, error: "malformed" };
  }
}

/** 从 Responses API 的 usage 对象映射为平台计量字段。 */
function mapUsage(u: Record<string, unknown> | undefined): UsageDelta {
  const details = (u?.input_tokens_details ?? {}) as { cached_tokens?: number };
  return {
    input_tokens: Number(u?.input_tokens ?? 0),
    output_tokens: Number(u?.output_tokens ?? 0),
    cache_read_input_tokens: Number(details.cached_tokens ?? 0),
  };
}

export function buildGatewayApp(opts: GatewayOptions): FastifyInstance {
  const app = Fastify({
    logger: process.env.MAS_LOG === "0" ? false : { level: process.env.MAS_LOG_LEVEL ?? "warn" },
    bodyLimit: 32 * 1024 * 1024,
  });
  const adminSecret = opts.adminSecret ?? gatewaySecret();
  const upstreamBase = opts.upstream.baseUrl.replace(/\/$/, "");
  const tokensTotal = new Map<string, number>(); // `${model}|${kind}` → tokens（/internal/metrics 用）

  async function recordUsage(sessionId: string, spanId: string, modelUsage: ModelUsage, isError: boolean): Promise<void> {
    await appendApiEvent(opts.db, sessionId, "span.model_request_end", {
      span_id: spanId,
      model_usage: modelUsage,
      is_error: isError,
    });
    if (isError) return;
    // session.usage 携带累计值（appendEvent/appendApiEvent 物化语义为整体替换）
    const row = await opts.db
      .selectFrom("sessions")
      .select(["usage"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    const prev = (row?.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }) as UsageDelta;
    const total: UsageDelta = {
      input_tokens: prev.input_tokens + modelUsage.input_tokens,
      output_tokens: prev.output_tokens + modelUsage.output_tokens,
      cache_read_input_tokens: prev.cache_read_input_tokens + modelUsage.cache_read_input_tokens,
    };
    await appendApiEvent(opts.db, sessionId, "session.usage", { usage: total });
    for (const [kind, n] of [
      ["input", modelUsage.input_tokens],
      ["output", modelUsage.output_tokens],
      ["cache_read", modelUsage.cache_read_input_tokens],
    ] as const) {
      const key = `${modelUsage.model}|${kind}`;
      tokensTotal.set(key, (tokensTotal.get(key) ?? 0) + n);
    }
  }

  // ---- 内部：签发会话 token ----
  app.post("/internal/tokens", async (req, reply) => {
    if (req.headers["x-gateway-admin"] !== adminSecret) {
      reply.code(403);
      return { error: "unauthorized" };
    }
    const body = req.body as { workspaceId?: string; sessionId?: string; ttlSeconds?: number };
    if (!body?.workspaceId || !body.sessionId) {
      reply.code(400);
      return { error: "workspaceId and sessionId required" };
    }
    return issueSessionToken(body.workspaceId, body.sessionId, body.ttlSeconds);
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/internal/metrics", async (_req, reply) => {
    const lines = ["# TYPE mas_model_tokens_total counter"];
    for (const [key, n] of [...tokensTotal.entries()].sort()) {
      const [model, kind] = key.split("|");
      lines.push(`mas_model_tokens_total{model="${model}",kind="${kind}"} ${n}`);
    }
    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });

  // ---- Responses API 兼容端点 ----
  app.post("/v1/responses", async (req, reply) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const verdict = verifySessionToken(token);
    if (!verdict.ok) {
      reply.code(401);
      return { error: { type: "invalid_request_error", message: `session token ${verdict.error}` } };
    }
    const { sessionId } = verdict.claims;
    const body = req.body as { model?: string; stream?: boolean } | undefined;
    const model = typeof body?.model === "string" && body.model ? body.model : "unknown";
    const spanId = `span_${randomBytes(8).toString("hex")}`;
    const startedAt = new Date().toISOString();

    await appendApiEvent(opts.db, sessionId, "span.model_request_start", {
      span_id: spanId,
      model_usage: { model } as ModelUsage,
      started_at: startedAt,
    });

    // 转发上游：注入真实 API key（会话 token 不出网）
    const upstreamUrl = new URL("/v1/responses", upstreamBase);
    reply.hijack();
    const upstream = httpRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 80,
        path: upstreamUrl.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.upstream.apiKey}`,
          accept: body?.stream ? "text/event-stream" : "application/json",
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const isStream = (res.headers["content-type"] ?? "").includes("text/event-stream");
        reply.raw.writeHead(status, res.statusMessage ?? undefined, {
          "content-type": String(res.headers["content-type"] ?? "application/json"),
        });
        if (status >= 400) {
          // 上游错误：透传并收尾 span（is_error）
          let errBody = "";
          res.on("data", (c) => {
            errBody += c;
            reply.raw.write(c);
          });
          res.on("end", async () => {
            reply.raw.end();
            await recordUsage(sessionId, spanId, { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, true).catch(() => undefined);
            void errBody;
          });
          return;
        }
        if (!isStream) {
          let json = "";
          res.on("data", (c) => (json += c));
          res.on("end", async () => {
            reply.raw.end(json);
            let usage: UsageDelta | null = null;
            try {
              const parsed = JSON.parse(json) as { usage?: Record<string, unknown> };
              usage = mapUsage(parsed.usage);
            } catch {
              usage = null;
            }
            await recordUsage(sessionId, spanId, { model, ...(usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }) }, false).catch(() => undefined);
          });
          return;
        }
        // 流式：透传 SSE，扫描 response.completed 的 usage
        let buf = "";
        let usage: UsageDelta | null = null;
        res.on("data", (chunk: Buffer) => {
          reply.raw.write(chunk);
          buf += chunk.toString("utf8");
          // 逐行解析 data: 帧，命中 response.completed 时抽取 usage
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const ev = JSON.parse(data) as { type?: string; response?: { usage?: Record<string, unknown> } };
              if (ev.type === "response.completed" && ev.response?.usage) usage = mapUsage(ev.response.usage);
            } catch {
              /* 非 JSON 帧忽略 */
            }
          }
        });
        res.on("end", async () => {
          reply.raw.end();
          await recordUsage(sessionId, spanId, { model, ...(usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }) }, false).catch(() => undefined);
        });
      },
    );
    upstream.on("error", () => {
      reply.raw.writeHead(502, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: { type: "api_error", message: "upstream unreachable" } }));
      void recordUsage(sessionId, spanId, { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, true).catch(() => undefined);
    });
    upstream.end(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
    return reply;
  });

  return app;
}
