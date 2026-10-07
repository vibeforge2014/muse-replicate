import type { FastifyReply, FastifyRequest } from "fastify";
import { ulid } from "ulid";
import {
  detectDialect,
  formatTraceparent,
  otelEnabled,
  parseTraceparent,
  spanTraceparent,
  startSpan,
  type DialectKind,
  type Span,
} from "@mas/core";

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
      /** OTel 请求 span（MAS_OTLP_ENDPOINT 未设置时为 null）。 */
      span: Span | null;
    };
  }
}

/** request-id + 方言检测 + 链路 span（spec §11.1 / §16）。 */
export async function requestContextHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const requestId = `req_${ulid()}`;
  const parent = parseTraceparent(traceparentHeader(req));
  req.mas = {
    requestId,
    dialect: detectDialect({
      get: (name: string) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
    }),
    auth: null,
    span: otelEnabled()
      ? startSpan("mas.api.request", { "http.request.method": req.method, "url.path": req.url, request_id: requestId }, parent)
      : null,
  };
  _reply.header("request-id", requestId);
}

function traceparentHeader(req: FastifyRequest): string | undefined {
  const v = req.headers.traceparent;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 当前请求应写入 session_executions.traceparent 的 W3C 字符串（spec §16：
 * traceparent 跟随 command）：有请求 span 用 span 自身（与入口头同 trace），
 * OTel 关闭时退回入口头规范化后透传，无头返回 null。
 */
export function requestTraceparent(req: FastifyRequest): string | null {
  if (req.mas?.span) return spanTraceparent(req.mas.span);
  const ctx = parseTraceparent(traceparentHeader(req));
  return ctx ? formatTraceparent(ctx) : null;
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
