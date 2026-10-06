import { spawn, type ChildProcess } from "node:child_process";
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
} from "./types.js";

interface FakeHandle extends RuntimeHandle {
  proc: ChildProcess;
  events: NormalizedRuntimeEvent[];
  waiters: ((e: NormalizedRuntimeEvent | null) => void)[];
  notify(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
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

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const codexHome = join(tmpdir(), "mas-fake-codex", input.sessionId);
    mkdirSync(codexHome, { recursive: true });
    const proc = spawn(process.execPath, [join(here, "fake-codex.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        FAKE_CODEX_HOME: codexHome,
        MAS_SESSION_ID: input.sessionId,
      },
    });
    const handle: FakeHandle = {
      sessionId: input.sessionId,
      threadId: "",
      proc,
      events: [],
      waiters: [],
      notify(method, params) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      },
      request(method, params) {
        return new Promise((resolve, reject) => {
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
        });
      },
      async stop(reason) {
        this.notify("turn/interrupt", {});
        if (!proc.killed) {
          proc.kill("SIGTERM");
          await new Promise((r) => setTimeout(r, 50));
          if (!proc.killed || proc.exitCode === null) proc.kill("SIGKILL");
        }
        void reason;
      },
    };

    proc.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let msg: { method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!msg.method) continue;
        const ev = normalize(msg.method, msg.params ?? {});
        if (ev) {
          const waiter = handle.waiters.shift();
          if (waiter) waiter(ev);
          else handle.events.push(ev);
        }
      }
    });
    proc.on("exit", () => {
      for (const w of handle.waiters.splice(0)) w(null);
    });

    await handle.request("initialize", { clientInfo: { name: "mas-worker" } });
    if (input.resumeThreadId) {
      const r = (await handle.request("thread/resume", { threadId: input.resumeThreadId })) as { threadId: string };
      handle.threadId = r.threadId;
    } else {
      const r = (await handle.request("thread/start", {
        capabilities: { bash: input.hasBuiltinToolset !== false },
      })) as { threadId: string };
      handle.threadId = r.threadId;
      if (input.replayHistory?.length) {
        await handle.request("thread/inject_items", {
          items: input.replayHistory.map((h) => ({ type: "message", role: h.role, text: h.text })),
        });
      }
    }
    return handle;
  }

  async send(handle: RuntimeHandle, command: RuntimeCommand): Promise<void> {
    const h = handle as FakeHandle;
    switch (command.type) {
      case "user_message":
        await h.request("turn/start", {
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
      case "interrupt":
        await h.request("turn/interrupt", {});
        return;
    }
  }

  async nextEvent(handle: RuntimeHandle, timeoutMs = 60_000): Promise<NormalizedRuntimeEvent | null> {
    const h = handle as FakeHandle;
    const buffered = h.events.shift();
    if (buffered) return buffered;
    const exited = h.proc.exitCode !== null;
    if (exited) return null;
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

  /** 读回 fake 的对话历史（Level 0 语义恢复的输入）。 */
  static readHistory(sessionId: string): { role: "user" | "agent"; text: string }[] {
    const p = join(tmpdir(), "mas-fake-codex", sessionId, "rollout.json");
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return [];
    }
  }
}
