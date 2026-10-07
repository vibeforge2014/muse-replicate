import { beforeAll, describe, expect, test } from "vitest";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * CT：自定义工具（custom tools，spec Q5 / §7.3 例外 / 二期 dynamicTools 的平台侧形态）。
 * agent.tools 声明 {type:"custom"} 工具 → runtime 调用产生 agent.custom_tool_use +
 * idle(requires_action) → 业务方回 user.custom_tool_result（api 即时定序）→ runtime 续轮完成。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function makeCustomToolAgent(): Promise<{ agentId: string; envId: string }> {
  const agent = await call(url, key, "POST", "/v1/agents", {
    name: `ct-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    model: { id: "glm-5.3-flash", effort: "low" },
    tools: [
      {
        type: "custom",
        name: "weather",
        description: "query weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
  });
  expect(agent.status).toBe(201);
  // 声明在响应里完整保留（normalizeAgentTools 不破坏 custom 变体）
  const declared = (agent.json.tools as { type: string; name?: string; input_schema?: unknown }[]).find(
    (t) => t.type === "custom",
  );
  expect(declared?.name).toBe("weather");
  expect(declared?.input_schema).toMatchObject({ type: "object" });
  const e = await call(url, key, "POST", "/v1/environments", {
    name: `ct-env-${Date.now()}`,
    config: { type: "cloud" },
  });
  return { agentId: agent.json.id, envId: e.json.id };
}

function sendEvents(sessionId: string, events: unknown[]) {
  return call(url, key, "POST", `/v1/sessions/${sessionId}/events`, { events });
}

describe("自定义工具（CT）", () => {
  test("CT-01 端到端：custom_tool_use → requires_action → 即时定序的 custom_tool_result → 续轮完成", async () => {
    const { agentId, envId } = await makeCustomToolAgent();
    const s = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: 'tool weather {"city":"北京"}' }] }],
    });
    expect(s.status).toBe(200);
    const sid = s.json.id;

    // 第一轮：custom_tool_use + idle(requires_action)
    const idle = await waitFor(url, key, sid, (x: { status: string; stop_reason: { type?: string; event_ids?: string[] } }) =>
      x.status === "idle" && x.stop_reason?.type === "requires_action" && (x.stop_reason.event_ids?.length ?? 0) > 0,
    );
    const toolUseId = idle.stop_reason.event_ids[0] as string;

    const events1 = await call(url, key, "GET", `/v1/sessions/${sid}/events`);
    const use = events1.json.data.find((e: { type: string }) => e.type === "agent.custom_tool_use");
    expect(use).toBeTruthy();
    expect(use.name).toBe("weather");
    expect(use.input).toMatchObject({ city: "北京" });

    // requires_action 下 user.message 被拒（沿 TOOL-07 语义）
    const rejected = await sendEvents(sid, [{ type: "user.message", content: [{ type: "text", text: "hi" }] }]);
    expect(rejected.status).toBe(400);

    // 回结果：响应即带 processed_at（§7.3 例外：收到即处理）
    const res = await sendEvents(sid, [
      { type: "user.custom_tool_result", tool_use_id: toolUseId, output: "晴，26°C" },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.data[0].type).toBe("user.custom_tool_result");
    expect(res.json.data[0].processed_at).toBeTruthy();

    // 续轮完成：agent.message 带结果，最终 idle(end_turn)
    const done = await waitFor(url, key, sid, (x: { status: string; stop_reason: { type?: string } }) =>
      x.status === "idle" && x.stop_reason?.type === "end_turn",
    );
    expect(done.status).toBe("idle");
    const events2 = await call(url, key, "GET", `/v1/sessions/${sid}/events`);
    const finalMsg = [...events2.json.data]
      .filter((e: { type: string }) => e.type === "agent.message")
      .pop();
    expect(finalMsg.content[0].text).toContain("custom tool weather result: 晴，26°C");
    // custom_tool_result 在历史中已定序（processed_at 有值），且排在最终 idle 之前
    const idxCtr = events2.json.data.findIndex((e: { type: string }) => e.type === "user.custom_tool_result");
    const idxFinalIdle = events2.json.data.map((e: { type: string }) => e.type).lastIndexOf("session.status_idle");
    expect(idxCtr).toBeGreaterThan(-1);
    expect(idxCtr).toBeLessThan(idxFinalIdle);
    expect(events2.json.data[idxCtr].processed_at).toBeTruthy();
  });

  test("CT-02 目标校验：不存在的 tool_use 404；指向非 custom 事件 400；不在等待中 409", async () => {
    const { agentId, envId } = await makeCustomToolAgent();
    const s = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
    });
    const sid = s.json.id;
    await sendEvents(sid, [{ type: "user.message", content: [{ type: "text", text: "echo hello" }] }]);
    await waitFor(url, key, sid, (x: { status: string; stop_reason: unknown }) => x.status === "idle" && x.stop_reason !== null);

    // idle(end_turn) 下发送：目标事件不存在 → 404
    const r1 = await sendEvents(sid, [
      { type: "user.custom_tool_result", tool_use_id: "sevt_does_not_exist", output: "x" },
    ]);
    expect(r1.status).toBe(404);

    // 目标是 user.message（非 agent.custom_tool_use）→ 400
    const events = await call(url, key, "GET", `/v1/sessions/${sid}/events`);
    const someEvent = events.json.data.find((e: { type: string }) => e.type === "user.message");
    const r2 = await sendEvents(sid, [
      { type: "user.custom_tool_result", tool_use_id: someEvent.id, output: "x" },
    ]);
    expect(r2.status).toBe(400);
  });

  test("CT-03 未在等待时发送（历史 tool_use 已被消费过）→ 409", async () => {
    const { agentId, envId } = await makeCustomToolAgent();
    const s = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: 'tool weather {"city":"上海"}' }] }],
    });
    const sid = s.json.id;
    const idle = await waitFor(url, key, sid, (x: { status: string; stop_reason: { type?: string; event_ids?: string[] } }) =>
      x.status === "idle" && x.stop_reason?.type === "requires_action",
    );
    const toolUseId = idle.stop_reason.event_ids[0] as string;

    // 正常回一次结果，轮次完成
    await sendEvents(sid, [{ type: "user.custom_tool_result", tool_use_id: toolUseId, output: "多云" }]);
    await waitFor(url, key, sid, (x: { status: string; stop_reason: { type?: string } }) =>
      x.status === "idle" && x.stop_reason?.type === "end_turn",
    );

    // 同一 tool_use_id 再回一次 → 已不在等待中 → 409
    const r = await sendEvents(sid, [{ type: "user.custom_tool_result", tool_use_id: toolUseId, output: "again" }]);
    expect(r.status).toBe(409);
  });

  test("CT-04 requires_action 时 interrupt：未决 custom tool 作废，最终 idle(end_turn)", async () => {
    const { agentId, envId } = await makeCustomToolAgent();
    const s = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: 'tool weather {"city":"深圳"}' }] }],
    });
    const sid = s.json.id;
    const idle = await waitFor(url, key, sid, (x: { status: string; stop_reason: { type?: string } }) =>
      x.status === "idle" && x.stop_reason?.type === "requires_action",
    );
    expect(idle.stop_reason.type).toBe("requires_action");

    const r = await sendEvents(sid, [{ type: "user.interrupt" }]);
    expect(r.status).toBe(200);

    const done = await waitFor(url, key, sid, (x: { status: string; stop_reason: { type?: string } }) =>
      x.status === "idle" && x.stop_reason?.type === "end_turn",
    );
    expect(done.status).toBe("idle");
    const events = await call(url, key, "GET", `/v1/sessions/${sid}/events`);
    const finalMsg = [...events.json.data].filter((e: { type: string }) => e.type === "agent.message").pop();
    expect(finalMsg.content[0].text).toContain("aborted by interrupt");
  });

  test("CT-05 agent 声明校验：custom 工具 name 非法 / input_schema 缺失 → 400", async () => {
    const bad1 = await call(url, key, "POST", "/v1/agents", {
      name: `ct-bad-${Date.now()}`,
      model: { id: "glm-5.3-flash" },
      tools: [{ type: "custom", name: "not allowed!", input_schema: {} }],
    });
    expect(bad1.status).toBe(400);

    const bad2 = await call(url, key, "POST", "/v1/agents", {
      name: `ct-bad2-${Date.now()}`,
      model: { id: "glm-5.3-flash" },
      tools: [{ type: "custom", name: "ok_name" }],
    });
    expect(bad2.status).toBe(400);
  });
});
