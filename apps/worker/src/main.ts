import { Client } from "pg";
import { configureOtel } from "@mas/core";
import { createDb, runMigrations, sessionsWithWork } from "@mas/db";
import { WarmPoolProvider, type SandboxProvider } from "@mas/sandbox";
import { SessionRunner } from "./session-runner.js";
import { driverFromEnv, sandboxProviderFromEnv } from "./driver.js";

/**
 * session-worker 主循环（spec §4.1）：
 * - NOTIFY 驱动 + 定时扫描（兜底 NOTIFY 丢失）；
 * - SKIP LOCKED claim，多 worker 安全。
 */
async function main() {
  configureOtel(process.env); // spec §16：MAS_OTLP_ENDPOINT 设置时导出 worker span
  const db = createDb();
  await runMigrations(db.pool);
  const driver = driverFromEnv();
  const baseProvider = sandboxProviderFromEnv();
  // warm pool（spec §9.3 二期）：MAS_WARM_POOL_MIN>0 时包装 provider 预建空沙箱；
  // provider 不支持 attach 时 fail closed（不静默回退冷创建）
  const warmMin = Math.max(0, Number(process.env.MAS_WARM_POOL_MIN ?? 0) || 0);
  if (warmMin > 0 && !baseProvider.attach) {
    console.error(`[worker] MAS_WARM_POOL_MIN>0 需要 provider 支持 attach（${baseProvider.kind} 不支持）`);
    process.exit(1);
  }
  const provider: SandboxProvider | undefined =
    warmMin > 0 ? new WarmPoolProvider(baseProvider, { min: warmMin }) : baseProvider;
  const runner = new SessionRunner(db.db, driver, undefined, undefined, provider);
  const inFlight = new Set<string>();

  const drain = async () => {
    const ids = await sessionsWithWork(db.db);
    for (const sessionId of ids) {
      if (inFlight.has(sessionId)) continue;
      inFlight.add(sessionId);
      void runner
        .processSession(sessionId)
        .catch((e) => console.error(`[worker] session ${sessionId} failed:`, e?.message ?? e))
        .finally(() => inFlight.delete(sessionId));
    }
  };

  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://mas@localhost:5433/mas_dev",
  });
  await client.connect();
  await client.query("LISTEN session_exec");
  client.on("notification", () => void drain());

  const timer = setInterval(() => void drain(), 3000);
  console.log(`[worker] listening for session_exec (pid ${process.pid})`);

  const shutdown = async () => {
    clearInterval(timer);
    await client.end().catch(() => undefined);
    if (provider instanceof WarmPoolProvider) await provider.drain().catch(() => undefined);
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
