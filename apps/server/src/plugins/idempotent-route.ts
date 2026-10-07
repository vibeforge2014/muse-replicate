import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@mas/db";
import { beginIdempotent, finishIdempotent } from "./idempotency.js";

/**
 * POST 路由幂等包装（spec §11.1 / M5 5.1）：
 * 带 Idempotency-Key 时同 key 同 body 回放首次响应、异 body 409。
 * 不带头时零开销直通。
 * fingerprint：multipart 等非 JSON body 由路由解析后显式给出（偏差 #10）。
 */
export async function withIdempotency(
  db: Kysely<Database>,
  req: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<Record<string, unknown>>,
  fingerprint?: string,
): Promise<Record<string, unknown> | unknown> {
  const idem = await beginIdempotent(db, req, fingerprint);
  if (idem.replayed && idem.response) {
    reply.code(idem.response.status);
    return idem.response.body;
  }
  const out = await run();
  await finishIdempotent(db, req, { status: reply.statusCode, body: out }, fingerprint);
  return out;
}
