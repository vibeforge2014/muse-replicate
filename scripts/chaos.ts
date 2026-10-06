#!/usr/bin/env npx tsx
/**
 * 混沌车道全量门禁（spec §17.2）：固定种子集合全绿。
 * 用法：pnpm test:chaos [种子数，默认 200]
 */
process.env.DATABASE_URL ??= "postgres://mas@localhost:5433/mas_test";
process.env.MAS_LOG ??= "0";

const count = Number(process.argv[2] ?? 200);
const { bootstrap, createDb, runMigrations } = await import("@mas/db");
const { runChaosSeed, fixedSeeds, chaosStore } = await import("../tests/chaos-harness.ts");

const db = createDb();
await runMigrations(db.pool);
const boot = await bootstrap(db.db);
const ws = (await db.db.selectFrom("workspaces").select(["id"]).limit(1).executeTakeFirst())!.id;
const envId = (await db.db.selectFrom("environments").select(["id"]).limit(1).executeTakeFirst())!.id;
const agent = { system: null, model: { id: "glm-5.3-flash" }, tools: [] };

let failed = 0;
const t0 = Date.now();
for (const seed of fixedSeeds(count)) {
  try {
    const r = await runChaosSeed(db.db, chaosStore(String(seed)), seed, {
      steps: 40,
      workspaceId: ws,
      agentSnapshot: agent,
      environmentId: envId,
    });
    console.log(
      `seed ${seed} ok: writes=${r.canonicalWrites} staleRejected=${r.rejectedStale} ckpt=${r.checkpointCommits} outputs=${r.outputFiles}`,
    );
  } catch (e) {
    failed += 1;
    console.error(`seed ${seed} FAILED: ${(e as Error).message}`);
  }
}
console.log(`\n${count - failed}/${count} seeds green in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed > 0 ? 1 : 0);
