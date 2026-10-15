import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BRIDGE_SCRIPT, EXECD_DEFAULT_PORT, OpenSandboxProvider } from "@mas/sandbox";
import type { SandboxSpec } from "@mas/sandbox";

/**
 * OpenSandboxProvider 单测：本地桩模拟 lifecycle（创建/pause/resume/销毁/endpoint 解析）
 * 与 execd（/command /files/upload）。stdio-bridge 用真实脚本跑（execd 桩以子进程执行
 * BRIDGE 脚本 → worker 经真实 HTTP/SSE 通道收发）——不依赖 OpenSandbox server。
 * E2E（真 server）由 MAS_OSB_E2E=1 门禁另测。
 */

const BRIDGE_PORT = 45670; // 桩把 endpoint 直接解析回本机 bridge 端口

function fakeOpenSandbox(bridgeScriptPath: string) {
  const sandboxes = new Map<string, { state: string; createBody: Record<string, unknown> }>();
  let commands = 0;

  const readBody = (req: import("node:http").IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const send = (status: number, body: unknown = {}) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const raw = await readBody(req);

    // ---- lifecycle ----
    if (p === "/v1/sandboxes" && req.method === "POST") {
      const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const id = `osb-${sandboxes.size + 1}`;
      sandboxes.set(id, { state: "Running", createBody: body });
      return send(202, { id, status: { state: "Running", reason: "provisioned" } });
    }
    const sbx = p.match(/^\/v1\/sandboxes\/([^/]+)(?:\/(.*))?$/);
    if (sbx) {
      const id = sbx[1]!;
      const action = sbx[2];
      const sb = sandboxes.get(id);
      if (req.method === "GET" && !action) {
        if (!sb) return send(404, { message: "not found" });
        return send(200, { id, status: { state: sb.state } });
      }
      if (req.method === "DELETE" && !action) {
        if (!sb) return send(404, {});
        sb.state = "Terminated";
        return send(204);
      }
      if (req.method === "POST" && action === "pause") {
        if (!sb || sb.state === "Terminated") return send(404, {});
        sb.state = "Paused";
        return send(202, {});
      }
      if (req.method === "POST" && action === "resume") {
        if (!sb || sb.state === "Terminated") return send(404, {});
        sb.state = "Running";
        return send(202, {});
      }
      if (req.method === "GET" && action?.startsWith("endpoints/")) {
        if (!sb || sb.state !== "Running") return send(404, { message: "POD_IP_NOT_AVAILABLE" });
        // endpoint 直接解析回本机端口（真实部署是网关 URL，形态一致：host[:port][/path]）；
        // execd 与 lifecycle 同桩共宿 → 44772 映射回桩自身端口
        const port = Number(action.split("/")[1]);
        const target = port === EXECD_DEFAULT_PORT ? (server.address() as AddressInfo).port : port;
        return send(200, { endpoint: `127.0.0.1:${target}` });
      }
    }

    // ---- execd ----
    if (p === "/command" && req.method === "POST") {
      const body = JSON.parse(raw.toString("utf8")) as { argv?: string[]; background?: boolean };
      if (!body.argv || body.background !== true) return send(400, { message: "expect background argv" });
      // 以真实 bridge 脚本启动子进程（沙箱内执行的等价物）
      const { spawn } = await import("node:child_process");
      const child = spawn(body.argv[0]!, body.argv.slice(1), { stdio: "ignore", detached: true });
      child.unref();
      return send(200, { id: `cmd-${++commands}` });
    }
    if (p === "/files/upload" && req.method === "POST") {
      // multipart：解析 metadata 路径 + file 内容并真实落盘（bridge 以子进程执行）
      const text = raw.toString("latin1");
      const pathM = text.match(/\{"path":"([^"]+)"/);
      const i = text.indexOf('name="file"');
      const bodyStart = text.indexOf("\r\n\r\n", i) + 4;
      const bodyEnd = text.lastIndexOf("\r\n--");
      if (!pathM || i < 0 || bodyEnd <= bodyStart) return send(400, {});
      const { writeFileSync } = await import("node:fs");
      writeFileSync(pathM[1]!, text.slice(bodyStart, bodyEnd), "latin1");
      return send(200, {});
    }
    return send(404, {});
  });

  return {
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    state: { sandboxes, bridgePort: BRIDGE_PORT, bridgeScriptPath },
    void: EXECD_DEFAULT_PORT,
  };
}

const spec = (home: string): SandboxSpec => ({
  sessionId: "sess_osbtest",
  generation: 1,
  mounts: [],
  codexHome: home,
  outputsDir: `${home}/outputs`,
  env: { HTTPS_PROXY: "http://tok@mas-egress:8081" },
});

let osb: ReturnType<typeof fakeOpenSandbox>;
let bridgePath: string;

beforeAll(async () => {
  // 落盘真实 bridge 脚本（provider 内嵌常量导出，测试以子进程执行 = 沙箱内等价物）
  const { writeFileSync } = await import("node:fs");
  bridgePath = `/tmp/mas-stdio-bridge-test-${process.pid}.mjs`;
  writeFileSync(bridgePath, BRIDGE_SCRIPT);
  osb = fakeOpenSandbox(bridgePath);
  await osb.listen();
});
afterAll(async () => {
  await osb.close();
});

