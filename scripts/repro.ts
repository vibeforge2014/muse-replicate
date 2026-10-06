import { bootstrap, createDb, runMigrations } from "@mas/db";
import { buildApp } from "../apps/server/src/app.ts";

const db = createDb();
await runMigrations(db.pool);
await bootstrap(db.db);
process.env.MAS_LOG = "0";
const app = buildApp({ db });
console.time("healthz");
const r1 = await app.inject({ method: "GET", url: "/healthz" });
console.log("healthz:", r1.statusCode, r1.body, console.timeEnd("healthz"));
console.time("agents-unauth");
const r2 = await app.inject({ method: "GET", url: "/v1/agents" });
console.log("agents:", r2.statusCode, r2.body.slice(0, 120), console.timeEnd("agents-unauth"));
process.exit(0);
