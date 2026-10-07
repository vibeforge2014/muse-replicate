import { z } from "zod";
import { errInvalid } from "../errors.js";
import { metadataSchema } from "./common.js";

export const PERMISSION_POLICIES = ["always_allow", "always_ask"] as const;
export type PermissionPolicyType = (typeof PERMISSION_POLICIES)[number];

const permissionPolicySchema = z.object({
  type: z.enum(PERMISSION_POLICIES),
});

/** 本平台内置工具（两个方言的并集；web_* 配置即拒绝，见 §12.3）。 */
export const BUILTIN_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "web_search",
] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

const toolConfigSchema = z.union([
  z
    .object({
      type: z.enum(["agent_toolset_20260401", "agent_toolset_20260601"]),
      default_config: z
        .object({ enabled: z.boolean().optional(), permission_policy: permissionPolicySchema.optional() })
        .strict()
        .optional(),
      configs: z
        .array(
          z
            .object({
              name: z.string().min(1).max(128),
              enabled: z.boolean().optional(),
              permission_policy: permissionPolicySchema.optional(),
            })
            .strict(),
        )
        .max(128)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("mcp_toolset"),
      mcp_server_name: z.string().min(1).max(256),
      default_config: z
        .object({ enabled: z.boolean().optional(), permission_policy: permissionPolicySchema.optional() })
        .strict()
        .optional(),
      configs: z
        .array(
          z
            .object({
              name: z.string().min(1).max(128),
              enabled: z.boolean().optional(),
              permission_policy: permissionPolicySchema.optional(),
            })
            .strict(),
        )
        .max(128)
        .optional(),
    })
    .strict(),
  // 自定义工具（spec Q5 / 二期 dynamicTools 的平台侧形态）：业务方自持执行体。
  // agent 调用时产生 agent.custom_tool_use + requires_action，业务方回 user.custom_tool_result 续轮。
  z
    .object({
      type: z.literal("custom"),
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/, "custom tool name must match [a-zA-Z0-9_-]{1,128}"),
      description: z.string().max(2_048).optional(),
      input_schema: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export type ToolConfig = z.infer<typeof toolConfigSchema>;

const mcpServerSchema = z
  .object({
    type: z.literal("url"),
    name: z.string().min(1).max(128),
    url: z
      .string()
      .max(2048)
      .refine((u) => u.startsWith("https://"), "mcp server url must use https"),
  })
  .strict()
  .refine(
    (s) => {
      const url = new URL(s.url);
      // 不允许 userinfo、fragment（AGT-11）
      return url.username === "" && url.password === "" && url.hash === "";
    },
    { message: "mcp server url must not contain credentials or fragments" },
  );

export type McpServer = z.infer<typeof mcpServerSchema>;

export const modelSchema = z
  .object({
    id: z.string().min(1).max(256),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    speed: z.literal("standard").optional(),
  })
  .strict();

export type AgentModel = z.infer<typeof modelSchema>;

export const agentCreateSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(2048).nullable().optional(),
    model: modelSchema,
    system: z.string().max(100_000).nullable().optional(),
    tools: z.array(toolConfigSchema).max(128).optional(),
    mcp_servers: z.array(mcpServerSchema).max(20).optional(),
    skills: z.array(z.string().min(3).max(128)).max(20).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.skills) {
      const set = new Set(a.skills);
      if (set.size !== a.skills.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "skills must not contain duplicates" });
      }
    }
    validateTools(a.tools ?? [], a.mcp_servers ?? [], ctx);
  });

export const agentUpdateSchema = z
  .object({
    name: z.string().min(1).max(256).nullable().optional(),
    description: z.string().max(2048).nullable().optional(),
    model: modelSchema.nullable().optional(),
    system: z.string().max(100_000).nullable().optional(),
    tools: z.array(toolConfigSchema).max(128).nullable().optional(),
    mcp_servers: z.array(mcpServerSchema).max(20).nullable().optional(),
    skills: z.array(z.string().min(3).max(128)).max(20).nullable().optional(),
    metadata: metadataSchema.nullable().optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.skills) {
      const set = new Set(a.skills);
      if (set.size !== a.skills.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "skills must not contain duplicates" });
      }
    }
    if (a.name !== undefined && a.name === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "name cannot be set to null" });
    }
    if (a.model !== undefined && a.model === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "model cannot be set to null" });
    }
    validateTools(a.tools ?? [], a.mcp_servers ?? [], ctx);
  });

function validateTools(
  tools: ToolConfig[],
  mcpServers: McpServer[],
  ctx: z.RefinementCtx,
): void {
  const serverNames = new Set(mcpServers.map((s) => s.name));
  for (const t of tools) {
    if (t.type === "mcp_toolset" && !serverNames.has(t.mcp_server_name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mcp_toolset references unknown mcp server ${t.mcp_server_name}`,
      });
    }
    if ("configs" in t && t.configs) {
      const seen = new Set<string>();
      for (const c of t.configs) {
        if (seen.has(c.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate config name ${c.name}` });
        }
        seen.add(c.name);
        if ((c.name === "web_fetch" || c.name === "web_search") && c.enabled !== false) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `builtin tool ${c.name} is not supported on this platform`,
          });
        }
      }
    }
  }
  for (const s of mcpServers) {
    const hasToolset = tools.some((t) => t.type === "mcp_toolset" && t.mcp_server_name === s.name);
    if (!hasToolset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mcp server ${s.name} has no matching mcp_toolset`,
      });
    }
  }
}

/** 规范化：tools 数组每个 toolset 补全 default_config 与 configs（AGT-02）。 */
export function normalizeAgentTools(tools: ToolConfig[]): ToolConfig[] {
  return tools.map((t) => {
    if (t.type === "custom") {
      return { type: "custom" as const, name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.input_schema };
    }
    if (t.type === "mcp_toolset") {
      return {
        type: "mcp_toolset" as const,
        mcp_server_name: t.mcp_server_name,
        default_config: t.default_config ?? { enabled: true },
        configs: t.configs ?? [],
      };
    }
    return {
      type: t.type,
      default_config: t.default_config ?? { enabled: true },
      configs: t.configs ?? [],
    };
  });
}

/** 深比较（规范化后），用于"无变化不升版本"（AGT-17）。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export interface AgentRecord {
  id: string;
  type: "agent";
  name: string;
  description: string | null;
  model: AgentModel;
  system: string | null;
  tools: ToolConfig[];
  mcp_servers: McpServer[];
  skills: [];
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** merge metadata：按键合并，值为 null 删除该键，整体 null 清空（GEN-04）。 */
export function mergeMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null | undefined,
): Record<string, string> {
  if (patch === null) return {};
  if (patch === undefined) return current;
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  const entries = Object.entries(next);
  if (entries.length > 16) throw errInvalid("metadata must have at most 16 keys");
  return Object.fromEntries(entries);
}
