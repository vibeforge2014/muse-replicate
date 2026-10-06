export type MasErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "conflict_error"
  | "request_too_large"
  | "rate_limit_error"
  | "idempotency_conflict"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

export type DialectKind = "anthropic" | "bigmodel";

const STATUS_BY_TYPE: Record<MasErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  idempotency_conflict: 409,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/** 平台统一错误。序列化时按方言调整 409 的 error.type（spec §11.1、§12.3）。 */
export class MasError extends Error {
  readonly type: MasErrorType;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(type: MasErrorType, message: string, details?: Record<string, unknown>, status?: number) {
    super(message);
    this.name = "MasError";
    this.type = type;
    this.status = status ?? STATUS_BY_TYPE[type];
    this.details = details;
  }

  toEnvelope(dialect: DialectKind, requestId: string) {
    // BigModel 方言：409 一律 invalid_request_error（test-case C-03）。
    let type = this.type;
    if (this.status === 409 && dialect === "bigmodel") {
      type = this.type === "idempotency_conflict" ? "idempotency_conflict" : "invalid_request_error";
    }
    return {
      type: "error" as const,
      error: {
        type,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
      request_id: requestId,
    };
  }
}

export const errInvalid = (msg: string, details?: Record<string, unknown>) =>
  new MasError("invalid_request_error", msg, details);
export const errNotFound = (msg = "not found") => new MasError("not_found_error", msg);
export const errAuth = (msg = "invalid api key") => new MasError("authentication_error", msg);
export const errConflict = (msg: string, details?: Record<string, unknown>) =>
  new MasError("conflict_error", msg, details);
export const errRateLimit = (retryAfterSeconds: number) =>
  new MasError("rate_limit_error", "rate limit exceeded", { retry_after: retryAfterSeconds });
