import type { FastifyInstance } from "fastify";
import { errRateLimit } from "@mas/core";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const BUCKETS = (() => {
  // 测试/本地开发可通过 MAS_RATELIMIT_BURST=<n> 放宽；生产默认 spec §11.1 的值
  const boost = Number(process.env.MAS_RATELIMIT_BURST ?? 0);
  const base = {
    read: { burst: 100, perSecond: 50 },
    write: { burst: 20, perSecond: 10 },
    events: { burst: 100, perSecond: 50 },
  };
  if (boost > 0) {
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      base[k] = { burst: boost, perSecond: base[k].perSecond };
    }
  }
  return base;
})();

const buckets = new Map<string, Bucket>();

function take(key: string, kind: keyof typeof BUCKETS): boolean {
  const cfg = BUCKETS[kind];
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: cfg.burst, lastRefill: now };
    buckets.set(key, b);
  }
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(cfg.burst, b.tokens + elapsed * cfg.perSecond);
  b.lastRefill = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function retryAfterSeconds(key: string, kind: keyof typeof BUCKETS): number {
  const cfg = BUCKETS[kind];
  const b = buckets.get(key);
  if (!b) return 0;
  return Math.max(0.05, (1 - b.tokens) / cfg.perSecond);
}

/**
 * 按 org 读/写/事件三个令牌桶限流（spec §11.1）。
 * 单进程内存实现；多实例部署时需换 PG/Redis（spec §13.4 的演进位）。
 */
export function registerRateLimit(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    const ws = req.mas.auth?.workspaceId;
    if (!ws) return; // 未认证的请求由 auth 处理
    const isRead = req.method === "GET" || req.method === "HEAD";
    const isEvents = req.routeOptions?.url?.endsWith("/events") && req.method === "POST";
    const kind: keyof typeof BUCKETS = isEvents ? "events" : isRead ? "read" : "write";
    const key = `${ws}:${kind}`;
    if (!take(key, kind)) {
      const retryAfter = retryAfterSeconds(key, kind);
      reply.header("ratelimit-limit", String(BUCKETS[kind].burst));
      reply.header("ratelimit-remaining", "0");
      reply.header("ratelimit-reset", String(Math.ceil(retryAfter)));
      reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfter))));
      throw errRateLimit(Math.max(1, Math.ceil(retryAfter)));
    }
  });
}
