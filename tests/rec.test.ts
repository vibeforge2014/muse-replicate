import { beforeAll, describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reapExhaustedExecutions } from "@mas/db";
import {
  call,
  createSession,
  listEvents,
  makeAgentAndEnv,
  setupEnv,
  waitFor,
  type TestEnv,
} from "./helpers.ts";

/**
 * REC 系列：可靠性验收（test-case-plan 第 8 章）。
 * REC-08/09/10（输出清单 / 沙箱逃逸 / 会话级 digest）依赖未实现的基础设施，按计划跳过。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function postMessage(sid: string, text: string, headers: Record<string, string> = {}) {
  return call(url, key, "POST", `/v1/sessions/${sid}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  }, headers);
}

/** 模拟 worker A 在某状态崩溃：直接改写执行行（绕过 runner）。 */
async function killExecutionAs(sid: string, patch: { delivered: boolean; interrupted?: boolean; exhausted?: boolean }) {
  await env.db.db
    .updateTable("session_executions")
    .set({
      state: "delivered",
      delivered_at: new Date(),
      claimed_at: new Date(),
      owner_id: "worker_dead",
      attempt_id: "att_dead",
      generation: 1,
      attempt_count: patch.exhausted ? 5 : 1,
      lease_expires_at: new Date(Date.now() - 2000),
      ...(patch.interrupted ? { interrupt_requested_at: new Date() } : {}),
    })
    .where("session_id", "=", sid)
    .where("state", "=", "queued")
    .execute();
}

