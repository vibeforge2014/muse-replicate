/**
 * AgentRuntimeDriver 抽象（spec §8.1 的 MVP 子集）。
 * 沙箱内运行 codex app-server；平台只负责驱动和归一化。
 */

export interface RuntimeStartInput {
  sessionId: string;
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
}

export type RuntimeCommand =
  | { type: "user_message"; text: string }
  | { type: "approval_response"; sourceEventId: string; approved: boolean; denyMessage?: string }
  | { type: "custom_tool_output"; sourceEventId: string; output: string; interrupted?: boolean }
  | { type: "interrupt" };

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
  | { kind: "turn_completed"; sourceId: string; reason: "completed" | "interrupted" }
  | { kind: "error"; sourceId: string; message: string; retryable: boolean };

export interface RuntimeHandle {
  sessionId: string;
  threadId: string;
  stop(reason: string): Promise<void>;
}

export interface AgentRuntimeDriver {
  readonly kind: string;
  /** runtime 版本指纹（真实 driver 提供；变化 → Level 0 语义恢复，spec §8.7）。 */
  readonly versionDigest?: string;
  start(input: RuntimeStartInput): Promise<RuntimeHandle>;
  send(handle: RuntimeHandle, command: RuntimeCommand): Promise<void>;
  /** 事件流（多播到当前订阅者；重复消费由 worker 去重）。 */
  nextEvent(handle: RuntimeHandle, timeoutMs?: number): Promise<NormalizedRuntimeEvent | null>;
}
