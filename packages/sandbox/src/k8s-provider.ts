import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import type { RemoteSpawnContext } from "@mas/runtime";
import type {
  ProviderCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./index.js";
import { buildExecArgv, wsExec } from "./ws-exec.js";

/**
 * K8sSandboxProvider：沙箱 = 集群内 Pod（单节点 k3s 形态，deploy/k8s/56-sandbox-rbac.yaml）。
 * - API 直连（https + ServiceAccount token，零依赖；集群外测试用 MAS_K8S_TOKEN）；
 * - 工作区共享：worker 与沙箱 Pod 挂同一 PVC，沙箱以 subPath 绑定会话目录
 *   （worker 的 TMPDIR 指到 PVC 挂载点，fakeCodexHome 会话目录即 PVC 子目录）；
 * - 隔离：节点装有 runsc RuntimeClass 时 gvisor（如实探测，无则 runc）；
 * - egress：下发 NetworkPolicy——沙箱直连出网默认拒绝，只放行 egress-proxy(8081) 与
 *   kube-dns(53)（spec §10 强制模型；k3s 自带 policy 控制器时生效）→ 上报 advisory，
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
  /** PATCH 必须按 k8s 要求指定 patch content-type（默认 application/json） */
  contentType?: string;
}

class K8sApi {
  constructor(
    readonly server: string,
    readonly token: string,
    readonly ca: Buffer | undefined,
  ) {}

