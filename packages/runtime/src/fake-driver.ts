import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeDriver,
  NormalizedRuntimeEvent,
  RuntimeCommand,
  RuntimeHandle,
  RuntimeStartInput,
  StdioProcess,
} from "./types.js";
import { localStdioSpawn } from "./local-spawn.js";

interface FakeHandle extends RuntimeHandle {
  proc: StdioProcess;
  events: NormalizedRuntimeEvent[];
  waiters: ((e: NormalizedRuntimeEvent | null) => void)[];
  notify(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** 同会话共享进程（multiagent lanes，spec §5.6 二期：一个沙箱/进程，每 lane 一个 thread）。 */
interface FakeSessionProc {
  proc: StdioProcess;
  /** laneId → handle（同 lane 复用线程；同 lane FIFO 保证不会并发复用）。 */
  lanes: Map<string, FakeHandle>;
  /** threadId → handle（事件分流）。 */
  byThread: Map<string, FakeHandle>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** 把 fake-codex 的原生通知映射为 NormalizedRuntimeEvent（spec §12.1 的来源侧）。 */
function normalize(method: string, p: Record<string, unknown>): NormalizedRuntimeEvent | null {
  const sid = () => String(p.itemId ?? p.sourceId ?? randomUUID());
  switch (method) {
    case "turn/started":
      return { kind: "turn_started", sourceId: sid() };
    case "item/started": {
      const itemType = String(p.itemType ?? "");
      if (itemType === "reasoning") {
        return { kind: "agent_thinking", sourceId: sid(), summary: String(p.summary ?? "") };
      }
      if (itemType === "commandExecution") {
        return {
          kind: "tool_use_started",
          sourceId: sid(),
          toolName: "bash",
          input: { command: p.command ?? "" },
          evaluatedPermission: p.evaluatedPermission === "ask" ? "ask" : "allow",
        };
      }
      if (itemType === "mcpToolCall") {
        return {
          kind: "tool_use_started",
          sourceId: sid(),
          toolName: `mcp__${p.serverName ?? "server"}.${p.toolName ?? "tool"}`,
          input: p.arguments ?? {},
          evaluatedPermission: "allow",
        };
      }
      if (itemType === "customToolCall") {
        return {
          kind: "custom_tool_use_started",
          sourceId: sid(),
          toolName: String(p.toolName ?? "custom"),
          input: p.input ?? {},
        };
      }
      if (itemType === "userMessage") {
        // steer 消费确认（参考 §7.4）：定序点 = 模型实际看到输入的时刻
        const clientId = String(p.clientId ?? "");
        return clientId ? { kind: "steer_confirmed", sourceId: clientId } : null;
      }
      return null;
    }
    case "item/completed": {
      const itemType = String(p.itemType ?? "");
      if (itemType === "agentMessage") {
        return { kind: "agent_message", sourceId: sid(), text: String(p.text ?? "") };
      }
      if (itemType === "commandExecution" || itemType === "mcpToolCall") {
        return {
          kind: "tool_result",
          sourceId: sid(),
          toolUseSourceId: String(p.itemId ?? ""),
          content: String(p.output ?? ""),
          isError: Number(p.exitCode ?? 0) !== 0,
        };
      }
      return null;
    }
    case "item/awaitingApproval":
      return {
        kind: "approval_request",
        sourceId: `appr_${p.itemId}`,
        toolUseSourceId: String(p.itemId ?? ""),
        toolName: "bash",
      };
    case "item/awaitingCustomToolOutput":
      // 自定义工具：turn 挂起等待业务方回 user.custom_tool_result（spec §7.3 例外）
      return {
        kind: "custom_tool_output_request",
        sourceId: `cto_${p.itemId}`,
        toolUseSourceId: String(p.itemId ?? ""),
        toolName: String(p.toolName ?? "custom"),
      };
    case "turn/completed":
      return {
        kind: "turn_completed",
        sourceId: sid(),
        reason: p.reason === "interrupted" ? "interrupted" : "completed",
      };
    case "error":
      return {
        kind: "error",
        sourceId: sid(),
        message: String(p.message ?? "unknown runtime error"),
        retryable: Boolean(p.retryable),
      };
    default:
      return null;
  }
}

export class FakeCodexDriver implements AgentRuntimeDriver {
  readonly kind = "codex_app_server";
  /** sessionId → 共享进程与 lane 表（fake 单进程多线程形态；进程死即清）。 */
  private sessions = new Map<string, FakeSessionProc>();

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const laneId = input.laneId ?? "main";
    let entry = this.sessions.get(input.sessionId);
    if (!entry || entry.proc.exited) {
      entry = await this.spawnSession(input);
      this.sessions.set(input.sessionId, entry);
    }
    const existing = entry.lanes.get(laneId);
    if (existing) return existing; // 同 lane 线程复用（requires_action 挂起期间等）

    const handle: FakeHandle = {
      sessionId: input.sessionId,
      threadId: "",
      proc: entry.proc,
      events: [],
      waiters: [],
      procExited: () => entry!.proc.exited,
      notify: (method, params) => entry!.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
      request: (method, params) =>
        new Promise((resolve, reject) => {
          const proc = entry!.proc;
          const id = randomUUID();
          const onLine = (buf: Buffer) => {
            const text = buf.toString();
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.id === id) {
                  proc.stdout.off("data", onLine);
                  if (msg.error) reject(new Error(msg.error.message));
                  else resolve(msg.result);
                  return;
                }
              } catch {
                /* 非 JSON 行忽略 */
              }
            }
          };
          proc.stdout.on("data", onLine);
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        }),
      async stop(reason) {
        // fence 语义保持进程级（spec §14.1：失去租约即视为污染，整进程终止；
        // 其他 lane 的在途 turn 会随后续租约过期被接管重试）
        this.notify("turn/interrupt", { threadId: this.threadId });
        if (!entry!.proc.exited) {
          entry!.proc.kill();
          await new Promise((r) => setTimeout(r, 50));
          if (!entry!.proc.exited) entry!.proc.kill();
        }
        void reason;
      },
    };
    entry.lanes.set(laneId, handle);

