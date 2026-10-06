import { createDb } from "@mas/db";
import { buildGatewayApp } from "./app.js";

const port = Number(process.env.MAS_GATEWAY_PORT ?? 8082);
const host = process.env.MAS_GATEWAY_HOST ?? "127.0.0.1";

const db = createDb();
const app = buildGatewayApp({
  db: db.db,
  upstream: {
    baseUrl: process.env.MAS_UPSTREAM_BASE_URL ?? "http://127.0.0.1:8083",
    apiKey: process.env.MAS_UPSTREAM_API_KEY ?? "",
  },
});
await app.listen({ port, host });
app.log.info(`model-gateway listening on ${host}:${port}`);
