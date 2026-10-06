import { beforeEach, describe, expect, it } from "vitest";
import { call, createSession, listEvents, makeAgentAndEnv, setupEnv, waitFor } from "./helpers.ts";

let url = "";
let key = "";
beforeEach(async () => {
  const env = await setupEnv();
  url = env.url;
  key = env.key;
});

const TOOLSET_ALLOW = [
  { type: "agent_toolset_20260601", default_config: { permission_policy: { type: "always_allow" } } },
];
const TOOLSET_ASK = [
  { type: "agent_toolset_20260601", default_config: { permission_policy: { type: "always_ask" } } },
];

async function waitForRequiresAction(sessionId: string) {
  return waitFor(url, key, sessionId, (s) => s.stop_reason?.type === "requires_action");
}

async function waitForEndTurn(sessionId: string) {
  return waitFor(url, key, sessionId, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
}

describe("TOOL", () => {
  it("TOOL-01: always_allow bash → tool_use(allow) → tool_result", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ALLOW);
    const sid = await createSession(url, key, agentId, envId);
    const nonce = `acc-${Math.floor(Math.random() * 1e9)}`;
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: `run echo ${nonce}` }] }],
    });
    const s = await waitForEndTurn(sid);
    expect(s.stop_reason).toEqual({ type: "end_turn" });
    const events = await listEvents(url, key, sid);
    const toolUse = events.find((e: any) => e.type === "agent.tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse.name).toBe("bash");
    expect(toolUse.evaluated_permission).toBe("allow");
    const toolResult = events.find((e: any) => e.type === "agent.tool_result");
    expect(toolResult).toBeTruthy();
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect(toolResult.content[0].text).toContain(nonce);
    expect(toolResult.is_error).toBe(false);
  });

  it("TOOL-02: no tools → no builtin tool_use", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "run echo x" }] }],
    });
    await waitForEndTurn(sid);
    const events = await listEvents(url, key, sid);
    expect(events.some((e: any) => e.type === "agent.tool_use")).toBe(false);
  });

  it("TOOL-04/05: always_ask → requires_action → allow → completes", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask deploy-prod" }] }],
    });
    const s = await waitForRequiresAction(sid);
    const pendingIds = (s.stop_reason as { event_ids: string[] }).event_ids;
    expect(pendingIds.length).toBeGreaterThanOrEqual(1);
    const events = await listEvents(url, key, sid);
    const toolUse = events.find((e: any) => e.id === pendingIds[0]);
    expect(toolUse.type).toBe("agent.tool_use");
    expect(toolUse.evaluated_permission).toBe("ask");

    // 回送 allow
    const conf = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: pendingIds[0], result: "allow" }],
    });
    expect(conf.status).toBe(200);
    const done = await waitForEndTurn(sid);
    expect(done.stop_reason).toEqual({ type: "end_turn" });
    const events2 = await listEvents(url, key, sid);
    const result = events2.find((e: any) => e.type === "agent.tool_result");
    expect(result.content[0].text).toContain("approved-run:deploy-prod");
  });

  it("TOOL-06: deny + deny_message → tool not executed, agent senses denial", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask rm-rf" }] }],
    });
    const s = await waitForRequiresAction(sid);
    const pendingId = (s.stop_reason as { event_ids: string[] }).event_ids[0];
    const conf = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [
        { type: "user.tool_confirmation", tool_use_id: pendingId, result: "deny", deny_message: "not allowed in prod" },
      ],
    });
    expect(conf.status).toBe(200);
    await waitForEndTurn(sid);
    const events = await listEvents(url, key, sid);
    const result = events.find((e: any) => e.type === "agent.tool_result");
    expect(result.content[0].text).toContain("denied: not allowed in prod");
    const msg = events.filter((e: any) => e.type === "agent.message").pop();
    expect(msg.content[0].text).toContain("denied");
  });

  it("TOOL-07: user.message during requires_action → 400, not queued", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask x" }] }],
    });
    await waitForRequiresAction(sid);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "sneak" }] }],
    });
    expect(r.status).toBe(400);
    // 历史里没有 sneak
    const events = await listEvents(url, key, sid);
    expect(events.some((e: any) => JSON.stringify(e).includes("sneak"))).toBe(false);
  });

  it("TOOL-08: interrupt + message mixed batch during requires_action → 400", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask x" }] }],
    });
    await waitForRequiresAction(sid);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [
        { type: "user.interrupt" },
        { type: "user.message", content: [{ type: "text", text: "m" }] },
      ],
    });
    expect(r.status).toBe(400);
  });

  it("TOOL-09: interrupt during requires_action voids approval; later confirmation → 409", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask later" }] }],
    });
    const s = await waitForRequiresAction(sid);
    const pendingId = (s.stop_reason as { event_ids: string[] }).event_ids[0];
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.interrupt" }],
    });
    expect(r.status).toBe(200);
    await waitForEndTurn(sid);
    // 之后对原 event_ids 提交 confirmation → 409
    const conf = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: pendingId, result: "allow" }],
    });
    expect(conf.status).toBe(409);
  });

  it("TOOL-10: confirmation on resolved tool_use again → 409", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask twice" }] }],
    });
    const s = await waitForRequiresAction(sid);
    const pendingId = (s.stop_reason as { event_ids: string[] }).event_ids[0];
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: pendingId, result: "allow" }],
    });
    await waitForEndTurn(sid);
    const again = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: pendingId, result: "allow" }],
    });
    expect(again.status).toBe(409);
  });

  it("TOOL-11: confirmation to unknown id → 404", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ASK);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ask q" }] }],
    });
    await waitForRequiresAction(sid);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: "sevt_nonexistent", result: "allow" }],
    });
    expect(r.status).toBe(404);
  });

  it("TOOL-15: interrupt during running long task → idle(end_turn), no session.error", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ALLOW);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "sleep 30" }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "running");
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.interrupt" }],
    });
    expect(r.status).toBe(200);
    const s = await waitForEndTurn(sid);
    expect(Date.now() - t0).toBeLessThan(20_000); // 60 秒任务被及时中断
    expect(s.stop_reason).toEqual({ type: "end_turn" });
    const events = await listEvents(url, key, sid);
    expect(events.some((e: any) => e.type === "session.error")).toBe(false);
    const types = events.map((e: any) => e.type);
    // user.interrupt 在 idle 之前出现
    const iInt = types.indexOf("user.interrupt");
    const iIdle = types.lastIndexOf("session.status_idle");
    expect(iInt).toBeGreaterThan(-1);
    expect(iInt).toBeLessThan(iIdle);
  });

  it("ORD-01: queued message during running lands after current turn", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key, TOOLSET_ALLOW);
    const sid = await createSession(url, key, agentId, envId);
    // 第 1 轮：慢任务（用例设计：sleep 后回答，保证 running 窗口足够长）
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "sleep 3" }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "running");
    // 运行中插话：立即返回 processed_at=null（排队语义）
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "echo second" }] }],
    });
    expect(r.status).toBe(200);
    expect(r.json.data[0].processed_at).toBeNull();
    // 两轮都完成（同步 predicate 轮询）
    const deadline = Date.now() + 20_000;
    for (;;) {
      const evs = await listEvents(url, key, sid);
      if (evs.filter((e: any) => e.type === "session.status_idle").length >= 2) break;
      if (Date.now() > deadline) throw new Error("second turn did not complete");
      await new Promise((res) => setTimeout(res, 250));
    }
    const events = await listEvents(url, key, sid);
    const second = events.find((e: any) => e.type === "user.message" && JSON.stringify(e).includes("second"));
    expect(second).toBeTruthy();
    expect(second.processed_at).not.toBeNull();
    // 排队消息出现在第 1 轮 idle 之后，且其后是第 2 轮输出
    const firstIdleIdx = events.findIndex((e: any) => e.type === "session.status_idle");
    const secondIdx = events.indexOf(second);
    expect(secondIdx).toBeGreaterThan(firstIdleIdx);
    const afterSecond = events.slice(secondIdx + 1).map((e: any) => e.type);
    expect(afterSecond).toContain("session.status_running");
    expect(afterSecond).toContain("agent.message");
  });
});
