import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SandboxHandle, SandboxSpec } from "./index.js";
import { K8sSandboxProvider, type K8sProviderOptions } from "./k8s-provider.js";

/**
 * K8sCrdSandboxProvider（roadmap §19：agent-sandbox CRD 作为另一个 SandboxProvider）。
 *
 * 沙箱 = agents.x-k8s.io/v1beta1 `Sandbox` CR（kubernetes-sigs/agent-sandbox 控制器）：
 * - create：POST Sandbox CR（spec.podTemplate.spec 复用 K8sProvider 的 PodSpec 构建；
 *   控制器创建同名 backing Pod）→ waitRunning；
 * - pause：PATCH spec.operatingMode=Suspended → 控制器终止 Pod、CR 与卷保留
 *   （语义比直接删 Pod 更完整：状态由 CR 声明，worker 无需自管重建）；
 * - resume：PATCH operatingMode=Running → 控制器重建 Pod（CR 保留模板，
 *   spec 仅作 toContainerPath 映射与 CR 缺失时的降级重建）；
 * - destroy：DELETE Sandbox CR（级联删 Pod）→ CR 与 Pod 都消失才算确认
 *   （无法确认 → 调用方记 sandbox_orphans 反复销毁）；
 * - exec/capabilities/NetworkPolicy/PVC 与 Pod 模式完全一致（同名 Pod）。
 *
 * 前置：集群装有 agent-sandbox 控制器（CRD agents.x-k8s.io）；RBAC 见
 * deploy/k8s/56-sandbox-rbac.yaml 的 sandboxes 段。选择：MAS_SANDBOX_PROVIDER=k8s-crd。
 */

const CRD_GROUP = "agents.x-k8s.io";
const CRD_VERSION = "v1beta1";

export interface K8sCrdProviderOptions extends K8sProviderOptions {
  /** CRD 组/版本（升级 agent-sandbox 大版本时覆盖；缺省 v1beta1 storage version）。 */
  crdGroupVersion?: { group: string; version: string };
  /** pause/destroy 的"确认消失"等待上限 ms（缺省 30s；降级节点 kubelet 慢时可放大）。 */
  deleteWaitMs?: number;
}

export class K8sCrdSandboxProvider extends K8sSandboxProvider {
  readonly kind = "k8s-crd";
  private readonly crdBase: string;
  private readonly deleteWaitMs: number;

  constructor(opts: K8sCrdProviderOptions = {}) {
    super(opts);
    const gv = opts.crdGroupVersion ?? { group: CRD_GROUP, version: CRD_VERSION };
    this.crdBase = `/apis/${gv.group}/${gv.version}/namespaces/${this.namespace}/sandboxes`;
    this.deleteWaitMs = opts.deleteWaitMs ?? 30_000;
  }

  private sandboxName(sandboxId: string): string {
    return this.podName(sandboxId);
  }

  private sandboxBody(sandboxId: string, spec: SandboxSpec): Record<string, unknown> {
    return {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: "Sandbox",
      metadata: {
        name: this.sandboxName(sandboxId),
        namespace: this.namespace,
        labels: { "mas-sandbox": "true", "mas-sandbox-id": sandboxId, "mas-session": spec.sessionId },
      },
      spec: {
        podTemplate: { spec: this.buildPodSpec(this.sandboxName(sandboxId), spec) },
        operatingMode: "Running",
      },
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    await this.hasRunsc();
    await this.ensureNetworkPolicy();
    const sandboxId = `sbx_k8scrd_${randomUUID().slice(0, 12)}`;
    this.specs.set(sandboxId, spec);
    const name = this.sandboxName(sandboxId);
    const r = await this.api.req({ method: "POST", path: this.crdBase, body: this.sandboxBody(sandboxId, spec) });
    if (r.status >= 300 && r.status !== 409) {
      const msg = JSON.stringify(r.body).slice(0, 300);
      throw new Error(`agent-sandbox create failed: ${r.status} ${msg}`);
    }
    try {
      // 控制器按 CR 名创建同名 backing Pod；Ready 与 Pod Running 等价（Ready 还要求 IP）
      await this.waitRunning(name, this.podStartTimeoutMs);
    } catch (e) {
      await this.destroy(sandboxId).catch(() => undefined);
      throw e;
    }
    return {
      sandboxId,
      workspaceDir: "/session/.codex",
      outputsDir: spec.outputsDir,
      uploadsDir: join(spec.codexHome, "uploads"),
    };
  }

  async pause(sandboxId: string): Promise<void> {
    const name = this.sandboxName(sandboxId);
    const r = await this.api.req({
      method: "PATCH",
      path: `${this.crdBase}/${name}`,
      body: { spec: { operatingMode: "Suspended" } },
      contentType: "application/merge-patch+json",
    });
    if (r.status >= 300 && r.status !== 404) {
      throw new Error(`agent-sandbox suspend failed: ${r.status}`);
    }
    // Suspended=True 的观测信号就是 backing Pod 消失（PodTerminated）
    await this.waitPodGone(name, this.deleteWaitMs);
  }

  async resume(sandboxId: string, spec?: SandboxSpec): Promise<void> {
    const name = this.sandboxName(sandboxId);
    const s = spec ?? this.specs.get(sandboxId);
    if (s) this.specs.set(sandboxId, s);
    const patch = await this.api.req({
      method: "PATCH",
      path: `${this.crdBase}/${name}`,
      body: { spec: { operatingMode: "Running" } },
      contentType: "application/merge-patch+json",
    });
    if (patch.status === 404) {
      // CR 已不存在（外部清理）：有 spec 则降级重建 CR，否则无法恢复
      if (!s) throw new Error(`agent-sandbox ${sandboxId} missing and no spec to recreate`);
      const r = await this.api.req({ method: "POST", path: this.crdBase, body: this.sandboxBody(sandboxId, s) });
      if (r.status >= 300 && r.status !== 409) throw new Error(`agent-sandbox resume recreate failed: ${r.status}`);
    } else if (patch.status >= 300) {
      throw new Error(`agent-sandbox resume failed: ${patch.status}`);
    }
    await this.waitRunning(name, this.podStartTimeoutMs);
  }

  async destroy(sandboxId: string): Promise<void> {
    const name = this.sandboxName(sandboxId);
    await this.api
      .req({
        method: "DELETE",
        path: `${this.crdBase}/${name}`,
        body: { gracePeriodSeconds: 1 },
      })
      .catch(() => undefined);
    // CR 消失是第一确认；backing Pod 由控制器级联删除，Pod 仍在 = 未确认（orphan 重试）
    await this.waitSandboxGone(name, this.deleteWaitMs);
    try {
      await this.waitPodGone(name, this.deleteWaitMs);
    } catch {
      throw new Error(`agent-sandbox ${name}: CR deleted but backing pod still exists`);
    }
    this.specs.delete(sandboxId);
  }

  private async waitSandboxGone(name: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.api
        .req({ method: "GET", path: `${this.crdBase}/${name}` })
        .catch(() => ({ status: 404, body: {} as Record<string, unknown> }));
      if (r.status === 404) return;
      if (Date.now() > deadline) throw new Error(`agent-sandbox ${name} not deleted within ${timeoutMs}ms`);
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}
