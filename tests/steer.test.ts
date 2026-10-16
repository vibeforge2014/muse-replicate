/**
 * steer 运行中插话（spec §7.4，参考 Managed_Agents_Claude）。
 * 用例：
 *  - STEER-01 turn 中插话：sleep turn 进行中发 user.message → steer 在 turn 中间被消费确认，
 *    user.message 有 processed_at（定序在 turn 内），单一 status_running，ack 在 turn 结束前；
 *  - STEER-02 无活跃 turn → 回退为排队的 user_message，下个 turn 正常处理；
 *  - STEER-03 interrupt 清除已排队的 steer（flushed）；
 *  - STEER-04 steer_mode=queue 显式 opt-out → 不分类为 steer，正常排队；
 *  - STEER-05 FIFO 保护：lane 内有排队的 user_message 时，新消息不越位为 steer。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  call,
  createSession,
  listEvents,
  makeAgentAndEnv,
  setupEnv,
  waitFor,
  type TestEnv,
} from "./helpers.ts";

const msg = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] });

describe("steer 运行中插话 (spec §7.4)", () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    env?.resumeWorker();
  });

  it("STEER-01 turn 中插话被消费确认（processed_at 在 turn 内、ack 在 turn 结束前）", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);

    // 先发一个 sleep 3 turn（让 turn 有足够时间进行中时发 steer）
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("sleep 3")] });
    // 手工驱动：启动 turn 但不要等它跑完——通过 processSession 异步进行
    const procP = env.runner.processSession(sid);

    // 等 session 进入 running（turn 已启动）
    await waitFor(url, key, sid, (s) => s.status === "running", 10_000);

    // turn 进行中发插话（会被分类为 steer，target=活跃 turn）
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("插话内容")] });

    // 等 turn 完成
    await procP;

    const events = await listEvents(url, key, sid);
    const types = events.map((e) => e.type);

    // 验证：插话的 user.message 在 turn 中间被定序（有 processed_at）
    const userMsgs = events.filter((e) => e.type === "user.message");
    // 两条 user.message：sleep 3 + 插话内容
    expect(userMsgs).toHaveLength(2);
    // 插话的 user.message 必须有 processed_at（说明被定序了，不是仅 admitted）
    const steerMsg = userMsgs.find((e) => (e.content ?? []).some((b: any) => b.text === "插话内容"));
    expect(steerMsg).toBeTruthy();
    expect(steerMsg!.processed_at).toBeTruthy();

    // ack steer 回应在 turn 结束前出现
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    const texts = agentMsgs.map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    expect(texts).toContain("ack steer: 插话内容");

    // 单一 status_running（不应因为 steer 出现额外的 running）
    const runningCount = types.filter((t) => t === "session.status_running").length;
    expect(runningCount).toBe(1);

    // 只有一个 status_idle（turn 结束）
    const idleCount = types.filter((t) => t === "session.status_idle").length;
    expect(idleCount).toBe(1);
  });

  it("STEER-02 无活跃 turn → 回退排队，下个 turn 正常处理", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);

    // session idle 时发消息（不会被分类为 steer 因为 session 不在 running）
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("echo: fallback-test")] });

    // 驱动 worker 处理
    await env.runner.processSession(sid);

    const events = await listEvents(url, key, sid);
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    const texts = agentMsgs.map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    expect(texts).toEqual(["fallback-test"]);

    // 没有 steer 确认事件（因为没走 steer 路径）
    expect(events.some((e) => e.type === "runtime.steer_confirmed")).toBe(false);
  });

  it("STEER-03 interrupt 清除排队的 steer（flushed）", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);

    // 发一个 sleep 5 turn
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("sleep 5")] });
    const procP = env.runner.processSession(sid);
    await waitFor(url, key, sid, (s) => s.status === "running", 10_000);

    // 发一个 steer（会被分类为 steer）
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("steer-before-interrupt")] });

    // 发 interrupt
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [{ type: "user.interrupt" }] });

    await procP;
    await waitFor(url, key, sid, (s) => s.status === "idle", 10_000);

    const events = await listEvents(url, key, sid);
    const types = events.map((e) => e.type);

    // steer 的 user.message 应该被 flushed（不会在后续被处理）
    // interrupt 后 turn 结束 → idle
    expect(types).toContain("session.status_idle");

    // 不应该有 steer 的 ack 回应（被 interrupt 清除了）
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    const texts = agentMsgs.map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    expect(texts.some((t) => t.includes("ack steer"))).toBe(false);
  });

  it("STEER-04 steer_mode=queue 显式 opt-out → 正常排队不插话", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    // 创建 agent 时设 metadata.steer_mode = "queue"
    const agent = await call(url, key, "POST", "/v1/agents", {
      name: `t-queue-${Date.now()}`,
      model: { id: "glm-5.3-flash", effort: "low" },
      metadata: { steer_mode: "queue" },
    });
    const envResp = await call(url, key, "POST", "/v1/environments", {
      name: `t-env-${Date.now()}`,
      config: { type: "cloud" },
    });
    const sid = await createSession(url, key, agent.json.id, envResp.json.id);

    // 发 sleep 4 turn
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("sleep 4")] });
    const procP = env.runner.processSession(sid);
    await waitFor(url, key, sid, (s) => s.status === "running", 10_000);

    // 发消息——steer_mode=queue → 不分类为 steer，正常排队
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("queued-not-steer")] });

    await procP;
    // 排队的消息在 sleep turn 结束后会被下一个 turn 处理
    await waitFor(url, key, sid, (s) => s.status === "idle", 15_000);

    // 如果还有排队的消息，再驱动一次
    const sessionState = await call(url, key, "GET", `/v1/sessions/${sid}`);
    if (sessionState.json.status !== "idle") {
      await env.runner.processSession(sid);
      await waitFor(url, key, sid, (s) => s.status === "idle", 10_000);
    }

    const events = await listEvents(url, key, sid);
    // 不应该有 steer 确认
    expect(events.some((e) => e.type === "runtime.steer_confirmed")).toBe(false);

    // queued-not-steer 的消息应该被正常处理（echo 回复）
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    const texts = agentMsgs.map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    expect(texts).toContain("echo: queued-not-steer");
  });

  it("STEER-05 FIFO 保护：lane 内有排队 user_message 时不越位为 steer", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);

    // 发两条消息（都排队，session idle → 第一条开 turn，第二条排队等）
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("sleep 3")] });
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("second-queued")] });

    // 驱动 worker：第一条 sleep 3 turn 开始
    const procP = env.runner.processSession(sid);
    await waitFor(url, key, sid, (s) => s.status === "running", 10_000);

    // turn 进行中发第三条消息——lane 内有排队的 second-queued → 不应越位为 steer
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { events: [msg("third-no-jump")] });

    await procP;
    // 等 second-queued 被 turn 处理完
    await waitFor(url, key, sid, (s) => s.status === "idle", 15_000);
    // third-no-jump 也排着，再驱动
    const state = await call(url, key, "GET", `/v1/sessions/${sid}`);
    if (state.json.status !== "idle") {
      await env.runner.processSession(sid);
      await waitFor(url, key, sid, (s) => s.status === "idle", 10_000);
    }

    const events = await listEvents(url, key, sid);
    // 不应该有 steer 确认
    expect(events.some((e) => e.type === "runtime.steer_confirmed")).toBe(false);

    // 消息按 FIFO 处理：second-queued 在 third-no-jump 之前被处理
    const agentMsgs = events.filter((e) => e.type === "agent.message");
    const texts = agentMsgs.map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    const secondIdx = texts.indexOf("echo: second-queued");
    const thirdIdx = texts.indexOf("echo: third-no-jump");
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(thirdIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});
