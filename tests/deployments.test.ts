import { beforeAll, describe, expect, test } from "vitest";
import { runDeploymentTick } from "@mas/db";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * DEP（5.14）验收。调度 tick 在用例内显式驱动（server main 的常驻调度在部署态生效）。
 * DEP-02 的时区断言按平台方言固定 Asia/Shanghai。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function tickUntil(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await runDeploymentTick(env.db.db);
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("tickUntil timeout");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForRun(runId: string, predicate: (r: any) => boolean, timeoutMs = 20_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    await runDeploymentTick(env.db.db); // 测试内显式驱动调度（部署态由 server main 常驻 tick）
    const list = await call(url, key, "GET", `/v1/deployment_runs?deployment_id=&limit=200`);
    const run = list.json.data.find((r: any) => r.id === runId);
    if (run && predicate(run)) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForRun timeout; last=${JSON.stringify(run ?? null).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("DEP-01/02/03 创建与 cron 校验", () => {
  test("manual-only → 201，schedule=null，agent.version 固定为当前最新", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    // 升一版 agent（v2）
    await call(url, key, "POST", `/v1/agents/${agentId}`, { description: "v2" });
    const r = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId });
    expect(r.status).toBe(201);
    expect(r.json.schedule).toBeNull();
    expect(r.json.agent).toMatchObject({ type: "agent", id: agentId, version: 2 });
    expect(r.json.status).toBe("active");
    expect(r.json.upcoming_runs_at).toEqual([]);
  });

  test("cron 非法：间隔 <5min / 无未来触发点 / 时区 ≠ Asia/Shanghai → 400", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    expect((await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "* * * * *" })).status).toBe(400);
    expect((await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "30,33 * * * *" })).status).toBe(400);
    expect((await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "0 0 31 2 *" })).status).toBe(400);
    expect(
      (await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "*/10 * * * *", timezone: "UTC" })).status,
    ).toBe(400);
    expect((await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "bad expr" })).status).toBe(400);
  });

  test("合法 cron → upcoming_runs_at ≤5 项且递增", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const r = await call(url, key, "POST", "/v1/deployments", {
      agent: agentId,
      environment_id: envId,
      schedule: "*/15 * * * *",
    });
    expect(r.status).toBe(201);
    const upcoming = r.json.upcoming_runs_at;
    expect(upcoming.length).toBeGreaterThanOrEqual(1);
    expect(upcoming.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < upcoming.length; i++) {
      expect(new Date(upcoming[i]).getTime()).toBeGreaterThan(new Date(upcoming[i - 1]).getTime());
    }
  });
});

describe("DEP-04 手动 run 生命周期", () => {
  test("202 → 数秒内 session_id 非空 → 会话结束后 succeeded", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const dep = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, input: { message: "hello deployment" } });
    expect(dep.status).toBe(201);
    const run = await call(url, key, "POST", `/v1/deployments/${dep.json.id}/runs`);
    expect(run.status).toBe(202);
    expect(run.json.status).toBe("pending");
    expect(run.json.trigger_context).toMatchObject({ type: "manual" });
    expect(run.json.session_id).toBeNull();

    const started = await waitForRun(run.json.id, (r) => r.session_id !== null);
    // 启动后即 running；极快场景（fake codex 轮次毫秒级）可能已经收尾
    expect(["running", "succeeded"]).toContain(started.status);
    // 会话首轮消息来自 deployment input
    const events = await call(url, key, "GET", `/v1/sessions/${started.session_id}/events`);
    const userMsg = events.json.data.find((e: any) => e.type === "user.message");
    expect(userMsg?.content?.[0]?.text).toBe("hello deployment");

    const done = await waitForRun(run.json.id, (r) => r.status === "succeeded" || r.status === "failed");
    expect(done.status).toBe("succeeded");
    expect(done.finished_at).toBeTruthy();
    await call(url, key, "POST", `/v1/deployments/${dep.json.id}/archive`);
  });
});

