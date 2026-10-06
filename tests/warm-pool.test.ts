import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { FakeSandboxProvider, WarmPoolProvider, type SandboxSpec } from "@mas/sandbox";
import { FakeCodexDriver } from "@mas/runtime";
import { FsSnapshotStore } from "@mas/db";
import { SessionRunner } from "../apps/worker/src/session-runner.ts";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * Warm pool 最小实现（plan M6 W13 / spec §9.3 二期）：
 * 预建 N 个空沙箱，create 快路径迟绑定（attach）直落冷创建；后台串行补池。
 */

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

function realSpec(n: number, root = tmpdir()): { spec: SandboxSpec; home: string } {
  const home = mkdtempSync(join(root, `warm-real-${n}-`));
  return {
    spec: {
      sessionId: `sess_warm_${n}`,
      generation: 1,
      mounts: [],
      codexHome: home,
      outputsDir: join(home, "outputs"),
    },
    home,
  };
}

describe("SandboxWarmPool（WARM）", () => {
  test("WARM-01 保温与快路径：池填满 → create 命中预热沙箱并迟绑定到真实目录", async () => {
    const inner = new FakeSandboxProvider();
    const pool = new WarmPoolProvider(inner, { min: 2 });
    await pool.prewarm();
    expect(pool.getStats().warm).toBe(2);

    const { spec, home } = realSpec(1);
    const handle = await pool.create(spec);
    // 命中预热：sandboxId 是预建时签发的 fake id，目录已重绑到真实 home
    expect(handle.sandboxId).toMatch(/^sbx_fake_/);
    expect(handle.workspaceDir).toBe(home);
    expect(handle.uploadsDir).toBe(join(home, "uploads"));
    const marker = JSON.parse(readFileSync(join(home, ".sandbox"), "utf8")) as {
      sandboxId: string;
      sessionId: string;
      generation: number;
    };
    expect(marker.sandboxId).toBe(handle.sandboxId);
    expect(marker.sessionId).toBe(spec.sessionId);
    expect(marker.generation).toBe(1);
    expect(pool.getStats().warmHits).toBe(1);
    expect(pool.getStats().coldCreates).toBe(0);

    // 出池后后台补回 min
    for (let i = 0; i < 100 && pool.getStats().warm < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pool.getStats().warm).toBe(2);
    await pool.drain();
    expect(pool.getStats().warm).toBe(0);
  });

  test("WARM-02 溢出直落：补池未完成时 create 走冷创建，互不串号", async () => {
    // 闸门：只阻塞 warmup 占位创建，模拟"补池慢于取用"（真实 provider 的容器启动耗时）
    class GatedFake extends FakeSandboxProvider {
      closed = false;
      private opener: (() => void) | undefined;
      override async create(spec: SandboxSpec) {
        if (this.closed && spec.sessionId === "warmup") {
          await new Promise<void>((r) => (this.opener = r));
        }
        return super.create(spec);
      }
      open(): void {
        this.closed = false;
        this.opener?.();
        this.opener = undefined;
      }
    }
    const inner = new GatedFake();
    const pool = new WarmPoolProvider(inner, { min: 1 });
    await pool.prewarm();
    inner.closed = true; // 后台补池将挂起
    const a = realSpec(2);
    const b = realSpec(3);
    const h1 = await pool.create(a.spec); // 命中预热
    const h2 = await pool.create(b.spec); // 池空且补池挂起 → 冷创建
    expect(h1.sandboxId).not.toBe(h2.sandboxId);
    expect(pool.getStats().warmHits).toBe(1);
    expect(pool.getStats().coldCreates).toBe(1);
    expect(h2.workspaceDir).toBe(b.home);
    expect(readFileSync(join(b.home, ".sandbox"), "utf8")).toContain(b.spec.sessionId);
    inner.open(); // 放行挂起的补池
    for (let i = 0; i < 100 && pool.getStats().warm < 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pool.getStats().warm).toBe(1);
    await pool.drain();
  });

  test("WARM-03 capabilities/pause/resume/destroy 透传 + 不支持 attach 的 provider fail closed", async () => {
    const inner = new FakeSandboxProvider("microvm");
    const pool = new WarmPoolProvider(inner, { min: 1 });
    await pool.prewarm();
    expect(pool.kind).toBe("warmpool(fake)");
    const caps = await pool.capabilities();
    expect(caps.isolation).toBe("microvm");

    const { spec } = realSpec(4);
    const handle = await pool.create(spec);
    await expect(pool.pause(handle.sandboxId)).resolves.toBeUndefined();
    await expect(pool.resume(handle.sandboxId)).resolves.toBeUndefined();
    await expect(pool.destroy(handle.sandboxId)).resolves.toBeUndefined();
    await pool.drain();

    // 没有 attach 的 provider：构造即拒绝（不虚报预热能力）
    const noAttach = {
      kind: "no-attach",
      capabilities: async () => ({ isolation: "runc" as const, persistentWorkspace: true, egress: "advisory" as const }),
      create: async (s: SandboxSpec) => ({ sandboxId: "sbx_x", workspaceDir: s.codexHome, outputsDir: s.outputsDir, uploadsDir: s.codexHome }),
      pause: async () => undefined,
      resume: async () => undefined,
      destroy: async () => undefined,
    };
    expect(() => new WarmPoolProvider(noAttach as never, { min: 1 })).toThrow(/attach/);
  });

  test("WARM-04 端到端：SessionRunner 走 WarmPoolProvider 完整跑一轮会话", async () => {
    env.pauseWorker();
    const pool = new WarmPoolProvider(new FakeSandboxProvider(), { min: 1 });
    await pool.prewarm();
    const runner = new SessionRunner(
      env.db.db,
      new FakeCodexDriver(),
      "worker_warm",
      new FsSnapshotStore(env.snapshotDir),
      pool,
    );

    const { agentId, envId } = await makeAgentAndEnv(env.url, env.key);
    const r = await call(env.url, env.key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "warm pool turn" }] }],
    });
    expect(r.status).toBe(200);
    await runner.processSession(r.json.id);
    const done = await waitFor(env.url, env.key, r.json.id, (s: { status: string; stop_reason: unknown }) => s.status === "idle" && s.stop_reason !== null);
    expect(done.status).toBe("idle");

    const stats = pool.getStats();
    expect(stats.warmHits).toBeGreaterThanOrEqual(1);
    expect(stats.coldCreates).toBe(0);
    expect(stats.warm).toBe(1); // 出池后补回
    await pool.drain();
    await runner.dispose();
    env.resumeWorker();
  });
});
