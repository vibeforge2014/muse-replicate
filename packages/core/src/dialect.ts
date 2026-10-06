import type { DialectKind } from "./errors.js";

export interface HeaderBag {
  get(name: string): string | undefined;
}

/**
 * 方言检测（spec §11.1）：
 * - zai-version / zai-beta / zai-* → BigModel
 * - anthropic-version / anthropic-beta / x-api-key → Anthropic
 * - mas-version 或缺省 → Anthropic 风格（本平台默认方言）
 */
export function detectDialect(h: HeaderBag): DialectKind {
  if (h.get("zai-version") || h.get("zai-beta")) return "bigmodel";
  if (h.get("anthropic-version") || h.get("anthropic-beta") || h.get("x-api-key")) return "anthropic";
  return "anthropic";
}

/** 按方言回显工具集名（§12.3：响应中回显请求时使用的名称）。 */
export function echoToolsetType(dialect: DialectKind, requested: string): string {
  if (dialect === "bigmodel") return "agent_toolset_20260601";
  if (dialect === "anthropic") return "agent_toolset_20260401";
  return requested;
}
