import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { MasError, newId } from "@mas/core";
import type { Database } from "@mas/db";
import { sha256hex } from "@mas/db";

export interface StoredResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface IdempotencyOutcome {
  replayed: boolean;
  response?: StoredResponse;
}

/**
 * Idempotency-Key：24h 内同 key 同 body 返回首次响应；同 key 不同 body 409（spec §11.1 / REC-07）。
 * 返回 replayed=true 时路由直接回放 outcome.response。
 */
export async function beginIdempotent(db: Kysely<Database>, req: FastifyRequest): Promise<IdempotencyOutcome> {
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
      return { replayed: true, response: existing.response as unknown as StoredResponse };
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

/** 响应确定后回填存储的响应体（同 key 同 hash 才会更新）。 */
export async function finishIdempotent(
  db: Kysely<Database>,
  req: FastifyRequest,
  response: StoredResponse,
): Promise<void> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key) return;
  const workspaceId = req.mas.auth!.workspaceId;
  const requestHash = sha256hex(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
  await db
    .updateTable("idempotency_keys")
    .set({ response: response as unknown as Record<string, unknown> })
    .where("workspace_id", "=", workspaceId)
    .where("key", "=", key)
    .where("request_hash", "=", requestHash)
    .execute();
}

export const newRequestId = newId;
