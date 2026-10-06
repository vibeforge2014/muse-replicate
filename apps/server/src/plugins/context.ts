import type { FastifyReply, FastifyRequest } from "fastify";
import { ulid } from "ulid";
import { detectDialect, type DialectKind } from "@mas/core";

export interface AuthState {
  workspaceId: string;
  keyId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    mas: {
      requestId: string;
      dialect: DialectKind;
      auth: AuthState | null;
    };
  }
}

/** request-id + 方言检测（spec §11.1）。 */
export async function requestContextHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const requestId = `req_${ulid()}`;
  req.mas = {
    requestId,
    dialect: detectDialect({
      get: (name: string) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
    }),
    auth: null,
  };
  _reply.header("request-id", requestId);
}

export function sendErrorEnvelope(
  reply: FastifyReply,
  status: number,
  type: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): void {
  reply.status(status).send({
    type: "error",
    error: { type, message, ...(details ? { details } : {}) },
    request_id: requestId,
  });
}
