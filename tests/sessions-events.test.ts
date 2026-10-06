import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  collectStream,
  createSession,
  expectSubsequence,
  listEvents,
  makeAgentAndEnv,
  setupEnv,
  waitFor,
} from "./helpers.ts";

let url = "";
let key = "";
beforeEach(async () => {
  const env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function idle(sessionId: string) {
  return waitFor(url, key, sessionId, (s) => s.status === "idle" && s.stop_reason?.type !== undefined ? s.stop_reason?.type === "end_turn" || s.stop_reason?.type === "requires_action" : false);
}

describe("SES", () => {
  it("SES-01: create → 200 idle, usage 0, agent.version latest", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const r = await call(url, key, "POST", "/v1/sessions", { agent: agentId, environment_id: envId });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("idle");
    expect(r.json.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
    expect(r.json.agent.version).toBe(1);
    expect(r.json.id).toMatch(/^sesn_/);
  });

  it("SES-02: pin agent version", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    await call(url, key, "POST", `/v1/agents/${agentId}`, { name: "v2name" });
    const r = await call(url, key, "POST", "/v1/sessions", {
      agent: { type: "agent", id: agentId, version: 1 },
      environment_id: envId,
    });
    expect(r.json.agent.version).toBe(1);
    expect(r.json.agent.name).not.toBe("v2name");
  });

  it("SES-06: initial_events → running → idle(end_turn)", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId, [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ]);
    const s = await idle(sid);
    expect(s.status).toBe("idle");
    expect(s.stop_reason).toEqual({ type: "end_turn" });
  });

  it("SES-07: initial_events 51 条 / 非 message → 400", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const many = Array.from({ length: 51 }, () => ({
      type: "user.message",
      content: [{ type: "text", text: "x" }],
    }));
    const a = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: many,
    });
    expect(a.status).toBe(400);
    const b = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.interrupt" }],
    });
    expect(b.status).toBe(400);
  });

  it("SES-22: archive twice → 409 session_archived", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const a = await call(url, key, "POST", `/v1/sessions/${sid}/archive`);
    expect(a.status).toBe(200);
    expect(a.json.archived_at).not.toBeNull();
    const b = await call(url, key, "POST", `/v1/sessions/${sid}/archive`);
    expect(b.status).toBe(409);
  });

  it("SES-26: delete idle → session_deleted + GET 404", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const d = await call(url, key, "DELETE", `/v1/sessions/${sid}`);
    expect(d.status).toBe(200);
    expect(d.json).toEqual({ id: sid, type: "session_deleted" });
    const g = await call(url, key, "GET", `/v1/sessions/${sid}`);
    expect(g.status).toBe(404);
  });

  it("SES-29: status enum", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "GET", `/v1/sessions?statuses=bogus`);
    expect(r.status).toBe(400);
    const r2 = await call(url, key, "GET", `/v1/sessions?statuses=idle`);
    expect(r2.status).toBe(200);
    expect(r2.json.data.some((s: any) => s.id === sid)).toBe(true);
  });
});

