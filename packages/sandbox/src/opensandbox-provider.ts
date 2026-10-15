import { request as httpRequest } from "node:http";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import type { StdioProcess, RemoteSpawnContext } from "@mas/runtime";
import type {
  ProviderCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./index.js";

/**
 * OpenSandboxProvider（spec §9.1 首选）：沙箱 = OpenSandbox lifecycle API 的 sandbox。
 *
 * - lifecycle（MAS_OSB_SERVER，OPEN-SANDBOX-API-KEY）：POST /v1/sandboxes（image+entrypoint+env
 *   +volumes(host bind)+networkPolicy）→ 202 {id, status.state}；pause/resume 异步（202 → 轮询
 *   GET 至 Paused/Running）；DELETE → Stopping→Terminated（等消失才算确认，否则 orphan 重试）；
 * - execd（固定端口 44772，经 GET /v1/sandboxes/{id}/endpoints/{port} 解析）：/files/upload +
 *   /command（SSE 单向输出，**无交互 stdin**）——spec §9.1 预案：沙箱内跑**轻量 stdio-bridge**
 *   （零依赖 node 单文件，本文件内嵌），worker 经 bridge 的 HTTP/SSE 通道获得双向 stdio；
 * - egress：create 下发 networkPolicy（deny-by-default，只放行 egress-proxy 主机），
 *   真实白名单在 egress-proxy（spec §10.1 两层防护）；上报 advisory（§9.0 不虚报 enforced）；
 * - 沙箱创建不带 timeout（不自动过期），空闲回收由平台 reaper 负责（spec §9.3）。
 *
 * 开关：MAS_SANDBOX_PROVIDER=opensandbox（driver.py 工厂）。E2E 需 OpenSandbox server；
 * 单测用本地桩（tests/opensandbox-provider.test.ts）。
 */

/** 沙箱内 stdio-bridge：TCP→HTTP/SSE ↔ 子进程 stdio 双向桥（execd 无 stdin 的替代通道）。 */
export const BRIDGE_SCRIPT = String.raw`#!/usr/bin/env node
// mas-stdio-bridge（OpenSandboxProvider 内嵌，spec §9.1 stdio-bridge 预案）
import http from "node:http";
import { spawn } from "node:child_process";
const a = process.argv.slice(2);
const pi = a.indexOf("--port");
const dd = a.indexOf("--");
if (pi < 0 || dd < 0 || dd < pi) { console.error("usage: bridge --port N -- cmd args"); process.exit(2); }
const port = Number(a[pi + 1]);
const cmd = a.slice(dd + 1);
if (!port || cmd.length === 0) { console.error("bad port/argv"); process.exit(2); }
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
const clients = new Set();
const buf = [];
let exitCode = null;
const sse = (ev, data) => "event: " + ev + "\ndata: " + data + "\n\n";
const push = (ev, text) => {
  buf.push([ev, text]);
  if (buf.length > 10000) buf.shift();
  for (const r of clients) r.write(sse(ev, text));
};
child.stdout.on("data", (d) => push("stdout", d.toString("base64")));
child.stderr.on("data", (d) => push("stderr", d.toString("base64")));
child.on("error", (e) => push("stderr", Buffer.from(String(e)).toString("base64")));
child.on("exit", (code) => {
  exitCode = code ?? 0;
  for (const r of clients) { r.write(sse("exit", String(exitCode))); r.end(); }
  clients.clear();
});
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ping") { res.writeHead(200); return res.end("ok"); }
  if (u.pathname === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const [ev, t] of buf) res.write(sse(ev, t));
    if (exitCode !== null) { res.write(sse("exit", String(exitCode))); return res.end(); }
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (u.pathname === "/input" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (exitCode === null) child.stdin.write(Buffer.concat(chunks));
      res.writeHead(202); res.end();
    });
    return;
  }
  if (u.pathname === "/kill" && req.method === "POST") {
    child.kill("SIGKILL");
    res.writeHead(200); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(port, "0.0.0.0", () => console.log("bridge ready on " + port));
`;

export const EXECD_DEFAULT_PORT = 44772;

export interface OpenSandboxProviderOptions {
  /** lifecycle server 基址（如 http://lifecycle.opensandbox:8080；/v1 自动补）。 */
  serverUrl?: string;
  /** API key（OPEN-SANDBOX-API-KEY 头）。 */
  apiKey?: string;
  image?: string;
  /** 创建时的 resourceLimits（server 要求标准模式必填）。 */
  cpu?: string;
  memory?: string;
  /** capabilities.isolation 如实声明（§9.0 禁止虚报；缺省 runc）。 */
  isolation?: "gvisor" | "microvm" | "runc";
  /** endpoint URL scheme（网关形态；自建无 TLS 用 http）。 */
  endpointScheme?: string;
  /** create 时是否下发 host bind volumes（同宿主 runtime 才有意义）。 */
  hostMounts?: boolean;
  /** 生命周期状态轮询间隔/上限。 */
  pollMs?: number;
  stateTimeoutMs?: number;
}

export class OpenSandboxProvider implements SandboxProvider {
  readonly kind = "opensandbox";
  private readonly base: string;
  private readonly apiKey: string;
  private readonly image: string;
  private readonly cpu: string;
  private readonly memory: string;
  private readonly isolation: "gvisor" | "microvm" | "runc";
  private readonly endpointScheme: string;
  private readonly hostMounts: boolean;
  private readonly pollMs: number;
  private readonly stateTimeoutMs: number;
  /** sandboxId(平台) → spec：toContainerPath 映射。 */
  private specs = new Map<string, SandboxSpec>();
  private bridgePortSeq = Math.floor(Math.random() * 1000);

  constructor(opts: OpenSandboxProviderOptions = {}) {
    const server = opts.serverUrl ?? process.env.MAS_OSB_SERVER;
    if (!server) throw new Error("OpenSandboxProvider 需要 MAS_OSB_SERVER（lifecycle server 基址）");
    this.base = server.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.apiKey = opts.apiKey ?? process.env.MAS_OSB_API_KEY ?? "";
    this.image = opts.image ?? process.env.MAS_OSB_IMAGE ?? "mas-sandbox:latest";
    this.cpu = opts.cpu ?? process.env.MAS_OSB_CPU ?? "2";
    this.memory = opts.memory ?? process.env.MAS_OSB_MEMORY ?? "2Gi";
    this.isolation = opts.isolation ?? (process.env.MAS_OSB_ISOLATION as OpenSandboxProviderOptions["isolation"]) ?? "runc";
    this.endpointScheme = opts.endpointScheme ?? process.env.MAS_OSB_ENDPOINT_SCHEME ?? "http";
    this.hostMounts = opts.hostMounts ?? process.env.MAS_OSB_HOST_MOUNTS !== "0";
    this.pollMs = opts.pollMs ?? 1000;
    this.stateTimeoutMs = opts.stateTimeoutMs ?? 60_000;
  }

  // ---- HTTP（零依赖，同 K8sApi 风格；OpenSandbox 是明文 HTTP API，也兼容 https） ----

  private req<T = Record<string, unknown>>(server: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const url = new URL(`${server}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const r = httpRequest(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method,
          headers: {
            "OPEN-SANDBOX-API-KEY": this.apiKey,
            accept: "application/json",
            ...(payload !== undefined
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
            ...extraHeaders,
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              parsed = { raw: text };
            }
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error(`opensandbox api timeout: ${method} ${path}`)));
      r.on("error", reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw last;
  }

  // ---- lifecycle：创建 / 状态 / pause / resume / destroy ----

  private createPayload(sandboxId: string, spec: SandboxSpec): Record<string, unknown> {
    const volumes = this.hostMounts
      ? [
          { name: "codex-home", host: { path: spec.codexHome }, mountPath: "/session/.codex" },
          { name: "outputs", host: { path: spec.outputsDir }, mountPath: "/mnt/session/outputs" },
          ...spec.mounts.map((m, i) => ({
            name: `mount-${i}`,
            host: { path: m.hostPath },
            mountPath: `/mnt/session/uploads/${m.mountPath}`,
            readOnly: true,
          })),
        ]
      : [];
    return {
      image: { uri: this.image },
      entrypoint: ["tail", "-f", "/dev/null"],
      env: spec.env ?? {},
      resourceLimits: { cpu: this.cpu, memory: this.memory },
      // 不设 timeout：不自动过期，空闲回收归平台 reaper（spec §9.3）
      metadata: { "mas-sandbox-id": sandboxId, "mas-session": spec.sessionId },
      ...(volumes.length > 0 ? { volumes } : {}),
      // egress 两层防护的内层：sidecar deny-by-default，仅放行 egress-proxy（spec §9.1/§10.1）
      ...(spec.env?.HTTP_PROXY || spec.env?.HTTPS_PROXY
        ? {
            networkPolicy: {
              defaultAction: "deny",
              egress: [{ action: "allow", target: "egress" }],
            },
          }
        : {}),
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandboxId = `sbx_osb_${randomUUID().slice(0, 12)}`;
    const r = await this.req<{ id?: string; status?: { state?: string } }>(
      this.base, "POST", "/v1/sandboxes", this.createPayload(sandboxId, spec),
    );
    if (r.status >= 300 || !r.body.id) {
      throw new Error(`opensandbox create failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    // create 文档：同步供给完成（202 返回即 Running）；兜底轮询 Pending → Running
    await this.waitState(r.body.id, ["Running"], ["Failed"]);
    this.specs.set(r.body.id, spec);
    return {
      sandboxId: `sbx_osb_${r.body.id}`,
      workspaceDir: "/session/.codex",
      outputsDir: spec.outputsDir,
      uploadsDir: join(spec.codexHome, "uploads"),
    };
  }

  private osbId(sandboxId: string): string {
    return sandboxId.replace(/^sbx_osb_/, "");
  }

  private async waitState(id: string, ok: string[], fail: string[]): Promise<string> {
    const deadline = Date.now() + this.stateTimeoutMs;
    for (;;) {
      const r = await this.req<{ status?: { state?: string } }>(this.base, "GET", `/v1/sandboxes/${id}`);
      const state = r.body.status?.state ?? (r.status === 404 ? "Terminated" : "Unknown");
      if (ok.includes(state)) return state;
      if (fail.includes(state)) throw new Error(`opensandbox ${id} entered ${state}`);
      if (Date.now() > deadline) throw new Error(`opensandbox ${id} not in [${ok}] within ${this.stateTimeoutMs}ms (state=${state})`);
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
  }

  async pause(sandboxId: string): Promise<void> {
    const id = this.osbId(sandboxId);
    const r = await this.req(this.base, "POST", `/v1/sandboxes/${id}/pause`);
    if (r.status >= 300 && r.status !== 404) throw new Error(`opensandbox pause failed: ${r.status}`);
    // 404 = 外部已删；等 Paused/消失即可
    await this.waitState(id, ["Paused", "Terminated"], ["Failed"]);
  }

  async resume(sandboxId: string, spec?: SandboxSpec): Promise<void> {
    const id = this.osbId(sandboxId);
    if (spec) this.specs.set(id, spec);
    const r = await this.req(this.base, "POST", `/v1/sandboxes/${id}/resume`);
    if (r.status >= 300 && r.status !== 404) throw new Error(`opensandbox resume failed: ${r.status}`);
    // 404 = 沙箱被外部清理：抛错 → worker 侧销毁重建（acquireRuntime 降级路径）
    await this.waitState(id, ["Running"], ["Failed"]);
  }

  async destroy(sandboxId: string): Promise<void> {
    const id = this.osbId(sandboxId);
    const r = await this.req(this.base, "DELETE", `/v1/sandboxes/${id}`).catch(() => ({ status: 0, body: {} }));
    if (r.status >= 300 && r.status !== 404) throw new Error(`opensandbox destroy failed: ${r.status}`);
    await this.waitState(id, ["Terminated"], []); // 消失（404→Terminated 语义）才算确认
    this.specs.delete(id);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      isolation: this.isolation,
      persistentWorkspace: true, // pause 保留状态；host mounts 常驻
      // networkPolicy sidecar deny-by-default 是内层强制，真实白名单在 egress-proxy；
      // 未探活前不虚报 enforced（§9.0）
      egress: "advisory",
    };
  }

  // ---- exec：execd 上传 bridge → 后台启动 → endpoint 解析 → StdioProcess ----

  /** 挂载表路径映射（与 k8s provider 相同的最长前缀规则）。 */
  private toContainerPath(sandboxId: string, hostPath: string): string {
    const spec = this.specs.get(sandboxId);
    if (!spec) return hostPath;
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

  /** lifecycle endpoints API → 沙箱内端口的可达基址（轮询直到网关就绪）。 */
  private async endpointBase(id: string, port: number, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.withRetry(() =>
        this.req<{ endpoint?: string }>(this.base, "GET", `/v1/sandboxes/${id}/endpoints/${port}`),
      ).catch(() => ({ status: 0, body: {} as { endpoint?: string } }));
      if (r.status === 200 && r.body.endpoint) {
        return `${this.endpointScheme}://${r.body.endpoint}`;
      }
      if (Date.now() > deadline) throw new Error(`opensandbox endpoint ${port} unresolved within ${timeoutMs}ms`);
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
  }

  /** multipart 上传单文件（execd /files/upload：metadata + file 两段）。 */
  private async uploadFile(execdBase: string, path: string, content: string | Buffer): Promise<void> {
    const boundary = `mas-${randomUUID()}`;
    const meta = JSON.stringify({ path });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="metadata"\r\ncontent-type: application/json\r\n\r\n${meta}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="bridge.mjs"\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`${execdBase}/files/upload`);
      const r = httpRequest(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": body.length,
          },
          timeout: 30_000,
        },
        (res) => {
          res.resume();
          res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`execd upload failed: ${res.statusCode}`))));
        },
      );
      r.on("error", reject);
      r.end(body);
    });
  }

  exec(sandboxId: string): RemoteSpawnContext {
    const id = this.osbId(sandboxId);
    return {
      spawn: async (opts) => {
        const execdBase = await this.endpointBase(id, EXECD_DEFAULT_PORT);
        await this.uploadFile(execdBase, "/tmp/mas-stdio-bridge.mjs", BRIDGE_SCRIPT);
        // bridge 端口在沙箱内唯一即可；跨 spawn 递增避免 TIME_WAIT 复用
        const bridgePort = 20000 + (this.bridgePortSeq++ % 20000);
        const envs: Record<string, string> = {};
        for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) envs[k] = v;
        const cwd = opts.cwd ? this.toContainerPath(sandboxId, opts.cwd) : undefined;
        const started = await this.req<{ id?: string }>(execdBase, "POST", "/command", {
          // argv 形态：不经 shell 展开，参数原样传给 bridge
          argv: ["node", "/tmp/mas-stdio-bridge.mjs", "--port", String(bridgePort), "--", opts.command, ...opts.args],
          ...(cwd ? { cwd } : {}),
          envs,
          background: true,
        });
        if (started.status >= 300) {
          throw new Error(`opensandbox bridge start failed: ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`);
        }
        const bridgeBase = await this.endpointBase(id, bridgePort);
        await this.waitBridgeReady(bridgeBase);
        return this.bridgeProcess(bridgeBase);
      },
      toContainerPath: (hostPath) => this.toContainerPath(id, hostPath),
    };
  }

  private async waitBridgeReady(bridgeBase: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = await this.req(bridgeBase, "GET", "/ping").then((r) => r.status === 200).catch(() => false);
      if (ok) return;
      if (Date.now() > deadline) throw new Error(`opensandbox bridge not ready within ${timeoutMs}ms`);
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  /** StdioProcess over bridge：GET /stream（SSE）→ stdout/stderr/exit；POST /input → stdin。 */
  private bridgeProcess(bridgeBase: string): StdioProcess {
    let exited = false;
    let exitCode: number | null = null;
    const exitCbs: ((code: number | null) => void)[] = [];

    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        const url = new URL(`${bridgeBase}/input`);
        const r = httpRequest(
          { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: "POST", headers: { "content-length": chunk.length } },
          (res) => {
            res.resume();
            res.on("end", () => cb());
          },
        );
        r.on("error", cb);
        r.end(chunk);
      },
    });

    const finish = (code: number) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      stdout.push(null);
      stderr.push(null);
      stdin.end();
      for (const cb of exitCbs) cb(code);
    };

    // SSE 解析：event/data 两行一组（bridge 的协议即此形态）
    void (async () => {
      try {
        const res = await fetch(`${bridgeBase}/stream`);
        const reader = res.body!.getReader();
        let pending = "";
        let currentEvent = "stdout";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += Buffer.from(value).toString("utf8");
          let idx: number;
          while ((idx = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, idx).replace(/\r$/, "");
            pending = pending.slice(idx + 1);
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (currentEvent === "stdout") stdout.push(Buffer.from(data, "base64"));
              else if (currentEvent === "stderr") stderr.push(Buffer.from(data, "base64"));
              else if (currentEvent === "exit") finish(Number(data) || 0);
            }
          }
        }
        finish(exitCode ?? 0);
      } catch {
        finish(exitCode ?? 1);
      }
    })();

    return {
      stdin,
      stdout,
      get exited() {
        return exited;
      },
      kill: () => {
        if (exited) return;
        const url = new URL(`${bridgeBase}/kill`);
        const r = httpRequest(
          { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: "POST", timeout: 5000 },
          (res) => res.resume(),
        );
        r.on("error", () => undefined);
        r.end();
      },
      onExit: (cb) => {
        if (exited) cb(exitCode);
        else exitCbs.push(cb);
      },
    };
  }
}
