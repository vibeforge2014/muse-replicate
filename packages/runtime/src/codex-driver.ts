import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type {
  AgentRuntimeDriver,
  NormalizedRuntimeEvent,
  RuntimeCommand,
  RuntimeHandle,
  RuntimeStartInput,
} from "./types.js";

/**
 * 真实 codex app-server driver（codex-cli ≥ 0.160 的 app-server v2 协议，NDJSON stdio）。
 * 协议要点（由 generate-json-schema + live 探针确认）：
 *  - thread/start{cwd,model,baseInstructions,approvalPolicy,sandbox} → {thread:{id}}；
 *  - thread/resume{threadId,...} 恢复 rollout；thread/inject_items 注入 Responses API 原生 item；
 *  - turn/start{threadId,input:[{type:"text",text}],effort?}；turn/interrupt 需 {threadId,turnId}；
 *  - 通知：turn/started、item/started|completed{item:{type,id,...}}、item/agentMessage/delta、
 *    turn/completed{turn:{status,error}}、error{error,willRetry}；
 *  - server→client 请求：item/commandExecution/requestApproval{itemId} 与
 *    item/fileChange/requestApproval{itemId}（回 {decision}），item/tool/call{callId,tool,arguments}
 *    （回 {contentItems:[{type:"inputText",text}],success}）。
 * CODEX_HOME 放在会话 home 的 .codex/ 下，rollout 随 checkpoint 一起持久化（Level 1 恢复）。
 */

/** 与 @mas/db 的 fakeCodexHome 保持一致：checkpoint sourceDir / 资源挂载 / outputs 都指向这里。 */
export function sessionRuntimeHome(sessionId: string): string {
  return join(tmpdir(), "mas-fake-codex", sessionId);
}

export interface CodexDriverOptions {
  /** codex 可执行文件（默认 PATH 上的 codex，或 MAS_CODEX_BIN）。 */
  bin?: string;
  /** auth.json 来源（默认 MAS_CODEX_AUTH_FILE 或 ~/.codex/auth.json；存在才复制）。 */
  authFile?: string;
  requestTimeoutMs?: number;
}

interface CodexHandle extends RuntimeHandle {
  proc: ChildProcess;
  events: NormalizedRuntimeEvent[];
  waiters: ((e: NormalizedRuntimeEvent | null) => void)[];
  /** 审批 itemId → server 请求 id（approval_response 按 itemId 回复）。 */
  pendingApprovals: Map<string, number | string>;
  /** 动态工具 callId → server 请求 id。 */
  pendingToolCalls: Map<string, number | string>;
  currentTurnId: string;
  /** agent 配置的 reasoning effort（turn/start 透传）。 */
  effort?: string;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  reply(id: number | string, result: unknown): void;
}

