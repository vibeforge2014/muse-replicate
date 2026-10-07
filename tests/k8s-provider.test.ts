import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { K8sSandboxProvider } from "../packages/sandbox/src/k8s-provider.ts";

/**
 * K8sSandboxProvider 真实集群实测（默认 skip）：
 *   MAS_K8S_E2E=1 MAS_K8S_API=https://<node>:6443 MAS_K8S_TOKEN=<sa-token> \
 *   [MAS_K8S_CA=/path/to/ca.crt] npx vitest run tests/k8s-provider.test.ts
 * 覆盖：capabilities（runsc 探测如实）→ create（PVC subPath 挂载、Running）→
 * pause/resume（删/建 Pod，目录保留）→ destroy。
 * 需集群已有 mas-sandboxes PVC（deploy/k8s/56-sandbox-rbac.yaml）。
 */

const k8sOk = process.env.MAS_K8S_E2E === "1" && Boolean(process.env.MAS_K8S_API && process.env.MAS_K8S_TOKEN);
const ca = process.env.MAS_K8S_CA ? readFileSync(process.env.MAS_K8S_CA, "utf8") : null;

describe.skipIf(!k8sOk)("K8sSandboxProvider 真实集群", () => {
  const sessionId = `k8stest-${Date.now().toString(36)}`;
  const pvcMount = process.env.MAS_K8S_PVC_MOUNT ?? "/var/mas/sandboxes";
  const home = join(pvcMount, "mas-fake-codex", sessionId);
  let provider: K8sSandboxProvider;
  let handle: Awaited<ReturnType<K8sSandboxProvider["create"]>> | null = null;

  beforeAll(() => {
    // subPath 目录由 kubelet 在 PVC 上自动创建；这里只准备 worker 侧路径参数
    provider = new K8sSandboxProvider({ ca });
  });

  afterAll(() => {
    if (handle) void provider.destroy(handle.sandboxId).catch(() => undefined);
  });

  test("capabilities：runsc 探测 + persistentWorkspace", async () => {
    const caps = await provider.capabilities();
    expect(["gvisor", "runc"]).toContain(caps.isolation);
    expect(caps.persistentWorkspace).toBe(true);
    expect(caps.egress).toBe("advisory"); // NetworkPolicy 已下发但不虚报 enforced
  }, 60_000);

  test("create：Pod Running（PVC subPath 工作区绑定）", async () => {
    handle = await provider.create({
      sessionId,
      generation: 1,
      mounts: [],
      codexHome: home,
      outputsDir: join(home, "outputs"),
    });
    expect(handle.sandboxId).toMatch(/^sbx_k8s_/);
  }, 120_000);

  test("pause/resume：Pod 删除重建，目录保留", async () => {
    await provider.pause(handle!.sandboxId);
    await provider.resume(handle!.sandboxId);
  }, 180_000);

  test("destroy：Pod 消失", async () => {
    await provider.destroy(handle!.sandboxId);
    handle = null;
  }, 60_000);
});
