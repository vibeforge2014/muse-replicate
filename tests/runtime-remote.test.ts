import { readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeCodexDriver, localStdioSpawn } from "@mas/runtime";
import { resetFakeSandboxHome } from "@mas/sandbox";

/**
 * driver 经 RemoteSpawnContext 接口运行（spec §8.4 driver 进沙箱的接口层验证）：
 * 本地用 localStdioSpawn + 恒等路径映射做环回——证明双 driver 只依赖
 * StdioProcess/{spawn,toContainerPath} 抽象，不关心进程在哪跑。
 * 真实沙箱 exec 的 E2E 在 tests/k8s-provider.test.ts（MAS_K8S_E2E=1）。
 */

describe("runtime remote spawn 接口", () => {
  test("FakeCodexDriver 经 remote 上下文整轮驱动 + runtime-host 标记落盘", async () => {
    const sid = `remoteif-${Date.now().toString(36)}`;
    resetFakeSandboxHome(sid);
    const driver = new FakeCodexDriver();
    const handle = await driver.start({
      sessionId: sid,
      system: null,
      model: { id: "glm-5.3-flash" },
      approvalPolicy: "never",
      hasBuiltinToolset: true,
      remote: { spawn: localStdioSpawn, toContainerPath: (p) => p },
    });
    expect(handle.threadId).toBeTruthy();
    await driver.send(handle, { type: "user_message", text: "hello from remote" });
    // 等回声 agent.message
    let got: string | null = null;
    for (let i = 0; i < 50 && !got; i++) {
      const ev = await driver.nextEvent(handle, 1000);
      if (ev?.kind === "agent_message") got = ev.text;
      if (ev === null) break;
    }
    expect(got).toContain("hello from remote");
    // fake-codex 启动即写运行位置标记（沙箱内 hostname=Pod 名）
    const marker = join(tmpdir(), "mas-fake-codex", sid, "runtime-host.txt");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain(hostname());
    await handle.stop("done");
    resetFakeSandboxHome(sid);
  }, 30_000);
});