function itemText(item: Record<string, unknown>, key: string): string {
  const v = item[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        typeof b === "string"
          ? b
          : typeof (b as { text?: unknown })?.text === "string"
            ? (b as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/** 把 codex 原生通知/请求映射为 NormalizedRuntimeEvent（返回多个：动态工具一次产生 started + output_request）。 */
function normalize(
  method: string,
  p: Record<string, unknown>,
  ctx: { pendingApprovals: Map<string, number | string>; pendingToolCalls: Map<string, number | string> },
): NormalizedRuntimeEvent[] {
  switch (method) {
    case "turn/started":
      return [{ kind: "turn_started", sourceId: String((p.turn as { id?: string })?.id ?? "") }];
    case "item/started":
    case "item/completed": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const id = String(item.id ?? "");
      const type = String(item.type ?? "");
      if (method === "item/started") {
        if (type === "reasoning") {
          const summary = itemText(item, "summary");
          return summary ? [{ kind: "agent_thinking", sourceId: id, summary }] : [];
        }
        if (type === "commandExecution") {
          return [
            { kind: "tool_use_started", sourceId: id, toolName: "bash", input: { command: item.command ?? "" }, evaluatedPermission: "allow" },
          ];
        }
        if (type === "mcpToolCall") {
          return [
            {
              kind: "tool_use_started",
              sourceId: id,
              toolName: `mcp__${item.server ?? "server"}.${item.tool ?? "tool"}`,
              input: item.arguments ?? {},
              evaluatedPermission: "allow",
            },
          ];
        }
        if (type === "dynamicToolCall") {
          return [{ kind: "custom_tool_use_started", sourceId: id, toolName: String(item.tool ?? "custom"), input: item.arguments ?? {} }];
        }
        if (type === "fileChange") {
          return [
            { kind: "tool_use_started", sourceId: id, toolName: "apply_patch", input: { changes: item.changes ?? [] }, evaluatedPermission: "allow" },
          ];
        }
        return [];
      }
      // item/completed
      if (type === "agentMessage") {
        return [{ kind: "agent_message", sourceId: id, text: itemText(item, "text") }];
      }
      if (type === "reasoning") {
        const summary = itemText(item, "summary") || itemText(item, "content");
        return summary ? [{ kind: "agent_thinking", sourceId: id, summary }] : [];
      }
      if (type === "commandExecution") {
        return [
          {
            kind: "tool_result",
            sourceId: id,
            toolUseSourceId: id,
            content: itemText(item, "aggregatedOutput"),
            isError: Number(item.exitCode ?? 0) !== 0,
          },
        ];
      }
      if (type === "mcpToolCall") {
        const err = item.error;
        return [
          {
            kind: "tool_result",
            sourceId: id,
            toolUseSourceId: id,
            content: err ? String(err) : JSON.stringify(item.result ?? ""),
            isError: err != null,
          },
        ];
      }
      if (type === "dynamicToolCall") {
        const content = Array.isArray(item.contentItems)
          ? (item.contentItems as Record<string, unknown>[]).map((c) => String(c.text ?? "")).join("")
          : "";
        return [
          { kind: "tool_result", sourceId: id, toolUseSourceId: id, content, isError: item.success === false },
        ];
      }
      if (type === "fileChange") {
        return [
          { kind: "tool_result", sourceId: id, toolUseSourceId: id, content: JSON.stringify(item.changes ?? []), isError: item.status === "failed" },
        ];
      }
      return [];
    }
    case "error":
      return [
        {
          kind: "error",
          sourceId: String((p.turnId as string) ?? ""),
          message: String((p.error as { message?: string })?.message ?? "runtime error"),
          retryable: Boolean(p.willRetry),
        },
      ];
    case "turn/completed": {
      const turn = (p.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } | null };
      const id = String(turn.id ?? "");
      if (turn.status === "failed") {
        return [
          { kind: "error", sourceId: id, message: turn.error?.message ?? "turn failed", retryable: false },
          { kind: "turn_completed", sourceId: id, reason: "completed" },
        ];
      }
      return [{ kind: "turn_completed", sourceId: id, reason: turn.status === "interrupted" ? "interrupted" : "completed" }];
    }
    case "item/commandExecution/requestApproval": {
      const itemId = String(p.itemId ?? "");
      return [{ kind: "approval_request", sourceId: `appr_${itemId}`, toolUseSourceId: itemId, toolName: "bash" }];
    }
    case "item/fileChange/requestApproval": {
      const itemId = String(p.itemId ?? "");
      return [{ kind: "approval_request", sourceId: `appr_${itemId}`, toolUseSourceId: itemId, toolName: "apply_patch" }];
    }
    case "item/tool/call": {
      // 动态工具（客户端声明）：先见 call，再挂起等业务方 custom_tool_output
      const callId = String(p.callId ?? "");
      const toolName = String(p.tool ?? "custom");
      return [
        { kind: "custom_tool_use_started", sourceId: callId, toolName, input: p.arguments ?? {} },
        { kind: "custom_tool_output_request", sourceId: `cto_${callId}`, toolUseSourceId: callId, toolName },
      ];
    }
    default:
      return [];
  }
}

export class CodexDriver implements AgentRuntimeDriver {
  readonly kind = "codex_app_server";

  private readonly bin: string;
  private readonly authFile: string | undefined;
  private readonly requestTimeoutMs: number;
  /** 供 worker 写 codex_version_digest（升级后触发 Level 0 语义恢复，spec §8.7）。 */
  readonly versionDigest: string;

  constructor(opts: CodexDriverOptions = {}) {
    this.bin = opts.bin ?? process.env.MAS_CODEX_BIN ?? "codex";
    this.authFile = opts.authFile ?? process.env.MAS_CODEX_AUTH_FILE ?? join(homedir(), ".codex", "auth.json");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    try {
      const v = execFileSync(this.bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
      this.versionDigest = `codex@${v.split(/\s+/).pop() ?? "unknown"}`;
    } catch {
      this.versionDigest = "codex@unknown";
    }
  }

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const home = sessionRuntimeHome(input.sessionId);
    mkdirSync(home, { recursive: true });
    // 每会话独立 CODEX_HOME：rollout 落在 home/.codex 下，随 checkpoint 持久化；
    // 只复制 auth.json（不继承用户的 config.toml/MCP server，保证会话间隔离）
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const authSrc = this.authFile;
    if (authSrc && existsSync(authSrc)) {
      try {
        copyFileSync(authSrc, join(codexHome, "auth.json"));
      } catch {
        /* 无 auth 时首个 turn 会报错并透出 */
      }
    }

    const proc = spawn(this.bin, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: home,
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    const requestTimeoutMs = this.requestTimeoutMs;
    const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

    const handle = {
      sessionId: input.sessionId,
      threadId: "",
      proc,
      events: [] as NormalizedRuntimeEvent[],
      waiters: [] as ((e: NormalizedRuntimeEvent | null) => void)[],
      pendingApprovals: new Map<string, number | string>(),
      pendingToolCalls: new Map<string, number | string>(),
      currentTurnId: "",
      effort: /^[a-z]+$/.test(input.model?.effort ?? "") ? input.model?.effort : undefined,
      reply(id: number | string, result: unknown) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      },
      request(method: string, params: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
          const id = `mas_${randomId()}`;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`codex request timeout: ${method}`));
          }, requestTimeoutMs);
          pending.set(id, { resolve, reject, timer });
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      },
    } as CodexHandle;

    const deliver = (events: NormalizedRuntimeEvent[]) => {
      for (const ev of events) {
        const waiter = handle.waiters.shift();
        if (waiter) waiter(ev);
        else handle.events.push(ev);
      }
    };

    // readline：NDJSON 按行解析（避免 data 事件把一行 JSON 撕成两半）
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      let msg: {
        id?: number | string; method?: string; params?: Record<string, unknown>;
        result?: unknown; error?: { message?: string };
      };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      // server→client 请求（审批/动态工具）：登记 id 供 send() 回复
      if (msg.method !== undefined && msg.id !== undefined) {
        if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval") {
          handle.pendingApprovals.set(String(msg.params?.itemId ?? ""), msg.id);
        } else if (msg.method === "item/tool/call") {
          handle.pendingToolCalls.set(String(msg.params?.callId ?? ""), msg.id);
        } else {
          // 平台不支持的 server 请求：按 method-not-found 错误回复，避免 codex 挂起
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `mas: unsupported server request ${msg.method}` } }) + "\n");
          return;
        }
        deliver(normalize(msg.method, msg.params ?? {}, handle));
        return;
      }
      if (msg.method !== undefined) {
        if (msg.method === "turn/started") handle.currentTurnId = String((msg.params?.turn as { id?: string })?.id ?? handle.currentTurnId);
        deliver(normalize(msg.method, msg.params ?? {}, handle));
        return;
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message ?? "codex error"));
          else p.resolve(msg.result);
        }
      }
    });

    const failAll = (why: string) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      pending.clear();
      for (const w of handle.waiters.splice(0)) w(null);
    };
    proc.on("exit", () => failAll(`codex app-server exited (code ${proc.exitCode})`));
    proc.on("error", (e) => failAll(`codex app-server spawn error: ${e.message}`));

    await handle.request("initialize", { clientInfo: { name: "mas-codex-driver", version: "0.1.0" } });

    const threadParams: Record<string, unknown> = {
      cwd: home,
      approvalPolicy: input.approvalPolicy === "never" ? "never" : "untrusted",
      sandbox: input.approvalPolicy === "never" ? "danger-full-access" : "workspace-write",
    };
    if (input.model?.id) threadParams.model = input.model.id;
    if (input.system) threadParams.baseInstructions = input.system;

    if (input.resumeThreadId) {
      const r = (await handle.request("thread/resume", { threadId: input.resumeThreadId, ...threadParams })) as { thread?: { id?: string } };
      handle.threadId = String(r?.thread?.id ?? input.resumeThreadId);
    } else {
      const r = (await handle.request("thread/start", threadParams)) as { thread?: { id?: string } };
      handle.threadId = String(r?.thread?.id ?? "");
      if (input.replayHistory?.length) {
        // Level 0 语义恢复：注入 Responses API 原生 message item
        await handle.request("thread/inject_items", {
          threadId: handle.threadId,
          items: input.replayHistory.map((h) => ({
            type: "message",
            role: h.role === "user" ? "user" : "assistant",
            content: [{ type: h.role === "user" ? "input_text" : "output_text", text: h.text }],
          })),
        });
      }
    }

    handle.stop = async (reason: string) => {
      void reason;
      try {
        if (handle.currentTurnId) {
          await handle.request("turn/interrupt", { threadId: handle.threadId, turnId: handle.currentTurnId });
        }
      } catch {
        /* 尽力而为 */
      }
      if (!proc.killed) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    };
    return handle;
  }

  async send(handle: RuntimeHandle, command: RuntimeCommand): Promise<void> {
    const h = handle as CodexHandle;
    switch (command.type) {
      case "user_message": {
        const params: Record<string, unknown> = {
          threadId: h.threadId,
          input: [{ type: "text", text: command.text }],
        };
        if (h.effort) params.effort = h.effort;
        const r = (await h.request("turn/start", params)) as { turn?: { id?: string } };
        if (r?.turn?.id) h.currentTurnId = r.turn.id;
        return;
      }
      case "approval_response": {
        const id = h.pendingApprovals.get(command.sourceEventId) ?? firstValue(h.pendingApprovals);
        if (id === undefined) return;
        h.pendingApprovals.delete(command.sourceEventId);
        h.reply(id, { decision: command.approved ? "accept" : "decline" });
        return;
      }
      case "custom_tool_output": {
        const id = h.pendingToolCalls.get(command.sourceEventId) ?? firstValue(h.pendingToolCalls);
        if (id === undefined) return;
        h.pendingToolCalls.delete(command.sourceEventId);
        h.reply(id, {
          contentItems: [{ type: "inputText", text: command.output ?? "" }],
          success: !(command.interrupted ?? false),
        });
        return;
      }
      case "interrupt": {
        if (!h.currentTurnId) return;
        await h.request("turn/interrupt", { threadId: h.threadId, turnId: h.currentTurnId });
        return;
      }
    }
  }

  async nextEvent(handle: RuntimeHandle, timeoutMs = 60_000): Promise<NormalizedRuntimeEvent | null> {
    const h = handle as CodexHandle;
    const buffered = h.events.shift();
    if (buffered) return buffered;
    if (h.proc.exitCode !== null || h.proc.killed) return null;
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
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function firstValue(m: Map<string, number | string>): number | string | undefined {
  for (const v of m.values()) return v;
  return undefined;
}
