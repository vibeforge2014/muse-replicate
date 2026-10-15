/**
 * multiagent lanes（spec §5.6 二期）：lane_id=thread_id，同 lane 严格 FIFO、跨 lane 并发。
 * 用例：
 *  - LANE-01 API lane_id 校验与缺省 main；
 *  - LANE-02 同 lane FIFO claim + pendingLanes + 跨 lane claim 隔离；
 *  - LANE-03 跨 lane 并发推进（两个 sleep 并行，串行会翻倍）+ 事件按 thread 分流隔离
 *    + 单会话单 runtime 进程 + lane thread 持久化；
 *  - LANE-04 热会话加 lane：复用同一进程（不 respawn）；
 *  - LANE-05 同 lane 两执行严格串行（前一个 settle 后一个才 claim）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNextExecution, getLaneThreadId, pendingLanes, settleExecution } from "@mas/db";
import {
  call,
  createSession,
  listEvents,
  makeAgentAndEnv,
  setupEnv,
  type TestEnv,
} from "./helpers.ts";

const msg = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] });

describe("multiagent lanes (spec §5.6 二期)", () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    // 无论用例成败都恢复后台 drain（测试环境全局共享）
    env?.resumeWorker();
  });

  it("LANE-01 lane_id 校验与缺省 main", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);

    const bad = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      lane_id: "Main",
      events: [msg("echo: hi")],
    });
    expect(bad.status).toBe(400);

    const bad2 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      lane_id: "has space",
      events: [msg("echo: hi")],
    });
    expect(bad2.status).toBe(400);

    const named = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      lane_id: "alpha",
      events: [msg("echo: via-lane")],
    });
    expect(named.status).toBe(200);

    const def = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [msg("echo: default-main")],
    });
    expect(def.status).toBe(200);

    const lanes = (await pendingLanes(env.db.db, sid)).sort();
    expect(lanes).toEqual(["alpha", "main"]);
  });

  it("LANE-02 同 lane FIFO claim + pendingLanes + 跨 lane claim 隔离", async () => {
    env = await setupEnv();
    const { url, key, db } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "alpha", events: [msg("echo: a1")] });
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "alpha", events: [msg("echo: a2")] });
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "beta", events: [msg("echo: b1")] });

    expect((await pendingLanes(db.db, sid)).sort()).toEqual(["alpha", "beta"]);

    const textOf = async (ids: string[]): Promise<string[]> => {
      const events = await listEvents(url, key, sid);
      return events
        .filter((e) => ids.includes(e.id))
        .map((e) => (e.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
    };

    // 同 lane 严格 FIFO：alpha 依次 claim 到 a1、a2，第三次为空；beta 不受 alpha 影响
    const c1 = await claimNextExecution(db.db, sid, "w_lane", "att_1", 30, "alpha");
    expect(c1).not.toBeNull();
    expect(await textOf(c1!.input_event_ids)).toEqual(["echo: a1"]);
    const c2 = await claimNextExecution(db.db, sid, "w_lane", "att_2", 30, "alpha");
    expect(c2).not.toBeNull();
    expect(await textOf(c2!.input_event_ids)).toEqual(["echo: a2"]);
    // fresh lease 下不能再 claim（排除被占用的执行）
    expect(await claimNextExecution(db.db, sid, "w_lane", "att_3", 30, "alpha")).toBeNull();
    const cb = await claimNextExecution(db.db, sid, "w_lane", "att_4", 30, "beta");
    expect(cb).not.toBeNull();
    expect(await textOf(cb!.input_event_ids)).toEqual(["echo: b1"]);

    // 收尾清理：把手工 claim 的执行 settle，避免 30s 后重放
    for (const c of [c1!, c2!, cb!]) {
      await settleExecution(db.db, c.id, c.generation, c.attempt_id!, { state: "completed" });
    }
  });

  it("LANE-03 跨 lane 并发 + 事件分流隔离 + 单进程共享 + lane thread 持久化", async () => {
    env = await setupEnv();
    const { url, key, db } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "alpha", events: [msg("sleep 2")] });
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "beta", events: [msg("beta-here")] });

    const t0 = Date.now();
    await env.runner.processSession(sid);
    const elapsed = Date.now() - t0;
    // 两个 lane 并行：约等于最长 lane（2s）；串行会是 2s+0.1s+开销
    expect(elapsed).toBeLessThan(3300);

    const events = await listEvents(url, key, sid);
    const texts = events
      .filter((e) => e.type === "agent.message")
      .map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    // sleep lane 只产生状态事件（无 agent.message）；echo lane 的回复正确分流
    expect(texts).toEqual(["echo: beta-here"]);

    // 单会话单共享进程：fake 的 runtime-host.txt 每进程启动写一行
    const hostFile = join(tmpdir(), "mas-fake-codex", sid, "runtime-host.txt");
    expect(existsSync(hostFile)).toBe(true);
    expect(readFileSync(hostFile, "utf8").trim().split("\n")).toHaveLength(1);

    // lane thread 持久化：两 lane 各有自己的 thread id
    const ta = await getLaneThreadId(db.db, sid, "alpha");
    const tb = await getLaneThreadId(db.db, sid, "beta");
    expect(ta).toBeTruthy();
    expect(tb).toBeTruthy();
    expect(ta).not.toBe(tb);
  });

  it("LANE-04 热会话加 lane：复用共享进程，不 respawn", async () => {
    env = await setupEnv();
    const { url, key } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "alpha", events: [msg("echo: warm-a")] });
    await env.runner.processSession(sid);

    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "gamma", events: [msg("echo: warm-g")] });
    await env.runner.processSession(sid);

    const events = await listEvents(url, key, sid);
    const texts = events
      .filter((e) => e.type === "agent.message")
      .map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    expect(texts).toEqual(["warm-a", "warm-g"]);
    const hostFile = join(tmpdir(), "mas-fake-codex", sid, "runtime-host.txt");
    // warm 阶段复用同一进程：仍只有一行（没有为 gamma respawn）
    expect(readFileSync(hostFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("LANE-05 同 lane 两执行严格串行（settle 后才 claim 下一个）", async () => {
    env = await setupEnv();
    const { url, key, db } = env;
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "alpha", events: [msg("sleep 1")] });
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, { lane_id: "alpha", events: [msg("echo: after-sleep")] });

    const t0 = Date.now();
    await env.runner.processSession(sid);
    // 同 lane FIFO：1s 的 sleep 先跑完，echo 才开始 → 总时长 ≥1s
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);

    const rows = await db.db
      .selectFrom("session_executions")
      .select(["id", "claimed_at", "settled_at", "delivered_at"])
      .where("session_id", "=", sid)
      .orderBy("admitted_at", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    // 前一个执行 settle 之后，下一个才被 claim（严格 FIFO）
    expect(rows[0]!.settled_at!.getTime()).toBeLessThanOrEqual(rows[1]!.claimed_at!.getTime());

    const events = await listEvents(url, key, sid);
    const texts = events
      .filter((e) => e.type === "agent.message")
      .map((e) => (e.content ?? []).map((b: any) => b.text).join(""));
    expect(texts).toEqual(["after-sleep"]);
  });
});