describe("DEP-05/06 pause / archive", () => {
  test("pause 后手动 run 仍允许；paused 时 upcoming 为空，unpause 后重新以当前时间为锚", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const dep = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "*/30 * * * *" });
    const id = dep.json.id;
    const paused = await call(url, key, "POST", `/v1/deployments/${id}/pause`);
    expect(paused.json.status).toBe("paused");
    expect(paused.json.upcoming_runs_at).toEqual([]);
    const run = await call(url, key, "POST", `/v1/deployments/${id}/runs`);
    expect(run.status).toBe(202); // pause 不拦手动 run

    await tickUntil(async () => true); // 让该 run 走完启动
    const unpaused = await call(url, key, "POST", `/v1/deployments/${id}/unpause`);
    expect(unpaused.json.status).toBe("active");
    expect(unpaused.json.upcoming_runs_at.length).toBeGreaterThan(0);
    const now = Date.now();
    for (const t of unpaused.json.upcoming_runs_at) {
      expect(new Date(t).getTime()).toBeGreaterThan(now - 60_000); // 以当前时间为锚
    }
    await waitForRun(run.json.id, (r) => r.status === "succeeded" || r.status === "failed");
    await call(url, key, "POST", `/v1/deployments/${id}/archive`);
  });

  test("归档幂等；归档后手动 run → 409", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const dep = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId });
    const id = dep.json.id;
    const a1 = await call(url, key, "POST", `/v1/deployments/${id}/archive`);
    expect(a1.json.status).toBe("archived");
    const a2 = await call(url, key, "POST", `/v1/deployments/${id}/archive`);
    expect(a2.status).toBe(200);
    expect(a2.json.status).toBe("archived");
    expect((await call(url, key, "POST", `/v1/deployments/${id}/runs`)).status).toBe(409);
  });
});

describe("DEP-07 runs 过滤", () => {
  test("deployment_id / has_error / trigger_type / created_at / 默认 limit 50", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const dep = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId });
    const dep2 = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId });
    const r1 = await call(url, key, "POST", `/v1/deployments/${dep.json.id}/runs`);
    const r2 = await call(url, key, "POST", `/v1/deployments/${dep2.json.id}/runs`);
    await waitForRun(r1.json.id, (r) => r.status === "succeeded");
    await waitForRun(r2.json.id, (r) => r.status === "succeeded");

    const byDep = await call(url, key, "GET", `/v1/deployment_runs?deployment_id=${dep.json.id}`);
    expect(byDep.json.data.length).toBe(1);
    expect(byDep.json.data[0].deployment_id).toBe(dep.json.id);

    const manual = await call(url, key, "GET", "/v1/deployment_runs?trigger_type=manual");
    expect(manual.json.data.every((r: any) => r.trigger_type === "manual")).toBe(true);

    const noErr = await call(url, key, "GET", "/v1/deployment_runs?has_error=false");
    expect(noErr.json.data.every((r: any) => r.error === undefined || r.error === null)).toBe(true);

    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await call(url, key, "GET", `/v1/deployment_runs?created_at[gte]=${since}`);
    expect(recent.json.data.length).toBeGreaterThanOrEqual(2);
    const old = await call(url, key, "GET", `/v1/deployment_runs?created_at[lte]=${new Date(Date.now() - 120_000).toISOString()}`);
    expect(old.json.data.length).toBe(0);
    expect((await call(url, key, "GET", "/v1/deployment_runs?limit=201")).status).toBe(400);
  });
});

describe("DEP-08 环境归档后 run 失败", () => {
  test("run 的 error 字段非空", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const dep = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId });
    // 先让一个 run 成功跑通（验证部署可用）
    const okRun = await call(url, key, "POST", `/v1/deployments/${dep.json.id}/runs`);
    await waitForRun(okRun.json.id, (r) => r.status === "succeeded");

    await call(url, key, "POST", `/v1/environments/${envId}/archive`);
    const badRun = await call(url, key, "POST", `/v1/deployments/${dep.json.id}/runs`);
    expect(badRun.status).toBe(202);
    const failed = await waitForRun(badRun.json.id, (r) => r.status === "failed");
    expect(failed.error).toMatchObject({ type: "start_failed" });
    expect(String(failed.error.message)).toContain("archived");
    await call(url, key, "POST", `/v1/deployments/${dep.json.id}/archive`);
  });
});

describe("DEP-09 归档 agent 联动", () => {
  test("archive agent → 其 deployments 全部 archived", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const d1 = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId });
    const d2 = await call(url, key, "POST", "/v1/deployments", { agent: agentId, environment_id: envId, schedule: "*/30 * * * *" });
    expect(d1.json.status).toBe("active");
    await call(url, key, "POST", `/v1/agents/${agentId}/archive`);
    const g1 = await call(url, key, "GET", `/v1/deployments/${d1.json.id}`);
    const g2 = await call(url, key, "GET", `/v1/deployments/${d2.json.id}`);
    expect(g1.json.status).toBe("archived");
    expect(g2.json.status).toBe("archived");
    expect(g2.json.upcoming_runs_at).toEqual([]);
  });
});
