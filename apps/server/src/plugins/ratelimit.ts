import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { errRateLimit } from "@mas/core";
import type { Database } from "@mas/db";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** 三类桶的静态形态；数值经 limits() 惰性读取（测试可按需放宽）。 */
const LIMIT_KINDS = { read: null, write: null, events: null } as const;
export type LimitKind = keyof typeof LIMIT_KINDS;

function limitsFor(kind: LimitKind): { burst: number; perSecond: number } {
  // 测试/本地开发可通过 MAS_RATELIMIT_BURST=<n> 放宽；生产默认 spec §11.1 的值
  const base = {
    read: { burst: 100, perSecond: 50 },
    write: { burst: 20, perSecond: 10 },
    events: { burst: 100, perSecond: 50 },
  } as const;
  const boost = Number(process.env.MAS_RATELIMIT_BURST ?? 0);
  return boost > 0 ? { burst: boost, perSecond: base[kind].perSecond } : base[kind];
}

const buckets = new Map<string, Bucket>();

function take(key: string, kind: LimitKind): boolean {
  const cfg = limitsFor(kind);
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

export function retryAfterSeconds(key: string, kind: LimitKind): number {
  const cfg = limitsFor(kind);
  const b = buckets.get(key);
  if (!b) return 0;
  return Math.max(0.05, (1 - b.tokens) / cfg.perSecond);
}

/**
 * PG 令牌桶（多实例一致，偏差 #3）：桶状态存 rate_limit_buckets，
 * 事务内 FOR UPDATE 行锁串行化并发请求，按 DB 时钟补满后原子扣减。
 * DB 异常时 fail-open（可用性优先于防护），错误向上抛由调用方决定。
 */
export async function pgTake(
  db: Kysely<Database>,
  key: string,
  kind: LimitKind,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const cfg = limitsFor(kind);
  return db.transaction().execute(async (tx) => {
    await tx
      .insertInto("rate_limit_buckets")
      .values({ bucket_key: key, tokens: cfg.burst, last_refill: sql`now()` as unknown as Date })
      .onConflict((oc) => oc.doNothing())
      .execute();
    // elapsed 由 DB 计算（跨实例时钟偏移免疫），FOR UPDATE 串行化同桶并发
    const row = await tx
      .selectFrom("rate_limit_buckets")
      .select(["tokens", sql<string>`extract(epoch from now() - last_refill)`.as("elapsed")])
      .where("bucket_key", "=", key)
      .forUpdate()
      .executeTakeFirst();
    const elapsed = Number(row?.elapsed ?? 0);
    let tokens = Math.min(cfg.burst, (row?.tokens ?? cfg.burst) + elapsed * cfg.perSecond);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    await tx
      .updateTable("rate_limit_buckets")
      .set({ tokens, updated_at: sql`now()` as unknown as Date })
      .where("bucket_key", "=", key)
      .execute();
    const retryAfter = allowed ? 0 : Math.max(0.05, (1 - tokens) / cfg.perSecond);
    return { allowed, retryAfterSeconds: retryAfter };
  });
}

/**
 * 按 org 读/写/事件三个令牌桶限流（spec §11.1）。
 * backend=memory（默认）：单进程零开销；backend=pg：rate_limit_buckets 行锁实现，多实例一致。
 */
export function registerRateLimit(app: FastifyInstance, db?: Kysely<Database>): void {
  const usePg = db !== undefined;
  app.addHook("preHandler", async (req, reply) => {
    const ws = req.mas.auth?.workspaceId;
    if (!ws) return; // 未认证的请求由 auth 处理
    const isRead = req.method === "GET" || req.method === "HEAD";
    const isEvents = req.routeOptions?.url?.endsWith("/events") && req.method === "POST";
    const kind: LimitKind = isEvents ? "events" : isRead ? "read" : "write";
    const key = `${ws}:${kind}`;
    let allowed: boolean;
    let retryAfter: number;
    if (usePg) {
      try {
        const r = await pgTake(db!, key, kind);
        allowed = r.allowed;
        retryAfter = r.retryAfterSeconds;
      } catch {
        // fail-open：限流基础设施不可用时放行（可用性优先；记日志可观察）
        req.log.warn({ key }, "pg rate limiter failed; failing open");
        return;
      }
    } else {
      allowed = take(key, kind);
      retryAfter = retryAfterSeconds(key, kind);
    }
    if (!allowed) {
      reply.header("ratelimit-limit", String(limitsFor(kind).burst));
      reply.header("ratelimit-remaining", "0");
      reply.header("ratelimit-reset", String(Math.ceil(retryAfter)));
      reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfter))));
      throw errRateLimit(Math.max(1, Math.ceil(retryAfter)));
    }
  });
}
