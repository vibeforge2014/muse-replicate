import { randomBytes } from "node:crypto";

/**
 * 最小 OpenTelemetry 链路（spec §16：api → PG → worker → driver）：
 * - W3C traceparent 解析/生成（traceparent 跟随 command：api 入口请求头 →
 *   session_executions.traceparent 列 → worker 以其为父 span，跨进程经 PG 串联）；
 * - OTLP/HTTP JSON 批量导出（MAS_OTLP_ENDPOINT 未设置=禁用；零依赖手写）；
 * - span 极简：name/startTime/endTime/attributes/parent，无采样决策（全导出）。
 */

export interface TraceContext {
  traceId: string; // 32 hex
  spanId: string; // 16 hex
}

const TP_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** 解析 W3C traceparent（非法返回 null；只接受小写 hex 标准形态）。 */
export function parseTraceparent(header: string | undefined | null): TraceContext | null {
  if (!header) return null;
  const m = TP_RE.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId] = m as unknown as [string, string, string, string, string];
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  if (version === "ff") return null;
  return { traceId, spanId };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startedAt: number; // epoch ms
  endedAt: number | null;
  attributes: Record<string, unknown>;
  status: "unset" | "ok" | "error";
  end(ok?: boolean, extraAttrs?: Record<string, unknown>): void;
}

interface ExportedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startedAt: number;
  endedAt: number;
  attributes: Record<string, unknown>;
  status: "unset" | "ok" | "error";
}

const hex = (n: number) => randomBytes(n).toString("hex");

/** 已完成待导出的 span 缓冲（测试可直接读取）。 */
export const spanBuffer: ExportedSpan[] = [];

let endpoint: string | null = null;
let serviceName = "mas";
let flushing = false;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_BUFFER = 512;

let timerStarted = false;

export function configureOtel(env: NodeJS.ProcessEnv = process.env): void {
  endpoint = env.MAS_OTLP_ENDPOINT?.trim() || null;
  serviceName = env.MAS_OTLP_SERVICE_NAME?.trim() || "mas";
  if (endpoint && !timerStarted) {
    // 幂等：重复调用（测试多 app / 多进程共享模块）不叠定时器
    timerStarted = true;
    const timer = setInterval(() => void flushSpans(), FLUSH_INTERVAL_MS);
    timer.unref?.();
  }
}

export function otelEnabled(): boolean {
  return endpoint !== null;
}

/** 起一个 span；parent 传 traceparent 字符串或已解析上下文。 */
export function startSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  parent?: string | TraceContext | null,
): Span {
  const p = typeof parent === "string" ? parseTraceparent(parent) : (parent ?? null);
  const span: Span = {
    name,
    traceId: p?.traceId ?? hex(16),
    spanId: hex(8),
    parentSpanId: p?.spanId ?? null,
    startedAt: Date.now(),
    endedAt: null,
    attributes,
    status: "unset",
    end(ok, extraAttrs) {
      if (span.endedAt !== null) return;
      span.endedAt = Date.now();
      span.status = ok === undefined ? "unset" : ok ? "ok" : "error";
      if (extraAttrs) Object.assign(span.attributes, extraAttrs);
      const exported: ExportedSpan = { ...span } as unknown as ExportedSpan;
      spanBuffer.push(exported);
      if (spanBuffer.length > MAX_BUFFER) spanBuffer.splice(0, spanBuffer.length - MAX_BUFFER);
      if (endpoint && spanBuffer.length >= 32) void flushSpans();
    },
  };
  return span;
}

/** 当前 span 的 traceparent（作为下游父上下文，例如写入 session_executions）。 */
export function spanTraceparent(span: Span): string {
  return formatTraceparent({ traceId: span.traceId, spanId: span.spanId });
}

/** OTLP/HTTP JSON 导出（https://opentelemetry.io/docs/specs/otlp/，v1/traces）。 */
export async function flushSpans(): Promise<void> {
  if (!endpoint || flushing || spanBuffer.length === 0) return;
  flushing = true;
  const batch = spanBuffer.splice(0, 128);
  try {
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
          scopeSpans: [
            {
              scope: { name: "mas" },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? undefined,
                name: s.name,
                kind: 1, // INTERNAL
                startTimeUnixNano: String(s.startedAt * 1e6),
                endTimeUnixNano: String(s.endedAt * 1e6),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: String(value) },
                })),
                status: { code: s.status === "error" ? 2 : s.status === "ok" ? 1 : 0 },
              })),
            },
          ],
        },
      ],
    });
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.warn(`[otel] export ${res.status}: ${(await res.text()).slice(0, 120)}`);
  } catch (e) {
    // 导出失败丢批（链路是观测面，不影响主流程）
    console.warn(`[otel] export failed: ${(e as Error).message}`);
  } finally {
    flushing = false;
    if (spanBuffer.length > 0) void flushSpans();
  }
}

/** 测试辅助：清空缓冲并复位配置。 */
export function resetOtelForTest(): void {
  spanBuffer.length = 0;
  endpoint = null;
  serviceName = "mas";
}
