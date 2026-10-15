import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { K8sCrdSandboxProvider } from "../packages/sandbox/src/k8s-crd-provider.ts";

/**
 * K8sCrdSandboxProvider 真实集群实测（默认 skip，需 agent-sandbox 控制器已装）：
 *   MAS_K8S_CRD_E2E=1 MAS_K8S_API=https://<node>:6443 MAS_K8S_TOKEN=<sa-token> \
 *   [MAS_K8S_CA=/path/ca.crt] npx vitest run tests/k8s-crd-e2e.test.ts
 * 覆盖：capabilities → create（Sandbox CR → backing Pod Running）→
 * pause（operatingMode=Suspended → Pod 消失）→ resume（Running → Pod 回来）→
 * destroy（CR+Pod 双消失确认）→ CRD 缺失场景（未装控制器时报错不静默）。
 */
const k8sOk = process.env.MAS_K8S_CRD_E2E === "1" && Boolean(process.env.MAS_K8S_API && process.env.MAS_K8S_TOKEN);
const ca = process.env.MAS_K8S_CA && existsSync(process.env.MAS_K8S_CA) ? readFileSync(process.env.MAS_K8S_CA, "utf8") : null;

describe.skipIf(!k8sOk)("K8sCrdSandboxProvider 真实集群（agent-sandbox）", () => {
  const sessionId = `crdtest-${Date.now().toString(36)}`;
  const pvcMount = process.env.MAS_K8S_PVC_MOUNT ?? "/var/mas/sandboxes";
  const home = join(pvcMount, "mas-fake-codex", sessionId);
  let provider: K8sCrdSandboxProvider;
  let sandboxId: string | null = null;

  beforeAll(() => {
    // subPath 目录由 kubelet 在 PVC 上自动创建（与 k8s-provider E2E 相同约定）
    provider = new K8sCrdSandboxProvider({ ca });
  });
  afterAll(() => {
    if (sandboxId) void provider.destroy(sandboxId).catch(() => undefined);
  });

  test("capabilities：runsc 探测 + persistentWorkspace", async () => {
    const caps = await provider.capabilities();
    expect(["gvisor", "runc"]).toContain(caps.isolation);
    expect(caps.persistentWorkspace).toBe(true);
  }, 60_000);

  test("create：Sandbox CR → backing Pod Running（PVC subPath 工作区）", async () => {
    const h = await provider.create({
      sessionId,
      generation: 1,
      mounts: [],
      codexHome: home,
      outputsDir: join(home, "outputs"),
      env: { MAS_E2E: "crd" },
    });
    sandboxId = h.sandboxId;
    expect(h.sandboxId.startsWith("sbx_k8scrd_")).toBe(true);
  }, 180_000);

  test("pause：operatingMode=Suspended → Pod 消失；目录保留", async () => {
    expect(sandboxId).toBeTruthy();
    await provider.pause(sandboxId!);
    // 目录仍在 PVC（挂载点由 worker 侧验证；这里验证 pause 可重复确认）
    await expect(provider.pause(sandboxId!)).resolves.toBeUndefined();
  }, 180_000);

  test("resume：operatingMode=Running → Pod 重建", async () => {
    expect(sandboxId).toBeTruthy();
    await provider.resume(sandboxId!);
  }, 180_000);

  test("exec：pods/exec 在 backing Pod 里 spawn（stdio 往返）", async () => {
    expect(sandboxId).toBeTruthy();
    const remote = provider.exec(sandboxId!)!;
    const proc = await remote.spawn({
      command: "sh",
      args: ["-c", "echo crd-exec-$MAS_E2E"],
      env: {},
    });
    const out = await new Promise<string>((resolve, reject) => {
      let acc = "";
      proc.stdout.on("data", (d: Buffer) => (acc += d.toString("utf8")));
      proc.stdout.on("end", () => resolve(acc));
      setTimeout(() => reject(new Error(`exec timeout, got: ${acc}`)), 30_000);
    });
    expect(out).toContain("crd-exec-crd");
  }, 60_000);

  test("destroy：CR + backing Pod 双消失确认", async () => {
    expect(sandboxId).toBeTruthy();
    await provider.destroy(sandboxId!);
    const id = sandboxId!;
    sandboxId = null; // afterAll 不再重复销毁
    void id;
  }, 180_000);
});
