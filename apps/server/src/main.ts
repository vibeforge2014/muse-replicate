import { bootstrap, createDb, runMigrations, startDeploymentScheduler } from "@mas/db";
import { buildApp } from "./app.js";

async function main() {
  const db = createDb();
  await runMigrations(db.pool);
  const result = await bootstrap(db.db);
  if (result.apiKey) {
    console.log("[mas] bootstrapped default org/workspace");
    console.log(`[mas] API key (shown once): ${result.apiKey}`);
  }
  const app = buildApp({ db });
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  console.log(`[mas] api listening on http://${host}:${port}`);
  startDeploymentScheduler(db.db); // Deployments 调度（单进程 MVP）
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
