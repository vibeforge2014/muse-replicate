/**
 * AgentRuntimeDriver 抽象（spec §8.1 的 MVP 子集）。
 * 沙箱内运行 codex app-server；平台只负责驱动和归一化。
 */
import type { Readable, Writable } from "node:stream";

/** 与 spawn 等价的 stdio 进程抽象：本地子进程或沙箱内远程进程同构。 */
export interface StdioProcess {
  stdin: Writable;
  stdout: Readable;
  /** 尽力终止（本地信号 / 远程断开连接），幂等；两次调用等于强制。 */
  kill(): void;
  /** 进程已退出（远程连接断开亦视为退出）。 */
  readonly exited: boolean;
  /** 退出回调（本地 exit 事件 / 远程连接关闭或收到终态 status）。 */
  onExit(cb: (code: number | null) => void): void;
}

export interface StdioSpawnOptions {
  command: string;
  args: string[];
  /** 追加环境变量（本地实现会并入 worker 进程 env；远程实现只下发这些）。 */
  env: Record<string, string | undefined>;
  cwd?: string;
}

export type StdioSpawn = (opts: StdioSpawnOptions) => Promise<StdioProcess> | StdioProcess;

/** 沙箱内 runtime（driver 进沙箱，spec §8/§9）：spawn 在容器里执行，路径先经映射。 */
export interface RemoteSpawnContext {
  spawn: StdioSpawn;
  /** worker 宿主路径 → 容器内路径（挂载表换算）。 */
  toContainerPath(hostPath: string): string;
}

export interface RuntimeStartInput {
  sessionId: string;
  /** lane 标识（multiagent lanes，spec §5.6 二期）：同 lane 复用同一 thread，缺省 "main"。 */
  laneId?: string;
  /** agent 配置（system/model/tools 快照）。 */
  system: string | null;
  model: { id: string; effort?: string };
  /** 审批策略：所有工具 always_allow → never；存在 always_ask → untrusted。 */
  approvalPolicy: "never" | "untrusted";
  /** 已有 thread 时恢复（Level 1 原生恢复）。 */
  resumeThreadId?: string;
  /** 历史消息（Level 0 语义恢复时注入）。 */
  replayHistory?: { role: "user" | "agent"; text: string }[];
  /** fake 驱动的行为脚本覆盖。 */
  scriptOverrides?: Record<string, string>;
  /** agent 是否配置了内置工具集（未配置时 runtime 无 bash 等工具，TOOL-02）。 */
  hasBuiltinToolset?: boolean;
  /** 沙箱内运行（spec §8.4 真实形态）：driver 经它在沙箱容器里 spawn。 */
  remote?: RemoteSpawnContext;
}

export type RuntimeCommand =
  | { type: "user_message"; text: string }
  | { type: "approval_response"; sourceEventId: string; approved: boolean; denyMessage?: string }
  | { type: "custom_tool_output"; sourceEventId: string; output: string; interrupted?: boolean }
  | { type: "interrupt" }
  /** 运行中插话（参考 §7.4）：并入当前 turn；sourceEventId=首事件 id（消费确认的 clientMessageId）。 */
  | { type: "steer"; sourceEventId: string; text: string };

/** turn/steer 的送达结果（参考 §7.4 第 3 条：rejected → 回退为排队执行）。 */
export type SteerAck =
  | { status: "accepted" }
  /** 超时等结果未知：保持 delivered 不重发（不会重复，参考 §7.4 第 4 条）。 */
  | { status: "unknown" }
  | { status: "rejected"; code: string };

/** 归一化 runtime 事件（worker 把它映射为对外事件，spec §12.1）。 */
export type NormalizedRuntimeEvent =
  | { kind: "turn_started"; sourceId: string }
  | { kind: "agent_message"; sourceId: string; text: string }
  | { kind: "agent_thinking"; sourceId: string; summary: string }
  | {
      kind: "tool_use_started";
      sourceId: string;
      toolName: string;
      input: unknown;
      evaluatedPermission: "allow" | "ask";
    }
  | { kind: "tool_result"; sourceId: string; toolUseSourceId: string; content: string; isError: boolean }
  | { kind: "approval_request"; sourceId: string; toolUseSourceId: string; toolName: string }
  | { kind: "custom_tool_use_started"; sourceId: string; toolName: string; input: unknown }
  | { kind: "custom_tool_output_request"; sourceId: string; toolUseSourceId: string; toolName: string }
  /** steer 消费确认（item/started userMessage{clientId}）：sourceId=clientMessageId（=首事件 id）。 */
  | { kind: "steer_confirmed"; sourceId: string }
  | { kind: "turn_completed"; sourceId: string; reason: "completed" | "interrupted" }
  | { kind: "error"; sourceId: string; message: string; retryable: boolean };

export interface RuntimeHandle {
  sessionId: string;
  threadId: string;
  stop(reason: string): Promise<void>;
  /** 共享 runtime 进程是否已退出（lane 共享进程形态下供 worker 交还租约）。 */
  procExited?(): boolean;
}

export interface AgentRuntimeDriver {
  readonly kind: string;
  /** runtime 版本指纹（真实 driver 提供；变化 → Level 0 语义恢复，spec §8.7）。 */
  readonly versionDigest?: string;
  start(input: RuntimeStartInput): Promise<RuntimeHandle>;
  send(handle: RuntimeHandle, command: RuntimeCommand): Promise<void>;
  /**
   * 运行中插话（参考 §7.4）：不支持的 driver（未实现）返回 rejected{code:"unsupported"}，
   * worker 据此回退为排队执行——fail closed，不静默丢弃。
   */
  steer?(handle: RuntimeHandle, command: { sourceEventId: string; text: string }): Promise<SteerAck>;
  /** 事件流（多播到当前订阅者；重复消费由 worker 去重）。 */
  nextEvent(handle: RuntimeHandle, timeoutMs?: number): Promise<NormalizedRuntimeEvent | null>;
}
