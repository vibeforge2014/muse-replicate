import type { ApiError, Page } from "./types";

const STORAGE_KEY = "mas_console_api_key";
const BASE_URL_KEY = "mas_console_api_base";

function uuid(): string {
  // crypto.randomUUID 在所有现代浏览器都可用
  return crypto.randomUUID();
}

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key: string | null): void {
  if (key) localStorage.setItem(STORAGE_KEY, key);
  else localStorage.removeItem(STORAGE_KEY);
}

export function getApiBase(): string {
  // 默认同源（生产部署时 console 由 Fastify 托管）；开发时 Vite proxy 转接
  return localStorage.getItem(BASE_URL_KEY) || "";
}

export function setApiBase(url: string): void {
  localStorage.setItem(BASE_URL_KEY, url);
}

export class MasApiError extends Error {
  readonly status: number;
  readonly apiError: ApiError;
  constructor(status: number, apiError: ApiError) {
    super(`${apiError.type}: ${apiError.message}`);
    this.name = "MasApiError";
    this.status = status;
    this.apiError = apiError;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** 自动加 Idempotency-Key；POST 默认 true */
  idempotent?: boolean;
  signal?: AbortSignal;
  raw?: FormData;
}

export async function call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const key = getApiKey();
  if (!key) throw new MasApiError(401, { type: "auth_missing", message: "未设置 API Key" });

  const base = getApiBase();
  const url = new URL((base || "") + path, window.location.origin);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
  };
  let body: BodyInit | undefined;
  if (opts.raw) {
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.idempotent !== false && (opts.method ?? "GET") === "POST") {
    headers["Idempotency-Key"] = uuid();
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body,
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (json?.error ?? { type: "unknown", message: text || res.statusText }) as ApiError;
    throw new MasApiError(res.status, err);
  }
  return json as T;
}

// 列表通用（带分页 + 自动取下一页）
export async function listAll<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const queryWithCursor: Record<string, string | number | boolean | undefined> = {
      ...query,
      ...(cursor ? { after_id: cursor } : {}),
    };
    const page: Page<T> = await call<Page<T>>(path, { query: queryWithCursor });
    all.push(...page.data);
    cursor = page.next_page;
    if (!cursor) return all;
    if (all.length > 2000) return all; // 防御：单次列表最多取 2000
  }
}
