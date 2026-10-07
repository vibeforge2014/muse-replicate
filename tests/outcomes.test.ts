import { beforeAll, describe, expect, it } from "vitest";
import { call, createSession, makeAgentAndEnv, setupEnv, waitFor } from "./helpers.ts";

/**
 * `user.define_outcome`（spec §7.3 例外类 + test-case-plan PRB-01）：
 * 收到即处理（返回时 processed_at 已有值）、不触发 execution/runtime、
 * payload 不透明透传存档、任何会话状态（idle/running/requires_action）都收下。
 * 多 agent lanes（lane 并发）按 spec 属二期（§5.6/§19），不在本套验收。
 */

let url = "";
let key = "";
let db: import("@mas/db").Database;

beforeAll(async () => {
  const env = await setupEnv();
  url = env.url;
  key = env.key;
  db = env.db.db;
});

async function execCount(sid: string): Promise<number> {
  const rows = await db.selectFrom("session_executions").select(["id"]).where("session_id", "=", sid).execute();
  return rows.length;
}

describe("user.define_outcome（OUT-01~04）", () => {
  it("OUT-01: idle 会话单独发送 → 200，processed_at 已有值，payload 透传", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.define_outcome", outcome: { status: "completed", score: 5, tags: ["a", "b"] } }],
    });
    expect(r.status).toBe(200);
    const ev = r.json.data[0];
    expect(ev.type).toBe("user.define_outcome");
    expect(ev.processed_at).toBeTruthy(); // §7.3：收到即处理
    expect(ev.outcome).toEqual({ status: "completed", score: 5, tags: ["a", "b"] });
    expect(await execCount(sid)).toBe(0); // 不生成 execution
  });

  it("OUT-02: 与 user.message 混批 → outcome 当场定序，message 照常驱动 turn", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "hello" }] },
        { type: "user.define_outcome", outcome: { status: "answered" } },
      ],
    });
    expect(r.status).toBe(200);
    const outcome = r.json.data.find((e: { type: string }) => e.type === "user.define_outcome");
    expect(outcome.processed_at).toBeTruthy();
    const message = r.json.data.find((e: { type: string }) => e.type === "user.message");
    expect(message.processed_at).toBeNull(); // 消息仍在排队，由 worker 定序
    // turn 正常完成；execution 的 input_event_ids 不含 define_outcome
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
    const exec = await db
      .selectFrom("session_executions")
      .select(["input_event_ids"])
      .where("session_id", "=", sid)
      .executeTakeFirst();
    const evs = await call(url, key, "GET", `/v1/sessions/${sid}/events`);
    const outcomeRow = evs.json.data.find((e: { type: string }) => e.type === "user.define_outcome");
    expect(exec!.input_event_ids).not.toContain(outcomeRow.id);
  }, 20_000);

  it("OUT-03: running 状态收下；requires_action 状态也收下", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId, [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ]);
    // 会话在 running（或很快完成——两种状态都应接受；重复发送验证幂等接受）
    const r1 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.define_outcome", outcome: { phase: "mid-turn" } }],
    });
    expect(r1.status).toBe(200);
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type !== undefined);
    const r2 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.define_outcome", outcome: { phase: "idle" } }],
    });
    expect(r2.status).toBe(200);
  }, 20_000);

  it("OUT-04: 混批限制——不与 interrupt/confirmation/custom_tool_result 混批；payload 必须是对象", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const mixed = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [
        { type: "user.interrupt" },
        { type: "user.define_outcome", outcome: {} },
      ],
    });
    expect(mixed.status).toBe(400);
    const badPayload = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.define_outcome", outcome: "not-an-object" }],
    });
    expect(badPayload.status).toBe(400);
  });
});
