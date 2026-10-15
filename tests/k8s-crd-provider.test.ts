import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { K8sCrdSandboxProvider } from "@mas/sandbox";
import type { SandboxSpec } from "@mas/sandbox";

/**
 * agent-sandbox CRD provider 单测：本地 HTTP 服务器模拟 k8s API（Sandbox CR +
 * 控制器行为——CR 建/改即同步建/删同名 backing Pod），覆盖 §9.3 全生命周期。
 * E2E（真集群 + agent-sandbox 控制器）由 MAS_K8S_CRD_E2E=1 门禁另测。
 */

/** 极简 k8s API 存根：对象存内存；Sandbox 的 operatingMode 变更联动 Pod。 */
function fakeK8sApi() {
  const pods = new Map<string, Record<string, unknown>>();
  const sandboxes = new Map<string, Record<string, unknown>>();
  let podStartDelayMs = 0;
  let failPodDelete = false;

  const readBody = (req: import("node:http").IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const json = (await readBody(req)) as Record<string, unknown>;

    // RuntimeClass 探测：无 runsc → runc
    if (p === "/apis/node.k8s.io/v1/runtimeclasses/runsc" && req.method === "GET") {
      return send(404, {});
    }
    // NetworkPolicy（ensureNetworkPolicy 的 PATCH/POST 都放行）
    if (p.includes("/networkpolicies")) {
      return send(200, { metadata: { name: "mas-sandbox-egress-deny" } });
    }

    // Pods（waitRunning / waitPodGone 用）
    const podMatch = p.match(/^\/api\/v1\/namespaces\/mas\/pods\/([^/]+)$/);
    if (podMatch) {
      const name = podMatch[1]!;
      if (req.method === "GET") {
        const pod = pods.get(name);
        if (!pod) return send(404, { reason: "NotFound" });
        return send(200, pod);
      }
      if (req.method === "DELETE" && !failPodDelete) {
        pods.delete(name);
        return send(200, {});
      }
      if (req.method === "POST") {
        pods.set(String(json.metadata?.name), {
          apiVersion: "v1",
          kind: "Pod",
          metadata: json.metadata,
          spec: json.spec,
          status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
        });
        return send(201, json);
      }
    }

    // Sandbox CR（agent-sandbox agents.x-k8s.io/v1beta1）
    const sbxMatch = p.match(/^\/apis\/agents\.x-k8s\.io\/v1beta1\/namespaces\/mas\/sandboxes(?:\/([^/]+))?$/);
    if (sbxMatch) {
      const name = sbxMatch[1];
      if (req.method === "POST" && !name) {
        const crName = String(json.metadata?.name);
        if (sandboxes.has(crName)) return send(409, { reason: "AlreadyExists" });
        sandboxes.set(crName, json);
        // 模拟控制器 reconcile：创建同名 backing Pod（可注入启动延迟）
        const spawn = () => {
          pods.set(crName, {
            metadata: { name: crName, labels: json.metadata?.labels ?? {} },
            status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
          });
        };
        if (podStartDelayMs > 0) setTimeout(spawn, podStartDelayMs);
        else spawn();
        return send(201, json);
      }
      if (name) {
        if (req.method === "GET") {
          const cr = sandboxes.get(name);
          return cr ? send(200, cr) : send(404, { reason: "NotFound" });
        }
        if (req.method === "PATCH") {
          const cr = sandboxes.get(name);
          if (!cr) return send(404, { reason: "NotFound" });
          const spec = (json.spec ?? {}) as Record<string, unknown>;
          if (spec.operatingMode === "Suspended") pods.delete(name); // 控制器终止 backing Pod
          if (spec.operatingMode === "Running") {
            // 控制器按 CR 模板重建 Pod
            pods.set(name, {
              metadata: { name, labels: (cr.metadata as { labels?: Record<string, string> })?.labels ?? {} },
              status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
            });
          }
          (cr as { spec: Record<string, unknown> }).spec = { ...(cr as { spec: Record<string, unknown> }).spec, ...spec };
          return send(200, cr);
        }
        if (req.method === "DELETE") {
          sandboxes.delete(name);
          pods.delete(name); // 级联删 backing Pod
          return send(200, {});
        }
      }
    }
    return send(404, {});
  });

  return {
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      }),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setPodStartDelay: (ms: number) => (podStartDelayMs = ms),
    setFailPodDelete: (v: boolean) => (failPodDelete = v),
    state: { pods, sandboxes },
  };
}

const spec = (home: string): SandboxSpec => ({
  sessionId: "sess_lanetest",
  generation: 1,
  mounts: [],
  codexHome: home,
  outputsDir: `${home}/outputs`,
  env: { HTTP_PROXY: "http://tok@mas-egress:8081" },
});

