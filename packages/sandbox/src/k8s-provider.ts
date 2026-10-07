import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import type {
  ProviderCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./index.js";

/**
 * K8sSandboxProvider：沙箱 = 集群内 Pod（单节点 k3s 形态，deploy/k8s/56-sandbox-rbac.yaml）。
 * - API 直连（https + ServiceAccount token，零依赖；集群外测试用 MAS_K8S_TOKEN）；
 * - 工作区共享：worker 与沙箱 Pod 挂同一 PVC，沙箱以 subPath 绑定会话目录
 *   （worker 的 TMPDIR 指到 PVC 挂载点，fakeCodexHome 会话目录即 PVC 子目录）；
 * - 隔离：节点装有 runsc RuntimeClass 时 gvisor（如实探测，无则 runc）；
 * - egress：打默认拒绝 NetworkPolicy（k3s 自带 policy 控制器时生效）→ 上报 advisory，
 *   不虚报 enforced（§9.0）；
 * - pause/resume：删除/重建 Pod（目录在 PVC 上保留；无容器冻结原语）；
 * - 销毁失败抛错（worker 侧记 sandbox_orphans，§9.3）。
 */

export interface K8sProviderOptions {
  /** API Server 地址；缺省用 in-cluster（https://kubernetes.default.svc）。 */
  apiServer?: string;
  /** Bearer token；缺省读 in-cluster ServiceAccount token。 */
  token?: string;
  /** CA PEM；缺省读 in-cluster ca.crt。测试直连节点 API 时可传 null 跳过校验。 */
  ca?: string | null;
  namespace?: string;
  /** 工作区 PVC 名与 worker 侧挂载点（subPath 换算用）。 */
  pvc?: string;
  pvcMountPath?: string;
  image?: string;
  /** 显式指定 RuntimeClass（缺省探测 runsc）。 */
  runtimeClassName?: string | null;
  /**
   * 沙箱 Pod nodeSelector（如 "mas-sandbox=true"）：多节点集群里 runsc/镜像只在
   * 部分节点就绪时把沙箱钉到打了标的节点；local-path PVC 也要求 worker 与沙箱同节点。
   */
  nodeSelector?: string;
  /** Pod 起 Running 的等待上限；缺省 MAS_K8S_POD_START_TIMEOUT_MS 或 60s。并发冷启
   *  风暴（几十个 runsc Pod 同时调度）下单节点 containerd 会排队，需要放大。 */
  podStartTimeoutMs?: number;
}

interface K8sRequestOptions {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
}

class K8sApi {
  constructor(
    private readonly server: string,
    private readonly token: string,
    private readonly ca: Buffer | undefined,
  ) {}

  /** status 返回体；404 时抛 { status: 404 }（调用方按需吞掉）。 */
  async req<T = Record<string, unknown>>(opts: K8sRequestOptions): Promise<{ status: number; body: T }> {
    const url = new URL(`${this.server}${opts.path}`);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    return new Promise((resolve, reject) => {
      const r = httpsRequest(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: opts.method,
          ...(this.ca ? { ca: this.ca } : { rejectUnauthorized: false }),
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(payload !== undefined
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
          },
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown;
            try {
              body = text ? JSON.parse(text) : {};
            } catch {
              body = { raw: text };
            }
            resolve({ status: res.statusCode ?? 0, body: body as T });
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error(`k8s api timeout: ${opts.method} ${opts.path}`)));
      r.on("error", reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  }
}

const IN_CLUSTER_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const IN_CLUSTER_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export class K8sSandboxProvider implements SandboxProvider {
  readonly kind = "k8s";
  private readonly api: K8sApi;
  private readonly namespace: string;
  private readonly pvc: string;
  private readonly pvcMountPath: string;
  private readonly image: string;
  /** "k=v,k2=v2" → Pod nodeSelector。 */
  private readonly nodeSelector: Record<string, string> | undefined;
  private runscAvailable: boolean | undefined;
  /** Pod 起 Running 的等待上限（ms）。 */
  private readonly podStartTimeoutMs: number;
  /** pause 语义需要重建：sandboxId → spec。 */
  private specs = new Map<string, SandboxSpec>();
  private netPolicyEnsured = false;

  constructor(opts: K8sProviderOptions = {}) {
    const apiServer = opts.apiServer ?? (existsSync(IN_CLUSTER_TOKEN) ? "https://kubernetes.default.svc" : process.env.MAS_K8S_API);
    if (!apiServer) throw new Error("K8sSandboxProvider 需要 apiServer 或 in-cluster ServiceAccount（或 MAS_K8S_API）");
    const token = opts.token ?? (existsSync(IN_CLUSTER_TOKEN) ? readFileSync(IN_CLUSTER_TOKEN, "utf8").trim() : process.env.MAS_K8S_TOKEN);
    if (!token) throw new Error("K8sSandboxProvider 需要 token（in-cluster ServiceAccount 或 MAS_K8S_TOKEN）");
    const ca = opts.ca === null ? undefined : opts.ca ?? (existsSync(IN_CLUSTER_CA) ? readFileSync(IN_CLUSTER_CA, "utf8") : undefined);
    this.api = new K8sApi(apiServer.replace(/\/$/, ""), token, ca ? Buffer.from(ca) : undefined);
    this.namespace = opts.namespace ?? process.env.MAS_K8S_NAMESPACE ?? "mas";
    this.pvc = opts.pvc ?? process.env.MAS_K8S_PVC ?? "mas-sandboxes";
    this.pvcMountPath = opts.pvcMountPath ?? process.env.MAS_K8S_PVC_MOUNT ?? "/var/mas/sandboxes";
    this.image = opts.image ?? process.env.MAS_K8S_SANDBOX_IMAGE ?? "busybox:latest";
    const nsRaw = opts.nodeSelector ?? process.env.MAS_K8S_NODE_SELECTOR;
    this.nodeSelector = nsRaw
      ? Object.fromEntries(
          nsRaw
            .split(",")
            .map((kv) => kv.trim().split("="))
            .filter((p): p is [string, string] => p.length === 2 && Boolean(p[0]) && Boolean(p[1]))
            .map(([k, v]) => [k.trim(), v.trim()] as [string, string]),
        )
      : undefined;
    this.runscAvailable = opts.runtimeClassName === null ? false : opts.runtimeClassName ? true : undefined;
    this.podStartTimeoutMs =
      opts.podStartTimeoutMs ?? (Number(process.env.MAS_K8S_POD_START_TIMEOUT_MS) || 60_000);
  }

  private podName(sandboxId: string): string {
    return sandboxId.replace(/^sbx_/, "").replace(/_/g, "-").toLowerCase();
  }

  /** worker 侧绝对路径 → PVC subPath 相对路径。 */
  private subPath(p: string): string {
    const rel = isAbsolute(p) ? relative(this.pvcMountPath, p) : p;
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`k8s sandbox path ${p} is outside PVC mount ${this.pvcMountPath}`);
    }
    return rel;
  }

  private async hasRunsc(): Promise<boolean> {
    if (this.runscAvailable === undefined) {
      try {
        // RuntimeClass 是 cluster-scoped 资源（无 namespace 段）
        const r = await this.api.req({ method: "GET", path: "/apis/node.k8s.io/v1/runtimeclasses/runsc" });
        this.runscAvailable = r.status === 200;
      } catch {
        this.runscAvailable = false;
      }
    }
    return this.runscAvailable;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      isolation: (await this.hasRunsc()) ? "gvisor" : "runc",
      persistentWorkspace: true, // 工作区在 PVC 上，Pod 重建不丢
      egress: "advisory", // NetworkPolicy 已下发；是否强制取决于 CNI（k3s 自带 policy 控制器时生效），不虚报 enforced
    };
  }

  private async ensureNetworkPolicy(): Promise<void> {
    if (this.netPolicyEnsured) return;
    const policy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "mas-sandbox-egress-deny", namespace: this.namespace },
      spec: {
        podSelector: { matchLabels: { "mas-sandbox": "true" } },
        policyTypes: ["Egress"],
        egress: [], // 默认拒绝；egress 经 egress-proxy 的路径后续按需放行
      },
    };
    await this.api.req({ method: "POST", path: `/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`, body: policy }).catch(() => undefined);
    this.netPolicyEnsured = true;
  }

  private buildPod(sandboxId: string, spec: SandboxSpec): Record<string, unknown> {
    const mounts: { subPath: string; mountPath: string; readOnly?: boolean }[] = [
      { subPath: this.subPath(spec.codexHome), mountPath: "/session/.codex" },
      { subPath: this.subPath(spec.outputsDir), mountPath: "/mnt/session/outputs" },
      ...spec.mounts.map((m) => ({
        subPath: this.subPath(m.hostPath),
        mountPath: `/mnt/session/uploads/${m.mountPath}`,
        readOnly: true,
      })),
    ];
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: this.podName(sandboxId),
        namespace: this.namespace,
        labels: { "mas-sandbox": "true", "mas-sandbox-id": sandboxId, "mas-session": spec.sessionId },
      },
      spec: {
        restartPolicy: "Never",
        ...(this.nodeSelector ? { nodeSelector: this.nodeSelector } : {}),
        ...(this.runscAvailable ? { runtimeClassName: "runsc" } : {}),
        containers: [
          {
            name: "sandbox",
            image: this.image,
            imagePullPolicy: "IfNotPresent",
            command: ["sleep", "infinity"],
            volumeMounts: mounts.map((m) => ({
              name: "workspace",
              mountPath: m.mountPath,
              subPath: m.subPath,
              ...(m.readOnly ? { readOnly: true } : {}),
            })),
          },
        ],
        volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: this.pvc } }],
      },
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    await this.hasRunsc();
    await this.ensureNetworkPolicy();
    const sandboxId = `sbx_k8s_${randomUUID().slice(0, 12)}`;
    this.specs.set(sandboxId, spec);
    const pod = this.buildPod(sandboxId, spec);
    const created = await this.api.req({
      method: "POST",
      path: `/api/v1/namespaces/${this.namespace}/pods`,
      body: pod,
    });
    if (created.status >= 300 && created.status !== 409) {
      const msg = JSON.stringify(created.body).slice(0, 300);
      throw new Error(`k8s create pod failed: ${created.status} ${msg}`);
    }
    try {
      await this.waitRunning(this.podName(sandboxId), this.podStartTimeoutMs);
    } catch (e) {
      await this.destroy(sandboxId).catch(() => undefined);
      throw e;
    }
    return {
      sandboxId,
      workspaceDir: "/session/.codex",
      outputsDir: spec.outputsDir, // 宿主（worker）侧路径：轮末收集在 worker 侧进行
      uploadsDir: join(spec.codexHome, "uploads"),
    };
  }

  private async waitRunning(name: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.api.req<{ status?: { phase?: string; conditions?: { type: string; status: string }[] } }>({
        method: "GET",
        path: `/api/v1/namespaces/${this.namespace}/pods/${name}`,
      });
      const phase = r.body.status?.phase;
      if (phase === "Running") return;
      if (phase === "Failed" || r.status === 404) {
        throw new Error(`k8s sandbox pod ${name} ${phase ?? r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      }
      if (Date.now() > deadline) throw new Error(`k8s sandbox pod ${name} not Running within ${timeoutMs}ms (${phase})`);
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  async pause(sandboxId: string): Promise<void> {
    // K8s 无容器冻结原语：删除 Pod、目录保留在 PVC（resume 重建）
    await this.deletePod(sandboxId);
  }

  async resume(sandboxId: string): Promise<void> {
    const spec = this.specs.get(sandboxId);
    if (!spec) throw new Error(`k8s sandbox ${sandboxId} unknown (worker 重启后不可 resume，应走 checkpoint 恢复)`);
    const r = await this.api.req({
      method: "POST",
      path: `/api/v1/namespaces/${this.namespace}/pods`,
      body: this.buildPod(sandboxId, spec),
    });
    if (r.status >= 300 && r.status !== 409) throw new Error(`k8s resume pod failed: ${r.status}`);
    await this.waitRunning(this.podName(sandboxId), this.podStartTimeoutMs);
  }

  private async deletePod(sandboxId: string): Promise<void> {
    const name = this.podName(sandboxId);
    await this.api
      .req({
        method: "DELETE",
        path: `/api/v1/namespaces/${this.namespace}/pods/${name}`,
        // sleep 持有进程不响应 SIGTERM：立即回收（grace 1s 后 SIGKILL）
        body: { gracePeriodSeconds: 1 },
      })
      .catch(() => undefined);
    // 等待删除完成（PVC subPath 复用同名 Pod 需要旧对象消失）
    const deadline = Date.now() + 30_000;
    for (;;) {
      const r = await this.api
        .req({ method: "GET", path: `/api/v1/namespaces/${this.namespace}/pods/${name}` })
        .catch(() => ({ status: 404, body: {} as Record<string, unknown> }));
      if (r.status === 404) return;
      if (Date.now() > deadline) throw new Error(`k8s sandbox pod ${name} not deleted within 30s`);
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    try {
      await this.deletePod(sandboxId);
      this.specs.delete(sandboxId);
    } catch (e) {
      throw e; // 无法确认销毁 → 调用方记 sandbox_orphans（§9.3）
    }
  }
}
