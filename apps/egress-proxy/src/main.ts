import { createDb } from "@mas/db";
import { buildEgressApp } from "./app.js";

const port = Number(process.env.MAS_EGRESS_PORT ?? 8081);
const host = process.env.MAS_EGRESS_HOST ?? "127.0.0.1";

const db = createDb();
const app = buildEgressApp({ db: db.db });
await app.listen({ port, host });
app.log.info(`egress-proxy listening on ${host}:${port}`);
