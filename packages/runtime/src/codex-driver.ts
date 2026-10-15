import { execFileSync } from "node:child_process";
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
  StdioProcess,
} from "./types.js";
import { localStdioSpawn } from "./local-spawn.js";

/**
 * 真实 codex app-server driver（codex-cli ≥ 0.160 的 app-server v2 协议，NDJSON stdio）。
 * 协议要点（由 generate-json-schema + live 探针确认）：
 *  - thread/start{cwd,model,baseInstructions,approvalPolicy,sandbox} → {thread:{id}}；
 *  - thread/resume{threadId,...} 恢复 rollout；thread/inject_items 注入 Responses API 原生 item；
 *  - turn/start{threadId,input:[{type:"text",text}],effort?}；turn/interrupt 需 {threadId,turnId}；
 *  - 通知：turn/started、item/started|completed{item:{type,id,...}}、item/agentMessage/delta、
 *    turn/completed{turn:{status,error}}、error{error,willRetry}（均带 threadId）；
 *  - server→client 请求：item/commandExecution/requestApproval{itemId} 与
 *    item/fileChange/requestApproval{itemId}（回 {decision}），item/tool/call{callId,tool,arguments}
 *    （回 {contentItems:[{type:"inputText",text}],success}）。
 * CODEX_HOME 放在会话 home 的 .codex/ 下，rollout 随 checkpoint 一起持久化（Level 1 恢复）。
 *
 * multiagent lanes（spec §5.6 二期）：每会话一个 app-server 进程（CODEX_HOME 共享），
 * 每个 lane 一个 thread/句柄；入站通知按 params.threadId 分流到所属 lane 的队列
 * （审批/动态工具请求同样按 thread 归属；无 threadId 的旧版通知退回单 lane 路由）。
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
  /**
   * 版本指纹覆盖：沙箱内运行时 worker 传镜像标识（镜像变更即"runtime 升级"，
   * 触发 Level 0 语义恢复，spec §8.7）——worker 宿主上没有 codex 二进制可探。
   */
  versionDigest?: string;
}

