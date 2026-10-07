import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CodexDriver, sessionRuntimeHome, type NormalizedRuntimeEvent } from "../packages/runtime/src/codex-driver.ts";
import { SessionRunner } from "../apps/worker/src/session-runner.ts";
import { call, setupEnv } from "./helpers.ts";

/**
 * 真实 codex app-server driver E2E（消耗登录账号额度）：
 * 显式开启 —— MAS_CODEX_E2E=1 MAS_CODEX_BIN=<codex> [HTTPS_PROXY=...]
 * Mac 上 ChatGPT.app 自带二进制：
 *   MAS_CODEX_E2E=1 \
 *   MAS_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
 *   HTTPS_PROXY=http://127.0.0.1:7890 npx vitest run tests/codex-driver-e2e.test.ts
 */

const bin = process.env.MAS_CODEX_BIN ?? "";
let codexOk = process.env.MAS_CODEX_E2E === "1";
if (codexOk) {
  try {
    execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 10_000 });
  } catch {
    codexOk = false;
  }
}

describe.skipIf(!codexOk)("CodexDriver E2E (real codex)", () => {
  const driver = new CodexDriver({ bin });
  const sessionId = `e2e_codex_${Date.now().toString(36)}`;

  afterAll(() => {
    rmSync(sessionRuntimeHome(sessionId), { recursive: true, force: true });
  });

  test("digest 形如 codex@<version>", () => {
    expect(driver.versionDigest).toMatch(/^codex@[\w.\-]+$/);
  });

  test("一轮对话：user_message → agent_message → turn_completed", async () => {
    expect(existsSync(join(sessionRuntimeHome(sessionId)))).toBe(false);
    const handle = await driver.start({
      sessionId,
      system: "You are a terse assistant. Follow instructions exactly.",
      model: { id: process.env.MAS_CODEX_MODEL ?? "gpt-6.1-sol" },
      approvalPolicy: "never",
    });
    try {
      expect(handle.threadId).toBeTruthy();
      await driver.send(handle, { type: "user_message", text: "Reply with exactly one word: pong" });

      const events: NormalizedRuntimeEvent[] = [];
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const ev = await driver.nextEvent(handle, 5_000);
        if (!ev) continue;
        events.push(ev);
        if (ev.kind === "turn_completed") break;
      }
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("turn_started");
      expect(kinds).toContain("agent_message");
      expect(kinds).not.toContain("error");
      const msg = events.find((e) => e.kind === "agent_message");
      expect(msg && msg.kind === "agent_message" && msg.text.toLowerCase()).toContain("pong");
      const done = events.at(-1);
      expect(done?.kind).toBe("turn_completed");
      expect(done && done.kind === "turn_completed" && done.reason).toBe("completed");
    } finally {
      await handle.stop("test done").catch(() => undefined);
    }
  }, 180_000);

  test("Level 1 原生恢复：thread/resume 后延续上下文", async () => {
    const first = await driver.start({
      sessionId,
      system: "You are a terse assistant.",
      model: { id: process.env.MAS_CODEX_MODEL ?? "gpt-6.1-sol" },
      approvalPolicy: "never",
    });
    try {
      await driver.send(first, { type: "user_message", text: "Remember the codeword: mangosteen. Reply with: ok" });
      let saw: NormalizedRuntimeEvent | undefined;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const ev = await driver.nextEvent(first, 5_000);
        if (!ev) continue;
        if (ev.kind === "turn_completed") break;
        if (ev.kind === "agent_message") saw = ev;
      }
      expect(saw).toBeTruthy();
    } finally {
      await first.stop("turn 1 done").catch(() => undefined);
    }

    // 进程重启后按 threadId resume（CODEX_HOME 在会话 home 下持久化）
    const second = await driver.start({
      sessionId,
      system: "You are a terse assistant.",
      model: { id: process.env.MAS_CODEX_MODEL ?? "gpt-6.1-sol" },
      approvalPolicy: "never",
      resumeThreadId: first.threadId,
    });
    try {
      expect(second.threadId).toBe(first.threadId);
      await driver.send(second, { type: "user_message", text: "What was the codeword? Reply with only the codeword." });
      const deadline = Date.now() + 120_000;
      let answer = "";
      while (Date.now() < deadline) {
        const ev = await driver.nextEvent(second, 5_000);
        if (!ev) continue;
        if (ev.kind === "agent_message") answer = ev.text;
        if (ev.kind === "turn_completed") break;
      }
      expect(answer.toLowerCase()).toContain("mangosteen");
    } finally {
      await second.stop("resume done").catch(() => undefined);
    }
  }, 300_000);
});

describe.skipIf(!codexOk)("CodexDriver 全栈（api + worker，MAS_RUNTIME_DRIVER=codex 等价路径）", () => {
  test("POST message → SessionRunner(codex) → agent.message 落库、idle、thread/checkpoint 登记", async () => {
    const env = await setupEnv();
    env.pauseWorker(); // 停掉 fake 后台 drain，用真实 driver 的 runner 手动推进
    const runner = new SessionRunner(env.db.db, new CodexDriver({ bin }), "worker_codex_e2e");

    const agent = await call(env.url, env.key, "POST", "/v1/agents", {
      name: `codex-e2e-${Date.now()}`,
      model: { id: process.env.MAS_CODEX_MODEL ?? "gpt-6.1-sol" },
    });
    const envr = await call(env.url, env.key, "POST", "/v1/environments", {
      name: `codex-e2e-${Date.now()}`,
      config: { type: "cloud" },
    });
    const s = await call(env.url, env.key, "POST", "/v1/sessions", {
      agent: agent.json.id,
      environment_id: envr.json.id,
    });
    const sid = s.json.id;
    await call(env.url, env.key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Reply with exactly one word: pong" }] }],
    });

    await runner.processSession(sid);

    const evs = await call(env.url, env.key, "GET", `/v1/sessions/${sid}/events`);
    const types: string[] = evs.json.data.map((e: { type: string }) => e.type);
    expect(types).toContain("agent.message");
    expect(types).toContain("session.status_idle");
    expect(types.filter((t) => t === "session.error")).toHaveLength(0);
    const msg = evs.json.data.find((e: { type: string }) => e.type === "agent.message");
    expect(JSON.stringify(msg?.content ?? [])).toContain("pong");

    const row = await env.db.db
      .selectFrom("sessions")
      .select(["codex_thread_id", "codex_version_digest", "sandbox_id"])
      .where("id", "=", sid)
      .executeTakeFirst();
    expect(row?.codex_thread_id).toBeTruthy();
    expect(row?.codex_version_digest).toMatch(/^codex@/);
    expect(row?.sandbox_id).toBeTruthy();

    // 轮末 checkpoint 已发布（Level 1 恢复的输入）
    const ck = await env.db.db
      .selectFrom("workspace_checkpoints")
      .select(["checkpoint_id", "state", "manifest"])
      .where("session_id", "=", sid)
      .execute();
    expect(ck.length).toBeGreaterThanOrEqual(1);
    const active = ck.find((c) => c.state === "active");
    expect(active).toBeTruthy();
    expect(String((active?.manifest as { codex_version_digest?: string })?.codex_version_digest)).toMatch(/^codex@/);

    await runner.dispose();
    rmSync(sessionRuntimeHome(sid), { recursive: true, force: true });
  }, 300_000);
});