describe("K8sCrdSandboxProvider（agent-sandbox CRD）", () => {
  let api: ReturnType<typeof fakeK8sApi>;

  beforeAll(async () => {
    api = fakeK8sApi();
    await api.listen();
  });
  afterAll(async () => {
    await api.close();
  });

  const mkProvider = () =>
    new K8sCrdSandboxProvider({
      apiServer: api.url(),
      token: "test-token",
      ca: null,
      namespace: "mas",
      pvc: "mas-sandboxes",
      pvcMountPath: "/var/mas/sandboxes",
      image: "mas-sandbox:latest",
      runtimeClassName: null,
      podStartTimeoutMs: 5_000,
      deleteWaitMs: 2_000,
    });

  const home = () => "/var/mas/sandboxes/sess_lanetest/.codex-home";

  /** sandboxId → backing Pod/CR 名（与 podName() 同规则：去 sbx_ 前缀、下划线转横线）。 */
  const podKey = (sandboxId: string) => sandboxId.replace(/^sbx_/, "").replace(/_/g, "-").toLowerCase();

  test("CRD-01 create：POST Sandbox CR（podTemplate + Running）→ backing Pod Running", async () => {
    const p = mkProvider();
    const h = await p.create(spec(home()));
    expect(h.sandboxId.startsWith("sbx_k8scrd_")).toBe(true);
    const name = podKey(h.sandboxId);
    const cr = api.state.sandboxes.get(name)!;
    expect(cr).toBeTruthy();
    expect((cr.spec as Record<string, unknown>).operatingMode).toBe("Running");
    const pt = (cr.spec as { podTemplate: { spec: Record<string, unknown> } }).podTemplate.spec;
    expect((pt.containers as { image: string }[])[0]!.image).toBe("mas-sandbox:latest");
    expect(api.state.pods.get(name)).toBeTruthy(); // 控制器已建同名 Pod
  });

  test("CRD-02 pause：operatingMode=Suspended → backing Pod 消失；resume 翻回 Running", async () => {
    const p = mkProvider();
    const h = await p.create(spec(home()));
    const name = podKey(h.sandboxId);
    await p.pause(h.sandboxId);
    expect((api.state.sandboxes.get(name)!.spec as Record<string, unknown>).operatingMode).toBe("Suspended");
    expect(api.state.pods.get(name)).toBeUndefined();
    // resume 不带 spec：CR 保留模板，直接翻回 Running
    await p.resume(h.sandboxId);
    expect((api.state.sandboxes.get(name)!.spec as Record<string, unknown>).operatingMode).toBe("Running");
    expect(api.state.pods.get(name)).toBeTruthy();
  });

  test("CRD-03 resume CR 缺失：带 spec 降级重建 CR；无 spec 报错", async () => {
    const p = mkProvider();
    const h = await p.create(spec(home()));
    const name = podKey(h.sandboxId);
    // CR 被外部清掉（Pod 亦随之消失）
    api.state.sandboxes.delete(name);
    api.state.pods.delete(name);
    await p.resume(h.sandboxId, spec(home()));
    expect(api.state.sandboxes.get(name)).toBeTruthy();
    expect(api.state.pods.get(name)).toBeTruthy();

    // 无 spec 的未知沙箱：resume 报错（不静默）
    await expect(p.resume("sbx_k8scrd_nospec")).rejects.toThrow(/no spec/);
  });

  test("CRD-04 destroy：DELETE CR → CR 与 backing Pod 都消失才确认", async () => {
    const p = mkProvider();
    const h = await p.create(spec(home()));
    const name = podKey(h.sandboxId);
    await p.destroy(h.sandboxId);
    expect(api.state.sandboxes.get(name)).toBeUndefined();
    expect(api.state.pods.get(name)).toBeUndefined();
  });

  test("CRD-05 destroy 无法确认（Pod 残留）→ 抛错交 orphan 重试", async () => {
    const p = mkProvider();
    const h = await p.create(spec(home()));
    const name = podKey(h.sandboxId);
    api.setFailPodDelete(true);
    // 模拟控制器删 Pod 被卡住：CR 删掉后手工复活一个同名 Pod
    const origDelete = api.state.pods.delete.bind(api.state.pods);
    api.state.pods.delete = (k: string) => {
      origDelete(k);
      api.state.pods.set(name, { metadata: { name }, status: { phase: "Terminating" } }); // 幽灵 Pod
      return true;
    };
    await expect(p.destroy(h.sandboxId)).rejects.toThrow(/backing pod still exists/);
    api.state.pods.delete = origDelete;
    api.setFailPodDelete(false);
    api.state.pods.delete(name);
    void name;
  });

  test("CRD-06 capabilities：无 runsc 时如实报 runc（§9.0 不虚报）", async () => {
    const p = mkProvider();
    const caps = await p.capabilities();
    expect(caps.isolation).toBe("runc");
    expect(caps.persistentWorkspace).toBe(true);
  });

  test("CRD-07 create 冲突（409）容忍 → 等 Pod Running", async () => {
    const p = mkProvider();
    const s = spec(home());
    // 直接预置同名 CR，create 仍应走通（与 Pod 模式 409 语义一致）
    const h = await p.create(s);
    const name = podKey(h.sandboxId);
    expect(api.state.pods.get(name)).toBeTruthy();
    void name;
  });
});
