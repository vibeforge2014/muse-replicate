import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "@mas/db";

/**
 * 可观测（spec §16 的 MVP 子集）：
 * - `mas_api_requests_total{route,code}`、`mas_api_latency_seconds`（进程内计数/直方图）；
 * - `mas_sessions{status}`、`mas_egress_denied_total`（DB 侧 gauge）；
 * - `mas_sse_connections`（进程内 gauge，SSE 路由挂/卸时更新）。
 * 输出 Prometheus 文本格式；`GET /internal/metrics` 不走 API key 鉴权，
 * 设置 `MAS_INTERNAL_TOKEN` 时要求 `x-internal-token` 匹配。
 */

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface MetricsState {
  requests: Map<string, number>; // `${route}|${code}` → count
  latency: Map<string, { count: number; sum: number }>; // route → stats
  sseConnections: number;
}

export function newMetricsState(): MetricsState {
  return { requests: new Map(), latency: new Map(), sseConnections: 0 };
}

export function internalTokenOk(req: { headers: Record<string, unknown> }): boolean {
  const expected = process.env.MAS_INTERNAL_TOKEN;
  if (!expected) return true; // 未配置即开放（开发形态；生产设置 MAS_INTERNAL_TOKEN）
  return req.headers["x-internal-token"] === expected;
}

export function registerMetrics(app: FastifyInstance, ctx: { db: Kysely<Database> }, state: MetricsState): void {
  // 请求计数与延迟（onResponse 时路由已匹配）
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (!route.startsWith("/v1/") && route !== "unmatched") return;
    const key = `${route}|${reply.statusCode}`;
    state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
    const lat = state.latency.get(route) ?? { count: 0, sum: 0 };
    lat.count += 1;
    lat.sum += reply.elapsedTime / 1000;
    state.latency.set(route, lat);
  });

  app.get("/internal/metrics", async (req, reply) => {
    if (!internalTokenOk(req)) {
      reply.code(404);
      return { error: "not found" };
    }
    const lines: string[] = [];

    lines.push("# TYPE mas_api_requests_total counter");
    for (const [key, count] of [...state.requests.entries()].sort()) {
      const [route, code] = key.split("|");
      lines.push(`mas_api_requests_total{route="${route}",code="${code}"} ${count}`);
    }

    lines.push("# TYPE mas_api_latency_seconds histogram");
    for (const [route, { count, sum }] of [...state.latency.entries()].sort()) {
      lines.push(`mas_api_latency_seconds_sum{route="${route}"} ${sum.toFixed(6)}`);
      lines.push(`mas_api_latency_seconds_count{route="${route}"} ${count}`);
      void LATENCY_BUCKETS;
    }

    lines.push("# TYPE mas_sse_connections gauge");
    lines.push(`mas_sse_connections ${state.sseConnections}`);

    // 进程 RSS（负载验收用：spec §17.2 worker RSS < 2GB 门禁的观测面）
    lines.push("# TYPE mas_process_resident_memory_bytes gauge");
    lines.push(`mas_process_resident_memory_bytes ${process.memoryUsage().rss}`);

    // DB 侧 gauge
    const statuses = await sql<{ status: string; n: string }>`
      SELECT status, count(*)::text AS n FROM sessions GROUP BY status`.execute(ctx.db);
    lines.push("# TYPE mas_sessions gauge");
    for (const r of statuses.rows) lines.push(`mas_sessions{status="${r.status}"} ${Number(r.n)}`);

    const denied = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM session_events
       WHERE type='session.error' AND payload->'error'->>'type' = 'egress_denied'`.execute(ctx.db);
    lines.push("# TYPE mas_egress_denied_total gauge");
    lines.push(`mas_egress_denied_total ${Number(denied.rows[0]?.n ?? 0)}`);

    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });
}