/** 轮询历史事件直到条件满足（新会话初始即 idle，不能拿 status==idle 当完成信号）。 */
async function waitForEvents(
  sid: string,
  pred: (events: any[]) => boolean,
  timeoutMs = 15_000,
): Promise<any[]> {
  const start = Date.now();
  for (;;) {
    const events = await listEvents(url, key, sid);
    if (pred(events)) return events;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForEvents timeout; got ${JSON.stringify(events.map((e) => e.type))}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function internalEvents(sid: string) {
  return env.db.db
    .selectFrom("session_internal_events")
    .select(["type", "payload"])
    .where("session_id", "=", sid)
    .orderBy("created_at", "asc")
    .execute();
}

describe("REC 可靠性验收", () => {
  test("REC-01 worker 崩溃接管：已投递消息不重放，terminal error", async () => {
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const r = await postMessage(sid, "hello-takeover");
    expect(r.status).toBe(200);

    // worker A 在 delivered 之后崩溃（租约已过期）
    await killExecutionAs(sid, { delivered: true });
    env.resumeWorker();

    const events = await waitForEvents(sid, (es) => es.some((e) => e.type === "session.error"));
    const types = events.map((e) => e.type);

    // 用户消息可见（已定序），但绝不重放：无任何 agent 产出
    expect(types).toContain("user.message");
    expect(types).not.toContain("agent.message");
    expect(types).not.toContain("agent.tool_use");
    const err = events.find((e) => e.type === "session.error");
    expect(err?.error?.retry_status).toBe("terminal");
    expect(err?.error?.type).toBe("worker_takeover");

    // 执行已 settle，不再出现在工作队列
    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["state"])
      .where("session_id", "=", sid)
      .execute();
    expect(exec.every((e) => e.state === "completed" || e.state === "failed")).toBe(true);
  });

  test("REC-02 持久化中断被接管 worker 遵守", async () => {
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "sleep 10");

    // worker A 已投递消息且中断被记录，随后崩溃
    await killExecutionAs(sid, { delivered: true, interrupted: true });
    env.resumeWorker();

    const events = await waitForEvents(sid, (es) => es.some((e) => e.type === "session.status_idle"));
    const idle = events.find((e) => e.type === "session.status_idle");
    expect(idle?.stop_reason?.type).toBe("end_turn");

    // 未启动新 turn：无 agent 产出，无运行时事件
    expect(events.map((e) => e.type)).not.toContain("agent.message");
    const err = events.find((e) => e.type === "session.error");
    expect(err?.error?.retry_status).not.toBe("terminal"); // 正常收尾，无接管错误
  });

  test("REC-03 checkpoint 发布前崩溃 → 水位线不一致 → Level 0 语义恢复", async () => {
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "first-turn");

    // worker A：轮完成、settle 完成，但在 checkpoint CAS 发布前崩溃
    const a = env.newRunner("worker_a", { crashBeforeCheckpointPublish: true });
    await expect(a.processSession(sid)).rejects.toThrow("crash before checkpoint publish");
    await a.dispose();

    // 轮 1 的结果都在（echo 已产出、会话 idle）
    const h1 = await waitForEvents(sid, (es) => es.some((e) => e.type === "agent.message"));
    expect(h1.some((e) => e.type === "agent.message")).toBe(true);

    // 无 active checkpoint → 水位线不一致
    const row = await env.db.db
      .selectFrom("sessions")
      .select(["active_workspace_checkpoint", "last_completed_execution_id"])
      .where("id", "=", sid)
      .executeTakeFirst();
    expect(row?.active_workspace_checkpoint).toBeNull();
    expect(row?.last_completed_execution_id).toBeTruthy();

    // worker B 接手第二轮：Level 0 语义恢复
    await postMessage(sid, "second-turn");
    const b = env.newRunner("worker_b");
    await b.processSession(sid);
    await b.dispose();

    const internals = await internalEvents(sid);
    const recovered = internals.find((e) => e.type === "runtime.recovered");
    expect(recovered?.payload).toMatchObject({ mode: "semantic", reason: "watermark_mismatch" });

    // 第二轮正常完成，语义历史被注入（rollout 含第一轮对话）
    const h2 = await listEvents(url, key, sid);
    const msgs = h2.filter((e) => e.type === "agent.message");
    expect(msgs.length).toBe(2);
    expect((msgs[1]?.content?.[0] ?? {}).text).toBe("echo: second-turn");
    env.resumeWorker();
  });

  test("REC-04 水位线一致 → Level 1 原生恢复（文件还原 + thread resume）", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "turn-one");
    // 轮末 checkpoint 已发布且水位线一致（轮完成 + CAS 发布）
    const start = Date.now();
    for (;;) {
      const row0 = await env.db.db
        .selectFrom("sessions")
        .select(["active_workspace_checkpoint"])
        .where("id", "=", sid)
        .executeTakeFirst();
      if (row0?.active_workspace_checkpoint) break;
      if (Date.now() - start > 15_000) throw new Error("checkpoint not published in time");
      await new Promise((r) => setTimeout(r, 150));
    }
    const row = await env.db.db
      .selectFrom("sessions")
      .select(["active_workspace_checkpoint", "last_completed_execution_id", "codex_thread_id"])
      .where("id", "=", sid)
      .executeTakeFirst();
    const manifest = row?.active_workspace_checkpoint as { completed_execution_watermark?: string } | null;
    expect(manifest?.completed_execution_watermark).toBe(row?.last_completed_execution_id);

    // worker 重启（内存 runtime 全丢）
    env.pauseWorker();
    await postMessage(sid, "turn-two");
    const b = env.newRunner("worker_b");
    await b.processSession(sid);
    await b.dispose();

    const internals = await internalEvents(sid);
    const recovered = internals.find((e) => e.type === "runtime.recovered");
    expect(recovered?.payload).toMatchObject({ mode: "native" });

    const h = await listEvents(url, key, sid);
    const msgs = h.filter((e) => e.type === "agent.message");
    expect(msgs.length).toBe(2);
    expect((msgs[1]?.content?.[0] ?? {}).text).toBe("echo: turn-two");

    // thread id 延续（原生 resume）
    const after = await env.db.db
      .selectFrom("sessions")
      .select(["codex_thread_id"])
      .where("id", "=", sid)
      .executeTakeFirst();
    expect(after?.codex_thread_id).toBe(row?.codex_thread_id);
    env.resumeWorker();
  });

  test("REC-05 checkpoint 损坏 → 降级语义恢复 + session.error{checkpoint_corrupt}", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "good-turn");
    const ckStart = Date.now();
    for (;;) {
      const active = await env.db.db
        .selectFrom("workspace_checkpoints")
        .select(["checkpoint_id"])
        .where("session_id", "=", sid)
        .where("state", "=", "active")
        .executeTakeFirst();
      if (active) break;
      if (Date.now() - ckStart > 15_000) throw new Error("checkpoint not published in time");
      await new Promise((r) => setTimeout(r, 150));
    }

    // 破坏归档对象（sha256 校验必失败）
    const ck = await env.db.db
      .selectFrom("workspace_checkpoints")
      .select(["checkpoint_id"])
      .where("session_id", "=", sid)
      .where("state", "=", "active")
      .executeTakeFirst();
    expect(ck).toBeTruthy();
    const objPath = join(env.snapshotDir, "snapshots", sid, `${ck!.checkpoint_id}.json.gz`);
    writeFileSync(objPath, Buffer.from("corrupted-archive-bytes"));

    env.pauseWorker();
    await postMessage(sid, "after-corruption");
    const b = env.newRunner("worker_b");
    await b.processSession(sid);
    await b.dispose();

    // 对外：session.error{checkpoint_corrupt}
    const events = await listEvents(url, key, sid);
    const err = events.find((e) => e.type === "session.error");
    expect(err?.error?.type).toBe("checkpoint_corrupt");

    // 对内：runtime.recovered{semantic, checkpoint_corrupt}；损坏 checkpoint 被标记
    const internals = await internalEvents(sid);
    expect(internals.some((e) => e.type === "runtime.recovered"
      && (e.payload as { reason?: string }).reason === "checkpoint_corrupt")).toBe(true);
    const marked = await env.db.db
      .selectFrom("workspace_checkpoints")
      .select(["state"])
      .where("checkpoint_id", "=", ck!.checkpoint_id)
      .executeTakeFirst();
    expect(marked?.state).toBe("corrupt");

    // 会话仍可用：第二轮 echo 完成
    const msgs = events.filter((e) => e.type === "agent.message");
    expect(msgs.length).toBe(2);
    expect((msgs[1]?.content?.[0] ?? {}).text).toBe("echo: after-corruption");
    env.resumeWorker();
  });

  test("REC-06 毒任务重试耗尽 → failed + exhausted 收尾", async () => {
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "poison");

    // worker 已进入 running 后反复崩溃，直至 attempt 耗尽（5 次上限）且租约过期
    await env.db.db
      .updateTable("sessions")
      .set({ status: "running" })
      .where("id", "=", sid)
      .execute();
    await killExecutionAs(sid, { delivered: true, exhausted: true });
    await reapExhaustedExecutions(env.db.db);

    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["state", "failure"])
      .where("session_id", "=", sid)
      .execute();
    expect(exec[0]?.state).toBe("failed");
    expect((exec[0]?.failure as { reason?: string })?.reason).toBe("exhausted");

    const s = await waitFor(url, key, sid, (x) => x.status === "idle" && x.stop_reason?.type === "retries_exhausted");
    expect(s.stop_reason?.type).toBe("retries_exhausted");
    const events = await listEvents(url, key, sid);
    const err = events.find((e) => e.type === "session.error");
    expect(err?.error?.retry_status).toBe("exhausted");
    expect(events.map((e) => e.type)).not.toContain("agent.message");
    env.resumeWorker();
  });

  test("REC-07 Idempotency-Key：同 key 同 body 回放，异 body 409", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    const idemKey = `idem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const body = { events: [{ type: "user.message", content: [{ type: "text", text: "once" }] }] };
    const r1 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, body, { "idempotency-key": idemKey });
    expect(r1.status).toBe(200);
    const firstIds = (r1.json.data as { id: string }[]).map((e) => e.id);

    // 同 key 同 body：回放首次响应（相同 event id，不重复准入）
    const r2 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, body, { "idempotency-key": idemKey });
    expect(r2.status).toBe(200);
    expect((r2.json.data as { id: string }[]).map((e) => e.id)).toEqual(firstIds);

    await waitForEvents(sid, (es) => es.some((e) => e.type === "agent.message"));
    const events = await listEvents(url, key, sid);
    expect(events.filter((e) => e.type === "user.message").length).toBe(1);

    // 同 key 异 body：409 idempotency_conflict
    const r3 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "different" }] }],
    }, { "idempotency-key": idemKey });
    expect(r3.status).toBe(409);
    expect(r3.json.error?.type).toBe("idempotency_conflict");
  });
});