const mkProvider = () =>
  new OpenSandboxProvider({
    serverUrl: osb.url(),
    apiKey: "test-key",
    image: "mas-sandbox:latest",
    isolation: "runc",
    endpointScheme: "http",
    pollMs: 50,
    stateTimeoutMs: 5_000,
  });

describe("OpenSandboxProvider", () => {
  test("OSB-01 create：POST lifecycle → Running；payload 含 image/env/limits/metadata", async () => {
    const p = mkProvider();
    const h = await p.create(spec("/tmp/osb-home-1"));
    expect(h.sandboxId.startsWith("sbx_osb_")).toBe(true);
    const id = h.sandboxId.replace(/^sbx_osb_/, "");
    const rec = osb.state.sandboxes.get(id)!;
    expect((rec.createBody.image as { uri: string }).uri).toBe("mas-sandbox:latest");
    expect(rec.createBody.entrypoint).toEqual(["tail", "-f", "/dev/null"]);
    expect((rec.createBody.env as Record<string, string>).HTTPS_PROXY).toContain("mas-egress");
    expect(rec.createBody.resourceLimits).toEqual({ cpu: "2", memory: "2Gi" });
    expect((rec.createBody.metadata as Record<string, string>)["mas-session"]).toBe("sess_osbtest");
    // 有代理 env → networkPolicy deny + egress allow（§10.1 两层防护内层）
    expect((rec.createBody.networkPolicy as Record<string, unknown>).defaultAction).toBe("deny");
  });

  test("OSB-02 pause/resume：异步操作轮询至 Paused/Running；destroy 等 Terminated", async () => {
    const p = mkProvider();
    const h = await p.create(spec("/tmp/osb-home-2"));
    const id = h.sandboxId.replace(/^sbx_osb_/, "");
    await p.pause(h.sandboxId);
    expect(osb.state.sandboxes.get(id)!.state).toBe("Paused");
    await p.resume(h.sandboxId);
    expect(osb.state.sandboxes.get(id)!.state).toBe("Running");
    await p.destroy(h.sandboxId);
    expect(osb.state.sandboxes.get(id)!.state).toBe("Terminated");
    // 销毁后再 pause/resume：404 路径不炸（幂等收尾）
    await expect(p.resume(h.sandboxId)).rejects.toThrow(); // resume 等不到 Running → 抛错（worker 降级重建）
  });

  test("OSB-03 exec：bridge 真实跑通 stdout + exit（SSE 通道）", async () => {
    const p = mkProvider();
    const h = await p.create(spec("/tmp/osb-home-3"));
    const remote = p.exec(h.sandboxId)!;
    const proc = await remote.spawn({
      command: process.execPath,
      args: ["-e", "console.log('hello-bridge'); process.exit(0)"],
      env: { PATH: process.env.PATH ?? "" },
    });
    const out = await new Promise<string>((resolve, reject) => {
      let acc = "";
      proc.stdout.on("data", (d: Buffer) => (acc += d.toString("utf8")));
      proc.stdout.on("end", () => resolve(acc));
      proc.onExit((code) => {
        if (code !== 0) reject(new Error(`exit ${code}`));
      });
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    expect(out).toContain("hello-bridge");
    expect(proc.exited).toBe(true);
  });

  test("OSB-04 exec：stdin 双向（bridge POST /input → 子进程 stdin 回显）", async () => {
    const p = mkProvider();
    const h = await p.create(spec("/tmp/osb-home-4"));
    const remote = p.exec(h.sandboxId)!;
    // 子进程：读 stdin 每行回显
    const proc = await remote.spawn({
      command: process.execPath,
      args: ["-e", [
        "let buf='';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);console.log('echo:'+line);}});",
      ].join("")],
      env: { PATH: process.env.PATH ?? "" },
    });
    const got = await new Promise<string>((resolve, reject) => {
      let acc = "";
      proc.stdout.on("data", (d: Buffer) => {
        acc += d.toString("utf8");
        if (acc.includes("echo:ping-payload")) resolve(acc);
      });
      setTimeout(() => reject(new Error(`stdin echo timeout, got: ${acc}`)), 10_000);
      proc.stdin.write("ping-payload\n");
    });
    expect(got).toContain("echo:ping-payload");
    proc.kill();
  });

  test("OSB-05 capabilities：如实上报声明隔离级与 advisory egress（§9.0）", async () => {
    const p = mkProvider();
    const caps = await p.capabilities();
    expect(caps.isolation).toBe("runc");
    expect(caps.egress).toBe("advisory");
    expect(caps.persistentWorkspace).toBe(true);
  });

  test("OSB-06 toContainerPath：挂载表最长前缀映射", async () => {
    const p = mkProvider();
    const h = await p.create(spec("/tmp/osb-home-6"));
    const remote = p.exec(h.sandboxId)!;
    expect(remote.toContainerPath("/tmp/osb-home-6/outputs/x.txt")).toBe("/mnt/session/outputs/x.txt");
    expect(remote.toContainerPath("/tmp/osb-home-6/rollout.jsonl")).toBe("/session/.codex/rollout.jsonl");
    expect(remote.toContainerPath("/elsewhere/x")).toBe("/elsewhere/x");
  });
});
