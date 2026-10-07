import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  configureOtel,
  flushSpans,
  formatTraceparent,
  otelEnabled,
  parseTraceparent,
  resetOtelForTest,
  spanBuffer,
  spanTraceparent,
  startSpan,
} from "@mas/core";
import { call, createSession, makeAgentAndEnv, setupEnv, waitFor } from "./helpers.ts";

/** OTLP/HTTP JSON 接收器（当作 collector）。 */
const sinkBodies: string[] = [];
let sink: Server | null = null;
let sinkUrl = "";

beforeAll(async () => {
  sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url?.endsWith("/v1/traces")) {
        sinkBodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => sink!.listen(0, "127.0.0.1", resolve));
  sinkUrl = `http://127.0.0.1:${(sink!.address() as { port: number }).port}`;
  // 必须在 setupEnv（首次 buildApp）之前设置：buildApp 启动时 configureOtel；
  // 这里先显式配置，使未触达 api 的用例也能导出
  process.env.MAS_OTLP_ENDPOINT = sinkUrl;
  process.env.MAS_OTLP_SERVICE_NAME = "mas-test";
  configureOtel(process.env);
});

afterAll(async () => {
  resetOtelForTest();
  delete process.env.MAS_OTLP_ENDPOINT;
  delete process.env.MAS_OTLP_SERVICE_NAME;
  await new Promise<void>((resolve) => sink?.close(() => resolve()));
});

describe("W3C traceparent 解析（spec §16）", () => {
  it("合法头解析 + format 往返", () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const ctx = parseTraceparent(tp);
    expect(ctx).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" });
    expect(formatTraceparent(ctx!)).toBe(tp);
  });

  it("大写/空白容忍；全零 id、版本 ff、乱码拒绝", () => {
    expect(parseTraceparent("  00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")?.traceId)
      .toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
    expect(parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });
});

describe("span 层级 + OTLP 导出", () => {
  it("startSpan 父子串联 + spanTraceparent 供下游", () => {
    const parent = startSpan("p", { k: "v" });
    const child = startSpan("c", {}, spanTraceparent(parent));
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    child.end(true, { outcome: "done" });
    parent.end(false);
    const exported = spanBuffer.filter((s) => s.spanId === parent.spanId || s.spanId === child.spanId);
    expect(exported).toHaveLength(2);
    expect(exported.find((s) => s.name === "p")?.status).toBe("error");
    expect(exported.find((s) => s.name === "c")?.status).toBe("ok");
  });

  it("flushSpans → OTLP/HTTP JSON（v1/traces，service.name）", async () => {
    expect(otelEnabled()).toBe(true);
    const s = startSpan("otel.sink.probe", { n: 1 });
    s.end(true);
    await flushSpans();
    expect(sinkBodies.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(sinkBodies[sinkBodies.length - 1]!);
    expect(last.resourceSpans).toHaveLength(1);
    expect(last.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "mas-test" },
    });
    const spans = last.resourceSpans[0].scopeSpans[0].spans as { name: string; traceId: string }[];
    expect(spans.some((x) => x.name === "otel.sink.probe" && x.traceId === s.traceId)).toBe(true);
  });
});

describe("链路贯穿 api → PG → worker → driver（spec §16 traceparent 跟随 command）", () => {
  it("POST events 带 traceparent 头 → execution 落链路 → worker/turn span 同 trace 且逐级为父子", async () => {
    const env = await setupEnv();
    const { url, key, db } = env;
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const remoteSpanId = "00f067aa0ba902b7";
    const tp = `00-${traceId}-${remoteSpanId}-01`;

    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    }, { traceparent: tp });
    await waitFor(url, key, sid, (s) => s.status === "idle" && (s.stop_reason?.type === "end_turn" || s.stop_reason?.type === "requires_action"));

    // 1) api 请求 span：入口头为父
    const apiSpan = spanBuffer.filter((s) => s.name === "mas.api.request" && s.traceId === traceId);
    expect(apiSpan.length).toBeGreaterThanOrEqual(1);
    const post = apiSpan.find((s) => String(s.attributes["url.path"] ?? "").includes("/events"))!;
    expect(post.parentSpanId).toBe(remoteSpanId);
    expect(post.attributes["http.response.status_code"]).toBe(200);

    // 2) traceparent 落在 execution 上（PG 串联载体）
    const exec = await db.db
      .selectFrom("session_executions")
      .select(["id", "traceparent"])
      .where("session_id", "=", sid)
      .executeTakeFirst();
    expect(exec?.traceparent).toBe(formatTraceparent({ traceId: post.traceId, spanId: post.spanId }));

    // 3) worker span 以 execution.traceparent 为父；turn_loop 再挂其下
    const workerSpan = spanBuffer.find(
      (s) => s.name === "mas.worker.execution" && s.traceId === traceId && s.attributes["session_id"] === sid,
    );
    expect(workerSpan).toBeDefined();
    expect(workerSpan!.parentSpanId).toBe(post.spanId);
    expect(workerSpan!.attributes["execution_id"]).toBe(exec?.id);
    const loopSpan = spanBuffer.find(
      (s) => s.name === "mas.worker.turn_loop" && s.traceId === traceId && s.parentSpanId === workerSpan!.spanId,
    );
    expect(loopSpan).toBeDefined();
    expect(workerSpan!.status).toBe("ok");

    // 4) 全链路出现在 OTLP 导出里
    await flushSpans();
    const names = sinkBodies.flatMap((b) => {
      const j = JSON.parse(b);
      return (j.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? []).map((x: { name: string; traceId: string }) => `${x.traceId}:${x.name}`);
    });
    expect(names).toContain(`${traceId}:mas.api.request`);
    expect(names).toContain(`${traceId}:mas.worker.execution`);
    expect(names).toContain(`${traceId}:mas.worker.turn_loop`);
  }, 30_000);
});
