import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type { StdioProcess } from "@mas/runtime";
import { encodeWsFrame, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, WsFrameParser } from "./ws-frame.js";

/**
 * K8s pods/exec 的 WebSocket 传输（子协议 v4.channel.k8s.io）：
 * 把容器内进程的 stdio 暴露为 StdioProcess（driver 进沙箱，spec §8.4/§9）。
 * 通道：0=stdin 1=stdout 2=stderr 3=error(status JSON) 4=resize。
 * exec API 不支持自定义 env → 用 sh -c 包一层（export 后 exec 目标命令）。
 */

export interface WsExecArgs {
  /** API Server 地址（https://...）。 */
  server: string;
  token: string;
  ca?: Buffer;
  namespace: string;
  pod: string;
  container?: string;
  /** 完整 argv（第一个元素为可执行文件）。 */
  command: string[];
}

/** 单引号安全嵌入。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 把 env/cwd/command 包成 sh -c 脚本（exec API 无 env 参数）。 */
export function buildExecArgv(opts: {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v !== undefined) lines.push(`export ${k}=${shq(v)}`);
  }
  if (opts.cwd) lines.push(`cd ${shq(opts.cwd)}`);
  lines.push(`exec ${[opts.command, ...opts.args].map(shq).join(" ")}`);
  return ["/bin/sh", "-c", lines.join("\n")];
}

export function wsExec(args: WsExecArgs): Promise<StdioProcess> {
  return new Promise((resolve, reject) => {
    const params = args.command.flatMap((c) => ["command", c]);
    const qs = new URLSearchParams();
    for (let i = 0; i < params.length; i += 2) qs.append(params[i]!, params[i + 1]!);
    qs.append("stdin", "1");
    qs.append("stdout", "1");
    qs.append("stderr", "1");
    if (args.container) qs.append("container", args.container);
    const url = new URL(`${args.server}/api/v1/namespaces/${args.namespace}/pods/${args.pod}/exec?${qs}`);

    const key = randomBytes(16).toString("base64");
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        ...(args.ca ? { ca: args.ca } : { rejectUnauthorized: false }),
        headers: {
          authorization: `Bearer ${args.token}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
          "sec-websocket-protocol": "v4.channel.k8s.io",
        },
        timeout: 15_000,
      },
      (res) => {
        reject(new Error(`ws exec upgrade failed: HTTP ${res.statusCode}`));
        res.resume();
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("ws exec handshake timeout"));
    });
    req.on("error", reject);
    req.on("upgrade", (res, socket, head) => {
      const proto = String(res.headers["sec-websocket-protocol"] ?? "");
      if (!proto.includes("v4.channel.k8s.io")) {
        socket.destroy();
        reject(new Error(`ws exec: server refused subprotocol (${proto || "none"})`));
        return;
      }

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const parser = new WsFrameParser();
      let exited = false;
      const exitCbs: ((code: number | null) => void)[] = [];
      let exitCode: number | null = null;

      const finish = (code: number | null) => {
        if (exited) return;
        exited = true;
        exitCode = code;
        stdout.end();
        stderr.end();
        for (const cb of exitCbs.splice(0)) cb(code);
      };

      const send = (opcode: number, payload: Buffer) => {
        if (exited || socket.destroyed) return;
        try {
          socket.write(encodeWsFrame(opcode, payload, true));
        } catch {
          finish(null);
        }
      };

      socket.on("data", (chunk: Buffer) => {
        let frames;
        try {
          frames = parser.push(chunk);
        } catch {
          finish(null);
          socket.destroy();
          return;
        }
        for (const f of frames) {
          if (f.opcode === OP_PING) {
            send(OP_PONG, f.payload);
            continue;
          }
          if (f.opcode === OP_CLOSE || f.opcode === OP_TEXT) {
            finish(null);
            continue;
          }
          if (f.opcode !== OP_BINARY || f.payload.length === 0) continue;
          const channel = f.payload[0];
          const data = f.payload.subarray(1);
          if (channel === 1) stdout.write(data);
          else if (channel === 2) stderr.write(data);
          else if (channel === 3) {
            // 终态 status（JSON：{"metadata":{},"status":"Success"} 或 Failure 带 message）
            try {
              const s = JSON.parse(data.toString("utf8")) as { status?: string; code?: number };
              finish(s.status === "Success" ? (s.code ?? 0) : (s.code ?? 1));
            } catch {
              finish(null);
            }
          }
          // channel 0 是客户端写侧，4 是 resize——这里都不处理
        }
      });
      socket.on("close", () => finish(exitCode));
      socket.on("error", () => finish(exitCode));
      if (head.length > 0) socket.emit("data", head);

      const stdin = new Writable({
        write(chunk, _enc, cb) {
          send(OP_BINARY, Buffer.concat([Buffer.from([0]), chunk]));
          cb();
        },
      });

      const proc: StdioProcess = {
        stdin,
        stdout,
        kill() {
          finish(null);
          socket.destroy();
        },
        get exited() {
          return exited;
        },
        onExit(cb) {
          if (exited) cb(exitCode);
          else exitCbs.push(cb);
        },
      };
      resolve(proc);
    });
    req.end();
  });
}