    // 每 lane 一个 thread：resume（DB 持久化的 lane thread id）或新建（可注入语义恢复历史）
    if (input.resumeThreadId) {
      const r = (await handle.request("thread/resume", { threadId: input.resumeThreadId })) as { threadId: string };
      handle.threadId = r.threadId;
    } else {
      const r = (await handle.request("thread/start", {
        threadIdHint: laneId,
        capabilities: { bash: input.hasBuiltinToolset !== false },
      })) as { threadId: string };
      handle.threadId = r.threadId;
      if (input.replayHistory?.length) {
        await handle.request("thread/inject_items", {
          threadId: handle.threadId,
          items: input.replayHistory.map((h) => ({ type: "message", role: h.role, text: h.text })),
        });
      }
    }
    entry.byThread.set(handle.threadId, handle);
    return handle;
  }

  /** 同会话首 lane：spawn 共享进程 + initialize + 事件分流（NDJSON → 按 threadId 路由）。 */
  private async spawnSession(input: RuntimeStartInput): Promise<FakeSessionProc> {
    const codexHome = join(tmpdir(), "mas-fake-codex", input.sessionId);
    mkdirSync(codexHome, { recursive: true });
    const extraEnv = { FAKE_CODEX_HOME: codexHome, MAS_SESSION_ID: input.sessionId };
    // 沙箱内运行（driver 进沙箱）：在容器里跑同一份 fake-codex.mjs（镜像内路径一致），
    // FAKE_CODEX_HOME 映射为容器路径（PVC 双向可见）
    const remote = input.remote;
    const proc = await (remote
      ? remote.spawn({
          command: process.execPath,
          args: [join(here, "fake-codex.mjs")],
          env:
            remote.toContainerPath(codexHome) === codexHome
              ? extraEnv
              : { ...extraEnv, FAKE_CODEX_HOME: remote.toContainerPath(codexHome) },
          cwd: remote.toContainerPath(codexHome),
        })
      : localStdioSpawn({
          command: process.execPath,
          args: [join(here, "fake-codex.mjs")],
          env: extraEnv,
        }));

    const entry: FakeSessionProc = { proc, lanes: new Map(), byThread: new Map() };
    let textBuf = "";
    const dispatch = (msg: { method?: string; params?: Record<string, unknown> }) => {
      if (!msg.method) return;
      const threadId = String(msg.params?.threadId ?? "");
      const target = entry.byThread.get(threadId);
      if (!target) return; // 未知线程（进程复用前残留）——丢弃
      const ev = normalize(msg.method, msg.params ?? {});
      if (!ev) return;
      const waiter = target.waiters.shift();
      if (waiter) waiter(ev);
      else target.events.push(ev);
    };
    proc.stdout.on("data", (buf: Buffer) => {
      // NDJSON 可能一行拆多段：缓存到换行为止
      textBuf += buf.toString();
      const lines = textBuf.split("\n");
      textBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          dispatch(JSON.parse(line));
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    proc.stdout.on("close", () => {
      if (textBuf.trim()) {
        try {
          dispatch(JSON.parse(textBuf));
        } catch {
          /* 半行残余丢弃 */
        }
      }
      textBuf = "";
      for (const [, h] of entry.lanes) for (const w of h.waiters.splice(0)) w(null);
      if (this.sessions.get(input.sessionId) === entry) this.sessions.delete(input.sessionId);
    });

    // initialize 每进程一次（首 lane 建立时）
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const onLine = (buf: Buffer) => {
        for (const line of buf.toString().split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) {
              proc.stdout.off("data", onLine);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve();
              return;
            }
          } catch {
            /* 忽略 */
          }
        }
      };
      proc.stdout.on("data", onLine);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: { name: "mas-worker" } } }) + "\n");
    });
    return entry;
  }

  /** steer（参考 §7.4）：无活跃 turn 等被拒情形由 fake 返回 rejected 供 worker 回退。 */
  async steer(
    handle: RuntimeHandle,
    command: { sourceEventId: string; text: string },
  ): Promise<{ status: "accepted" } | { status: "unknown" } | { status: "rejected"; code: string }> {
    const h = handle as FakeHandle;
    try {
      await h.request("turn/steer", {
        threadId: h.threadId,
        clientUserMessageId: command.sourceEventId,
        input: [{ type: "text", text: command.text }],
      });
      return { status: "accepted" };
    } catch (e) {
      const msg = String((e as Error).message ?? "");
      if (/no active turn/i.test(msg)) return { status: "rejected", code: "no_active_turn" };
      if (/timeout/i.test(msg)) return { status: "unknown" };
      return { status: "rejected", code: "invalid_input" };
    }
  }

  async send(handle: RuntimeHandle, command: RuntimeCommand): Promise<void> {
    const h = handle as FakeHandle;
    switch (command.type) {
      case "user_message":
        await h.request("turn/start", {
          threadId: h.threadId,
          input: [{ type: "message", content: [{ type: "text", text: command.text }] }],
        });
        return;
      case "approval_response":
        h.notify("item/approvalResponse", {
          itemId: command.sourceEventId,
          approved: command.approved,
          denyMessage: command.denyMessage,
        });
        return;
      case "custom_tool_output":
        h.notify("item/customToolOutput", {
          itemId: command.sourceEventId,
          output: command.output,
          interrupted: command.interrupted ?? false,
        });
        return;
      case "interrupt":
        await h.request("turn/interrupt", { threadId: h.threadId });
        return;
    }
  }

  async nextEvent(handle: RuntimeHandle, timeoutMs = 60_000): Promise<NormalizedRuntimeEvent | null> {
    const h = handle as FakeHandle;
    const buffered = h.events.shift();
    if (buffered) return buffered;
    if (h.proc.exited) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = h.waiters.indexOf(waiter);
        if (i >= 0) h.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (e: NormalizedRuntimeEvent | null) => {
        clearTimeout(timer);
        resolve(e);
      };
      h.waiters.push(waiter);
    });
  }

  /** 读回 fake 的对话历史（Level 0 语义恢复的输入；lane 维度读指定线程的 rollout）。 */
  static readHistory(sessionId: string, threadId?: string): { role: "user" | "agent"; text: string }[] {
    const base = join(tmpdir(), "mas-fake-codex", sessionId);
    const p = threadId ? join(base, `rollout-${threadId}.json`) : join(base, "rollout.json");
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return [];
    }
  }
}
