import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { MasError, configureOtel, errAuth } from "@mas/core";
import { authenticate, type DbHandle } from "@mas/db";
import { requestContextHook, sendErrorEnvelope } from "./plugins/context.js";
import { registerRateLimit } from "./plugins/ratelimit.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerVaultRoutes } from "./routes/vaults.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { newMetricsState, registerMetrics } from "./plugins/metrics.js";

export interface BuildAppOptions {
  db: DbHandle;
  /** SSE 连接计数（跨进程部署时接 Redis；MVP 单实例内存计数）。 */
  sseCounts?: { bySession: Map<string, number>; byWorkspace: Map<string, number> };
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  // OTel（spec §16）：MAS_OTLP_ENDPOINT 设置时开启 span 导出（幂等，测试可重复构建）
  configureOtel(process.env);
  const app = Fastify({
    logger: process.env.MAS_LOG === "0" ? false : { level: process.env.MAS_LOG_LEVEL ?? "warn" },
    genReqId: () => `req_${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`,
    bodyLimit: 64 * 1024 * 1024,
  });

  app.addHook("onRequest", requestContextHook);
  // 请求 span 收口（requestContextHook 起的 mas.api.request 在响应时结束）
  app.addHook("onResponse", async (req, reply) => {
    const span = req.mas?.span;
    if (span) {
      span.end(reply.statusCode < 500, {
        "http.route": req.routeOptions?.url ?? req.url,
        "http.response.status_code": reply.statusCode,
      });
    }
  });

  // 鉴权（Authorization: Bearer 或 x-api-key；spec §11.1）
  app.addHook("preHandler", async (req, reply) => {
    if (req.routeOptions?.url?.startsWith("/internal/") || req.routeOptions?.url === "/healthz") return;
    const header = req.headers.authorization;
    const secret =
      header?.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-api-key"] as string | undefined);
    if (!secret) throw errAuth("missing api key");
    const auth = await authenticate(opts.db.db, secret);
    if (!auth) throw errAuth("invalid api key");
    req.mas.auth = auth;
  });

  // 限流后端（spec §13.4 / 偏差 #3）：默认内存（零开销）；MAS_RATELIMIT_BACKEND=pg 时多实例一致
  registerRateLimit(app, process.env.MAS_RATELIMIT_BACKEND === "pg" ? opts.db.db : undefined);
  void app.register(multipart, { limits: { fileSize: Number(process.env.MAS_MAX_FILE_BYTES ?? 500 * 1024 * 1024) } });

  // 路由登记表：OpenAPI 规范零漂移校验用（tests/openapi.test.ts 读取 app.masRoutes）
  const masRoutes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    for (const m of Array.isArray(route.method) ? route.method : [route.method]) {
      masRoutes.push({ method: String(m).toUpperCase(), url: String(route.url) });
    }
  });
  app.decorate("masRoutes", masRoutes);

  // 错误映射：MasError → 方言信封；zod → 400；其他 → 500（spec §11.1）
  app.setErrorHandler((err: unknown, req, reply) => {
    const requestId = req.mas?.requestId ?? "req_unknown";
    if (err instanceof MasError) {
      const env = err.toEnvelope(req.mas?.dialect ?? "anthropic", requestId);
      reply.code(err.status).send(env);
      return;
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (err instanceof ZodError) {
      sendErrorEnvelope(reply, 400, "invalid_request_error", err.issues[0]?.message ?? "invalid request", requestId);
      return;
    }
    if (e.validation) {
      sendErrorEnvelope(reply, 400, "invalid_request_error", String(e.message), requestId);
      return;
    }
    const status = e.statusCode ?? 500;
    if (status === 415) {
      sendErrorEnvelope(reply, 400, "invalid_request_error", "content-type must be application/json", requestId);
      return;
    }
    if (status >= 400 && status < 500) {
      sendErrorEnvelope(reply, status, "invalid_request_error", String(e.message ?? "request failed"), requestId);
      return;
    }
    req.log.error({ err }, "unhandled error");
    sendErrorEnvelope(reply, 500, "api_error", "internal error", requestId);
  });

  app.setNotFoundHandler((req, reply) => {
    sendErrorEnvelope(reply, 404, "not_found_error", `no route for ${req.method} ${req.url}`, req.mas?.requestId ?? "req_unknown");
  });

  app.get("/healthz", async () => ({ ok: true }));

  const ctx = { db: opts.db.db, pool: opts.db.pool, sseCounts: opts.sseCounts };
  registerAgentRoutes(app, ctx);
  registerEnvironmentRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerSkillRoutes(app, ctx);
  registerDeploymentRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerInternalRoutes(app, ctx);
  const metrics = newMetricsState();
  app.decorate("masMetrics", metrics);
  registerMetrics(app, { db: opts.db.db }, metrics);

  return app;
}