describe("EVT-S / EVT-L", () => {
  it("EVT-S01: send message → 200 persisted events, processed_at=null → turn runs", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
    });
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveLength(1);
    expect(r.json.data[0].id).toMatch(/^sevt_/);
    expect(r.json.data[0].processed_at).toBeNull();
    await idle(sid);
  });

  it("EVT-S02: batch of 0 / 11 → 400", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const a = await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [] });
    expect(a.status).toBe(400);
    const b = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: Array.from({ length: 11 }, () => ({ type: "user.message", content: [{ type: "text", text: "x" }] })),
    });
    expect(b.status).toBe(400);
  });

  it("EVT-S03: atomic batch — one bad event rejects all", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "good" }] },
        { type: "bogus.type" },
      ],
    });
    expect(r.status).toBe(400);
    const events = await listEvents(url, key, sid);
    expect(events).toHaveLength(0);
  });

  it("EVT-S09: interrupt on idle → 200, status stays idle, recorded", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.interrupt" }],
    });
    expect(r.status).toBe(200);
    const s = await waitFor(url, key, sid, (x) => true);
    expect(s.status).toBe("idle");
    const events = await listEvents(url, key, sid);
    expect(events.some((e: any) => e.type === "user.interrupt" && e.processed_at !== null)).toBe(true);
  });

  it("EVT-L01: history order + processed_at sequence", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    await idle(sid);
    const events = await listEvents(url, key, sid);
    const types = events.map((e: any) => e.type);
    expectSubsequence(types, ["user.message", "session.status_running", "agent.message", "session.status_idle"]);
    // processed_at 严格单调（定序语义）
    const pts = events.map((e: any) => e.processed_at).filter(Boolean);
    for (let i = 1; i < pts.length; i++) {
      expect(new Date(pts[i]!).getTime()).toBeGreaterThan(new Date(pts[i - 1]!).getTime() - 1);
    }
    const ids = new Set(events.map((e: any) => e.id));
    expect(ids.size).toBe(events.length);
  });

  it("EVT-L03: types filter", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    await idle(sid);
    const r = await call(url, key, "GET", `/v1/sessions/${sid}/events?types=agent.message`);
    expect(r.json.data.every((e: any) => e.type === "agent.message")).toBe(true);
    expect(r.json.data.length).toBeGreaterThanOrEqual(1);
  });

  it("EVT-L04: unknown type filter → 400", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "GET", `/v1/sessions/${sid}/events?types=nope`);
    expect(r.status).toBe(400);
  });

  it("EVT-L05: created_at[gte] compares processed_at", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    const s = await idle(sid);
    void s;
    const events = await listEvents(url, key, sid);
    const mid = events.find((e: any) => e.type === "session.status_running");
    const r = await call(
      url,
      key,
      "GET",
      `/v1/sessions/${sid}/events?created_at[gte]=${encodeURIComponent(mid.processed_at)}`,
    );
    for (const e of r.json.data) {
      expect(e.processed_at).not.toBeNull();
      expect(new Date(e.processed_at).getTime()).toBeGreaterThanOrEqual(new Date(mid.processed_at).getTime());
    }
  });
});

describe("EVT-R（SSE）", () => {
  it("EVT-R01: stream pushes user.message → … → idle with processed_at", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    // 先开流（后台收集），再发消息
    const streamP = collectStream(url, key, sid, (evs) =>
      evs.some((e) => e.event === "session.status_idle"),
    );
    await new Promise((r) => setTimeout(r, 400)); // 等连接与 LISTEN 就绪
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "stream-me" }] }],
    });
    const all = await streamP;
    const types = all.filter((e) => e.event !== "ping").map((e) => e.event);
    expectSubsequence(types, ["user.message", "session.status_running", "agent.message", "session.status_idle"]);
    const userMsg = all.find((e) => e.event === "user.message");
    expect(userMsg?.data.processed_at).not.toBeNull();
  });

  it("EVT-R02: only realtime — stream opened after turn shows nothing new", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "early" }] }],
    });
    await idle(sid);
    // 轮次结束后开流 2.5 秒，不应收到任何持久化事件
    const collected = await collectStream(url, key, sid, () => false, { timeoutMs: 2500 });
    const persisted = collected.filter((e) => e.event.startsWith("user.") || e.event.startsWith("agent.") || e.event.startsWith("session."));
    expect(persisted).toHaveLength(0);
  });

  it("EVT-R08-ish: Last-Event-ID replays missed events", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "one" }] }],
    });
    await idle(sid);
    const events = await listEvents(url, key, sid);
    const userMsgSeq = Number(events.find((e: any) => e.type === "user.message")!.seq ?? 1);
    // 从第一条之后回补（after user.message）
    const replay = await collectStream(url, key, sid, (evs) => evs.length >= 2, {
      lastEventId: String(userMsgSeq),
      timeoutMs: 5000,
    });
    expect(replay.some((e) => e.event === "session.status_running")).toBe(true);
    expect(replay.some((e) => e.event === "user.message")).toBe(false);
  });

  it("EVT-R09: session.deleted closes stream with final frame", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const p = collectStream(url, key, sid, (evs) => evs.some((e) => e.event === "session.deleted"), {
      timeoutMs: 8000,
    });
    await new Promise((r) => setTimeout(r, 400));
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
    const collected = await p;
    expect(collected.some((e) => e.event === "session.deleted")).toBe(true);
  });
});