  /** status 返回体；404 时抛 { status: 404 }（调用方按需吞掉）。 */
  async req<T = Record<string, unknown>>(opts: K8sRequestOptions): Promise<{ status: number; body: T }> {
    const url = new URL(`${this.server}${opts.path}`);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    // http:// 仅测试桩用（本地假 API）；集群内一律 https
    const doRequest = url.protocol === "http:" ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const r = doRequest(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "http:" ? 80 : 443),
          path: url.pathname + url.search,
          method: opts.method,
          ...(url.protocol === "http:"
            ? {}
            : this.ca
              ? { ca: this.ca }
              : { rejectUnauthorized: false }),
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(payload !== undefined
              ? { "content-type": opts.contentType ?? "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
          },
          timeout: 30_000,
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
  readonly kind: string = "k8s";
  protected readonly api: K8sApi;
  protected readonly namespace: string;
  private readonly pvc: string;
  private readonly pvcMountPath: string;
  protected readonly image: string;
  /** "k=v,k2=v2" → Pod nodeSelector。 */
  private readonly nodeSelector: Record<string, string> | undefined;
  protected runscAvailable: boolean | undefined;
  /** Pod 起 Running 的等待上限（ms）。 */
  protected readonly podStartTimeoutMs: number;
  /** pause 语义需要重建：sandboxId → spec。 */
  protected specs = new Map<string, SandboxSpec>();
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

  protected podName(sandboxId: string): string {
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

  protected async hasRunsc(): Promise<boolean> {
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
      // NetworkPolicy 已下发（只放行 egress-proxy 与 kube-dns，直连出网被拒）；
      // 是否强制取决于 CNI——k3s 自带 policy 控制器时生效，不虚报 enforced
      egress: "advisory",
    };
  }

  /**
   * driver 进沙箱（spec §8.4 真实形态）：在沙箱容器里 spawn 进程，
   * stdio 经 pods/exec 的 WebSocket（v4.channel.k8s.io）；宿主路径经 toContainerPath 映射。
   * Pod env 里已有出站代理/CA（§10.4 attach），exec 进程继承。
   */
  exec(sandboxId: string): RemoteSpawnContext {
    const pod = this.podName(sandboxId);
    return {
      spawn: (opts) =>
        wsExec({
          server: this.api.server,
          token: this.api.token,
          ca: this.api.ca,
          namespace: this.namespace,
          pod,
          // exec API 无 env 参数：sh -c 包一层（export 后 exec 目标命令）
          command: buildExecArgv(opts),
        }),
      toContainerPath: (hostPath) => this.toContainerPath(sandboxId, hostPath),
    };
  }

  /** worker 宿主路径 → 容器内路径（按 create 时的挂载表换算；未知路径原样返回）。 */
  private toContainerPath(sandboxId: string, hostPath: string): string {
    const spec = this.specs.get(sandboxId);
    if (!spec) return hostPath;
    // 挂载目标可嵌套（outputsDir 物理上就在 codexHome 之下）：
    // 按宿主前缀最长匹配，保证子目录挂载优先于父目录挂载。
    const entries: { base: string; root: string }[] = [
      ...spec.mounts.map((m) => ({ base: m.hostPath, root: join("/mnt/session/uploads", m.mountPath) })),
      { base: spec.outputsDir, root: "/mnt/session/outputs" },
      { base: spec.codexHome, root: "/session/.codex" },
    ];
    let best: { root: string; rel: string; baseLen: number } | null = null;
    for (const e of entries) {
      const r = relative(e.base, hostPath);
      if (r !== "" && (r.startsWith("..") || isAbsolute(r))) continue;
      if (!best || e.base.length > best.baseLen) best = { root: e.root, rel: r, baseLen: e.base.length };
    }
    return best ? join(best.root, best.rel) : hostPath;
  }

  protected async ensureNetworkPolicy(): Promise<void> {
    if (this.netPolicyEnsured) return;
    const policy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "mas-sandbox-egress-deny", namespace: this.namespace },
      spec: {
        podSelector: { matchLabels: { "mas-sandbox": "true" } },
        policyTypes: ["Egress"],
        // spec §10 强制模型：沙箱直连出网一律拒绝，唯一例外是 egress-proxy 与 DNS
        egress: [
          {
            to: [{ podSelector: { matchLabels: { app: "mas-egress" } } }],
            ports: [{ protocol: "TCP", port: 8081 }],
          },
          {
            to: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    };
    const path = `/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`;
    // PATCH 优先：已存在的旧策略要就地更新（POST 对已存在只会 409 被吞掉）
    const patched = await this.api
      .req({
        method: "PATCH",
        path: `${path}/mas-sandbox-egress-deny`,
        body: policy,
        contentType: "application/merge-patch+json",
      })
      .catch(() => undefined);
    if (!patched || patched.status === 404) {
      await this.api.req({ method: "POST", path, body: policy }).catch(() => undefined);
    }
    this.netPolicyEnsured = true;
  }

  protected buildPod(sandboxId: string, spec: SandboxSpec): Record<string, unknown> {
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: this.podName(sandboxId),
        namespace: this.namespace,
        labels: { "mas-sandbox": "true", "mas-sandbox-id": sandboxId, "mas-session": spec.sessionId },
      },
      spec: this.buildPodSpec(sandboxId, spec),
    };
  }

  /** PodSpec 部分（agent-sandbox CRD 模式复用：Sandbox.spec.podTemplate.spec）。 */
  protected buildPodSpec(sandboxId: string, spec: SandboxSpec): Record<string, unknown> {
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
      restartPolicy: "Never",
      ...(this.nodeSelector ? { nodeSelector: this.nodeSelector } : {}),
      ...(this.runscAvailable ? { runtimeClassName: "runsc" } : {}),
      containers: [
        {
          name: "sandbox",
          image: this.image,
          imagePullPolicy: "IfNotPresent",
          command: ["sleep", "infinity"],
          ...(spec.env && Object.keys(spec.env).length > 0
            ? { env: Object.entries(spec.env).map(([name, value]) => ({ name, value })) }
            : {}),
          volumeMounts: mounts.map((m) => ({
            name: "workspace",
            mountPath: m.mountPath,
            subPath: m.subPath,
            ...(m.readOnly ? { readOnly: true } : {}),
          })),
        },
      ],
      volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: this.pvc } }],
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

  protected async waitRunning(name: string, timeoutMs: number): Promise<void> {
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

  async resume(sandboxId: string, spec?: SandboxSpec): Promise<void> {
    // pause = 删 Pod，resume 重建：spec 优先取调用方传入（sessions.sandbox_spec，
    // worker 重启后仍可恢复），其次本进程内存（同 worker pause→resume）
    const s = spec ?? this.specs.get(sandboxId);
    if (!s) throw new Error(`k8s sandbox ${sandboxId} unknown（无 spec，无法重建 Pod）`);
    this.specs.set(sandboxId, s);
    const r = await this.api.req({
      method: "POST",
      path: `/api/v1/namespaces/${this.namespace}/pods`,
      body: this.buildPod(sandboxId, s),
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
    await this.waitPodGone(name, 30_000);
  }

  /** 等待 Pod 对象消失（PVC subPath 复用同名 Pod 需要旧对象先消失）。 */
  protected async waitPodGone(name: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.api
        .req({ method: "GET", path: `/api/v1/namespaces/${this.namespace}/pods/${name}` })
        .catch(() => ({ status: 404, body: {} as Record<string, unknown> }));
      if (r.status === 404) return;
      if (Date.now() > deadline) throw new Error(`k8s sandbox pod ${name} not deleted within ${timeoutMs}ms`);
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
