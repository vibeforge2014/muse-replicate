import { beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../apps/server/src/app.ts";
import { pgTake } from "../apps/server/src/plugins/ratelimit.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

/**
 * PG 限流后端（偏差 #3 / spec §13.4）：
 * rate_limit_buckets 行锁令牌桶——并发扣减精确、多实例一致、HTTP 层 429 + 头部。
 */

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

describe("PG 限流（RL-PG）", () => {
  test("RL-PG-01 并发扣减精确：受限桶并发 take 后拒绝且随后恢复", async () => {
    const prev = process.env.MAS_RATELIMIT_BURST;
    process.env.MAS_RATELIMIT_BURST = "3";
    try {
      const key = `rl-pg-conc-${Date.now()}`;
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => pgTake(env.db.db, key, "write")),
      );
      const allowed = rs.filter((r) => r.allowed).length;
      const denied = rs.filter((r) => !r.allowed);
      // burst=3 + 少量 refill（write 10/s）→ 放行 3~5，其余拒绝且带 retryAfter
      expect(allowed).toBeGreaterThanOrEqual(3);
      expect(allowed).toBeLessThanOrEqual(5);
      expect(denied.length).toBe(10 - allowed);
      for (const d of denied) expect(d.retryAfterSeconds).toBeGreaterThan(0);

      // 恢复：等 refill（write perSecond=10 → 100ms/枚）
      await new Promise((res) => setTimeout(res, 250));
      const r2 = await pgTake(env.db.db, key, "write");
      expect(r2.allowed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MAS_RATELIMIT_BURST;
      else process.env.MAS_RATELIMIT_BURST = prev;
    }
  });

  test("RL-PG-02 HTTP 层：pg 后端 app 并发读触发 429 + 标准头部，随后恢复", async () => {
    // 独立 app 实例：MAS_RATELIMIT_BURST=4（只影响该进程的模块配置）
    const prevBurst = process.env.MAS_RATELIMIT_BURST;
    const prevBackend = process.env.MAS_RATELIMIT_BACKEND;
    process.env.MAS_RATELIMIT_BURST = "4";
    process.env.MAS_RATELIMIT_BACKEND = "pg";
    try {
      const app = buildApp({ db: env.db });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const key = env.key;

      // 并发 12 个读：burst=4 + 少量 refill → 大部分 429
      const rs = await Promise.all(
        Array.from({ length: 12 }, () =>
          fetch(`${base}/v1/agents`, { headers: { authorization: `Bearer ${key}` } }),
        ),
      );
      const ok = rs.filter((r) => r.status === 200).length;
      const limited = rs.filter((r) => r.status === 429).length;
      expect(limited).toBeGreaterThan(0);
      expect(ok + limited).toBe(12);
      const limitedResp = rs.find((r) => r.status === 429)!;
      expect(limitedResp.headers.get("ratelimit-remaining")).toBe("0");
      expect(limitedResp.headers.get("retry-after")).toMatch(/^\d+$/);
      const body = (await limitedResp.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("rate_limit_error");

      // 恢复：等 refill（read perSecond=50 → 20ms/枚）
      await new Promise((res) => setTimeout(res, 300));
      const again = await fetch(`${base}/v1/agents`, { headers: { authorization: `Bearer ${key}` } });
      expect(again.status).toBe(200);
      await app.close();
    } finally {
      if (prevBurst === undefined) delete process.env.MAS_RATELIMIT_BURST;
      else process.env.MAS_RATELIMIT_BURST = prevBurst;
      if (prevBackend === undefined) delete process.env.MAS_RATELIMIT_BACKEND;
      else process.env.MAS_RATELIMIT_BACKEND = prevBackend;
    }
  });

  test("RL-PG-03 状态行落库：扣减后 tokens 被持久化（跨实例共享同一事实）", async () => {
    const key = `rl-pg-row-${Date.now()}`;
    const r = await pgTake(env.db.db, key, "read");
    expect(r.allowed).toBe(true);
    const row = await env.db.db
      .selectFrom("rate_limit_buckets")
      .selectAll()
      .where("bucket_key", "=", key)
      .executeTakeFirst();
    expect(row).toBeTruthy();
    // burst=10000（测试放宽）扣 1 枚后余 9999（elapsed 补满上限为 burst）
    expect(row!.tokens).toBeLessThanOrEqual(9999);
    expect(row!.tokens).toBeGreaterThan(9990);
  });
});
