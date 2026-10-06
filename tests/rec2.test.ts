import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { call, createSession, listEvents, makeAgentAndEnv, setupEnv, waitForEvents, type TestEnv } from "./helpers.ts";

/**
 * REC-08/09/10：输出清单幂等收集、能力协商 fail closed、digest 下线降级。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

afterEach(() => {
  env.resumeWorker();
});

async function postMessage(sid: string, text: string) {
  return call(url, key, "POST", `/v1/sessions/${sid}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

async function internalEvents(sid: string) {
  return env.db.db
    .selectFrom("session_internal_events")
    .select(["type", "payload"])
    .where("session_id", "=", sid)
    .execute();
}

describe("REC 补充（输出清单 / 能力 / digest）", () => {
  test("REC-08 输出重复收集：上传后 CAS 前崩溃 → 恢复后同 (path, sha256) 只登记一个 File", async () => {
    env.pauseWorker();
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "out reproducible-content");

    // worker A：对象上传完成、manifest CAS 之前崩溃
    const a = env.newRunner("worker_a", { crashAfterOutputUpload: true });
    await expect(a.processSession(sid)).rejects.toThrow("crash after output upload");
    await a.dispose();

    // 轮已完成（settle 在收集之前），但 File 尚未登记
    const none = await env.db.db
      .selectFrom("files")
      .select(["id"])
      .where("scope_type", "=", "session")
      .where("scope_id", "=", sid)
      .execute();
    expect(none.length).toBe(0);

    // worker B：新轮触发重新收集（同内容）
    await postMessage(sid, "out reproducible-content");
    const b = env.newRunner("worker_b");
    await b.processSession(sid);
    await b.dispose();

    const files = (await call(url, key, "GET", `/v1/files?scope_id=${sid}`)).json.data;
    expect(files.length).toBe(1);
    expect(files[0].filename).toBe("note.txt");

    // 内容与 sha 一致
    const res = await fetch(`${url}/v1/files/${files[0].id}/content`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe("reproducible-content");

    // manifest 已发布，且登记行没有重复
    const rows = await env.db.db
      .selectFrom("files")
      .select(["id"])
      .where("scope_type", "=", "session")
      .where("scope_id", "=", sid)
      .execute();
    expect(rows.length).toBe(1);
    const sess = await env.db.db
      .selectFrom("sessions")
      .select(["active_output_manifest"])
      .where("id", "=", sid)
      .executeTakeFirst();
    const manifest = sess?.active_output_manifest as { entries?: { path: string; sha256: string }[] } | null;
    expect(manifest?.entries?.length).toBe(1);
    expect(manifest?.entries?.[0]?.path).toBe("note.txt");
  });

  test("REC-09 能力不满足：env 要求 gvisor、provider 是 runc → fail closed，不降级运行", async () => {
    env.pauseWorker();
    const { agentId } = await makeAgentAndEnv(url, key);
    const envR = await call(url, key, "POST", "/v1/environments", {
      name: `gvisor-env-${Date.now()}`,
      config: { type: "cloud", isolation: "gvisor" },
    });
    expect(envR.status).toBe(200);
    const sid = await createSession(url, key, agentId, envR.json.id);
    await postMessage(sid, "should not run");

    // provider 实际是 runc 的 worker
    const runc = env.newRunner("worker_runc", undefined, { providerIsolation: "runc" });
    await runc.processSession(sid);
    await runc.dispose();

    const s = await call(url, key, "GET", `/v1/sessions/${sid}`);
    expect(s.json.status).toBe("terminated");
    expect(s.json.stop_reason?.type).toBe("capability_unsatisfied");

    const events = await listEvents(url, key, sid);
    const err = events.find((e) => e.type === "session.error");
    expect(err?.error?.type).toBe("capability_unsatisfied");
    expect(err?.error?.details).toMatchObject({ required: "gvisor", provided: "runc" });

    // 绝不降级运行：无任何 agent 产出
    expect(events.map((e) => e.type)).not.toContain("agent.message");
    const exec = await env.db.db
      .selectFrom("session_executions")
      .select(["state", "failure"])
      .where("session_id", "=", sid)
      .executeTakeFirst();
    expect(exec?.state).toBe("failed");
    expect((exec?.failure as { reason?: string })?.reason).toBe("capability_unsatisfied");
  });

  test("REC-10 原 digest 下线后恢复 → Level 0 + runtime_upgraded，会话可继续", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId);
    await postMessage(sid, "before-upgrade");
    // 等轮完成 + checkpoint 发布
    const start = Date.now();
    for (;;) {
      const row = await env.db.db
        .selectFrom("sessions")
        .select(["active_workspace_checkpoint"])
        .where("id", "=", sid)
        .executeTakeFirst();
      if (row?.active_workspace_checkpoint) break;
      if (Date.now() - start > 15_000) throw new Error("checkpoint not published");
      await new Promise((r) => setTimeout(r, 150));
    }

    // 模拟 runtime 升级：当前 digest 与 checkpoint 里的不一致（旧 digest 已下线）
    await env.db.db
      .updateTable("sessions")
      .set({ codex_version_digest: "fake-codex@0.2.0-upgraded" })
      .where("id", "=", sid)
      .execute();

    env.pauseWorker();
    await postMessage(sid, "after-upgrade");
    const b = env.newRunner("worker_b");
    await b.processSession(sid);
    await b.dispose();

    // 对外：runtime_upgraded（可重试语义）
    const events = await listEvents(url, key, sid);
    const err = events.find((e) => e.type === "session.error" && e.error?.type === "runtime_upgraded");
    expect(err?.error?.retry_status).toBe("retrying");

    // 对内：Level 0 语义恢复，reason=runtime_upgraded（不是 watermark_mismatch）
    const internals = await internalEvents(sid);
    const recovered = internals.find((e) => e.type === "runtime.recovered");
    expect(recovered?.payload).toMatchObject({ mode: "semantic", reason: "runtime_upgraded" });

    // 会话可以继续：第二轮 echo 完成
    const msgs = events.filter((e) => e.type === "agent.message");
    expect(msgs.length).toBe(2);
    expect((msgs[1]?.content?.[0] ?? {}).text).toBe("echo: after-upgrade");
  });
});