interface CodexHandle extends RuntimeHandle {
  session: CodexSessionProc;
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

/** 同会话共享的 app-server 进程：一个 CODEX_HOME、一套 client→server 请求登记、按 thread 分流。 */
interface CodexSessionProc {
  proc: StdioProcess;
  pending: Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  /** laneId → handle（同 lane 复用 thread；同 lane FIFO 保证不会并发复用）。 */
  lanes: Map<string, CodexHandle>;
  /** threadId → handle（入站分流；size>1 时 threadId 缺失的消息无法唯一归属）。 */
  byThread: Map<string, CodexHandle>;
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
function normalize(method: string, p: Record<string, unknown>): NormalizedRuntimeEvent[] {
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
  /** sessionId → 共享 app-server 进程与 lane 表（进程死即清）。 */
  private sessions = new Map<string, CodexSessionProc>();

  constructor(opts: CodexDriverOptions = {}) {
    this.bin = opts.bin ?? process.env.MAS_CODEX_BIN ?? "codex";
    this.authFile = opts.authFile ?? process.env.MAS_CODEX_AUTH_FILE ?? join(homedir(), ".codex", "auth.json");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    if (opts.versionDigest) {
      this.versionDigest = opts.versionDigest;
      return;
    }
    try {
      const v = execFileSync(this.bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
      this.versionDigest = `codex@${v.split(/\s+/).pop() ?? "unknown"}`;
    } catch {
      this.versionDigest = "codex@unknown";
    }
  }

  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const laneId = input.laneId ?? "main";
    let entry = this.sessions.get(input.sessionId);
    if (!entry || entry.proc.exited) {
      entry = await this.spawnSession(input);
      this.sessions.set(input.sessionId, entry);
    }
    const existing = entry.lanes.get(laneId);
    if (existing) return existing; // requires_action 挂起期间同 lane 再次 start → 复用同线程

    const handle = this.makeHandle(entry, input);
    entry.lanes.set(laneId, handle);
    await this.openThread(entry, handle, input);
    entry.byThread.set(handle.threadId, handle);
    return handle;
  }

  private makeHandle(entry: CodexSessionProc, input: RuntimeStartInput): CodexHandle {
    const handle: CodexHandle = {
      sessionId: input.sessionId,
      threadId: "",
      session: entry,
      events: [],
      waiters: [],
      procExited: () => entry.proc.exited,
      pendingApprovals: new Map(),
      pendingToolCalls: new Map(),
      currentTurnId: "",
      effort: /^[a-z]+$/.test(input.model?.effort ?? "") ? input.model?.effort : undefined,
      reply(id, result) {
        entry.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      },
      request(method, params) {
        return new Promise((resolve, reject) => {
          const id = `mas_${randomId()}`;
          const timer = setTimeout(() => {
            entry.pending.delete(id);
            reject(new Error(`codex request timeout: ${method}`));
          }, 30_000);
          entry.pending.set(id, { resolve, reject, timer });
          entry.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      },
      async stop(reason) {
        void reason;
        try {
          if (this.currentTurnId) {
            await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId });
          }
        } catch {
          /* 尽力而为 */
        }
        // fence 语义保持进程级（spec §14.1：失去租约即视为污染，整进程终止；
        // 其他 lane 的在途 turn 随租约过期被接管重试）
        if (!entry.proc.exited) {
          entry.proc.kill();
          await new Promise((r) => setTimeout(r, 200));
          if (!entry.proc.exited) entry.proc.kill();
        }
      },
    };
    return handle;
  }

  /** 每 lane 一个 thread：resume（DB 持久化的 lane thread id）或新建（可注入语义恢复历史）。 */
  private async openThread(entry: CodexSessionProc, handle: CodexHandle, input: RuntimeStartInput): Promise<void> {
    const remote = input.remote;
    const home = sessionRuntimeHome(input.sessionId);
    const workdir = remote ? remote.toContainerPath(home) : home;
    const threadParams: Record<string, unknown> = {
      cwd: workdir,
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
  }

  /** 同会话首 lane：建 CODEX_HOME、spawn 共享 app-server、initialize、按 threadId 分流入站消息。 */
  private async spawnSession(input: RuntimeStartInput): Promise<CodexSessionProc> {
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
    // 沙箱内运行（spec §8.4）：codex app-server 经 exec 在沙箱容器里 spawn；
    // CODEX_HOME/cwd 换算为容器路径（会话 home 经 PVC 双向可见）
    const remote = input.remote;
    const workdir = remote ? remote.toContainerPath(home) : home;
    const codexHomeArg = remote ? remote.toContainerPath(codexHome) : codexHome;
    const proc = await (remote
      ? remote.spawn({
          command: this.bin,
          args: ["app-server"],
          env: { CODEX_HOME: codexHomeArg },
          cwd: workdir,
        })
      : localStdioSpawn({
          command: this.bin,
          args: ["app-server"],
          env: { CODEX_HOME: codexHome },
          cwd: home,
        }));

    const entry: CodexSessionProc = {
      proc,
      pending: new Map(),
      lanes: new Map(),
      byThread: new Map(),
    };

    const deliver = (target: CodexHandle, events: NormalizedRuntimeEvent[]) => {
      for (const ev of events) {
        const waiter = target.waiters.shift();
        if (waiter) waiter(ev);
        else target.events.push(ev);
      }
    };
    /** 无 threadId 的旧版通知：仅一个 lane 时可唯一归属，否则投给 main（best effort）。 */
    const route = (threadId: string): CodexHandle | undefined => {
      if (threadId) return entry.byThread.get(threadId);
      if (entry.byThread.size === 1) return entry.byThread.values().next().value;
      return entry.byThread.get(entry.lanes.get("main")?.threadId ?? "");
    };

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
      // server→client 请求（审批/动态工具）：登记到所属 lane 供 send() 回复
      if (msg.method !== undefined && msg.id !== undefined) {
        const target = route(String(msg.params?.threadId ?? ""));
        if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval") {
          target?.pendingApprovals.set(String(msg.params?.itemId ?? ""), msg.id);
        } else if (msg.method === "item/tool/call") {
          target?.pendingToolCalls.set(String(msg.params?.callId ?? ""), msg.id);
        } else {
          // 平台不支持的 server 请求：按 method-not-found 错误回复，避免 codex 挂起
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `mas: unsupported server request ${msg.method}` } }) + "\n");
          return;
        }
        if (target) deliver(target, normalize(msg.method, msg.params ?? {}));
        return;
      }
      if (msg.method !== undefined) {
        const threadId = String(msg.params?.threadId ?? "");
        const target = route(threadId);
        if (msg.method === "turn/started" && target) {
          target.currentTurnId = String((msg.params?.turn as { id?: string })?.id ?? target.currentTurnId);
        }
        if (target) deliver(target, normalize(msg.method, msg.params ?? {}));
        return;
      }
      if (msg.id !== undefined) {
        const p = entry.pending.get(msg.id);
        if (p) {
          entry.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message ?? "codex error"));
          else p.resolve(msg.result);
        }
      }
    });

    const failAll = (why: string) => {
      for (const [, p] of entry.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      entry.pending.clear();
      for (const [, h] of entry.lanes) for (const w of h.waiters.splice(0)) w(null);
      if (this.sessions.get(input.sessionId) === entry) this.sessions.delete(input.sessionId);
    };
    proc.onExit((code) => failAll(`codex app-server exited (code ${code})`));

    await new Promise<void>((resolve, reject) => {
      const id = `mas_${randomId()}`;
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new Error("codex request timeout: initialize"));
      }, this.requestTimeoutMs);
      entry.pending.set(id, { resolve: () => resolve(), reject, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: { name: "mas-codex-driver", version: "0.1.0" } } }) + "\n");
    });
    return entry;
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
    if (h.session.proc.exited) return null;
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
