import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { MasError, newId } from "@mas/core";
import type { Database } from "@mas/db";
import { sha256hex } from "@mas/db";

export interface IdempotencyOutcome {
  replayed: boolean;
  response?: Record<string, unknown>;
}

/**
 * Idempotency-Key：24h 内同 key 同 body 返回首次响应；同 key 不同 body 409（spec §11.1）。
 * 返回 replayed=true 时直接回放存储的响应。
 */
export async function beginIdempotent(
  db: Kysely<Database>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<IdempotencyOutcome> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key) return { replayed: false };
  if (key.length > 256) throw new MasError("invalid_request_error", "Idempotency-Key too long");
  const workspaceId = req.mas.auth!.workspaceId;
  const requestHash = sha256hex(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
  const existing = await db
    .selectFrom("idempotency_keys")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("key", "=", key)
    .executeTakeFirst();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new MasError("idempotency_conflict", "Idempotency-Key was already used with a different request body");
    }
    if (existing.response) {
      reply.code(existing.response.status as number);
      void reply.headers((existing.response.headers as Record<string, string>) ?? {});
      reply.send(existing.response.body);
      return { replayed: true, response: existing.response };
    }
  }
  // 占位（防并发重复）：先插占位行，响应完成后回填
  await db
    .insertInto("idempotency_keys")
    .values({ workspace_id: workspaceId, key, request_hash: requestHash, response: null })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return { replayed: false };
}

export async function finishIdempotent(
  db: Kysely<Database>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key) return;
  const workspaceId = req.mas.auth!.workspaceId;
  const requestHash = sha256hex(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
  const body = reply.sent ? undefined : null;
  await db
    .updateTable("idempotency_keys")
    .set({
      response: {
        status: reply.statusCode,
        body,
        headers: {},
      },
    })
    .where("workspace_id", "=", workspaceId)
    .where("key", "=", key)
    .where("request_hash", "=", requestHash)
    .execute();
}

export const newRequestId = newId;
