// API 类型定义 — 与 packages/core/src/schemas/*.ts 保持一致
// 优先手写保持可读性；OpenAPI 规范零漂移校验在 tests/openapi.test.ts

export type Effort = "low" | "medium" | "high" | "max";
export type Speed = "standard";
export type Isolation = "gvisor" | "microvm" | "runc";

export interface ModelConfig {
  id: string;
  effort: Effort;
  speed: Speed;
}

export type PermissionPolicy =
  | { type: "always_allow" }
  | { type: "always_ask" }
  | { type: "accept_by_policy" };

export interface ToolConfig {
  name: string;
  enabled: boolean;
  permission_policy: PermissionPolicy;
}

export type AgentTool =
  | {
      type: "agent_toolset_20260401" | "agent_toolset_20260601";
      default_config: { enabled: boolean; permission_policy: PermissionPolicy };
      configs?: ToolConfig[];
    }
  | {
      type: "mcp_toolset";
      mcp_server_name: string;
      default_config: { enabled: boolean; permission_policy: PermissionPolicy };
      configs?: ToolConfig[];
    }
  | {
      type: "custom";
      name: string;
      description?: string;
      input_schema: Record<string, unknown>;
    };

export type McpServer =
  | { type: "url"; name: string; url: string }
  | { type: "stdio"; name: string; command: string; args?: string[]; env?: Record<string, string> };

export interface AgentRecord {
  id: string;
  type: "agent";
  name: string;
  description: string | null;
  model: ModelConfig;
  system: string | null;
  tools: AgentTool[];
  mcp_servers: McpServer[];
  skills: string[];
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface EnvironmentConfig {
  type: "cloud";
  isolation?: Isolation;
  packages?: { apt?: string[]; npm?: string[]; pip?: string[]; cargo?: string[]; gem?: string[]; go?: string[] };
  networking:
    | { type: "unrestricted" }
    | {
        type: "limited";
        allowed_hosts: string[];
        allow_package_managers: boolean;
        allow_mcp_servers: boolean;
      };
}

export interface EnvironmentRecord {
  id: string;
  type: "environment";
  name: string;
  description: string | null;
  config: EnvironmentConfig;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export type StopReason =
  | { type: "end_turn" }
  | { type: "requires_action"; event_ids: string[] }
  | { type: "error"; error_type: string }
  | { type: "retries_exhausted" }
  | { type: "capability_unsatisfied" };

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface SessionResource {
  type: "file" | "memory_store" | "skill";
  file_id?: string;
  memory_store_id?: string;
  skill_id?: string;
  skill_version?: number;
  mount_path: string;
  read_only?: boolean;
}

export interface SessionRecord {
  id: string;
  type: "session";
  status: SessionStatus;
  stop_reason: StopReason | null;
  agent: {
    type: "agent" | "agent_with_overrides";
    id: string;
    version: number;
    name: string;
    model: ModelConfig;
    system: string | null;
    tools: AgentTool[];
    mcp_servers: McpServer[];
    skills: string[];
    metadata: Record<string, string>;
  };
  environment_id: string;
  title: string | null;
  metadata: Record<string, string>;
  resources: SessionResource[];
  vault_ids: string[];
  usage: SessionUsage;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface UserContentBlock {
  type: "text";
  text: string;
}
export interface ImageContentBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type ContentBlock = UserContentBlock | ImageContentBlock;

export type UserInputEvent =
  | { type: "user.message"; content: ContentBlock[] }
  | { type: "user.interrupt" }
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string }
  | { type: "user.custom_tool_result"; tool_use_id: string; output: string }
  | { type: "user.define_outcome"; outcome: Record<string, unknown> };

export interface EventEnvelope {
  id: string;
  type: string;
  processed_at: string | null;
  seq?: number;
  // payload 字段平铺
  [k: string]: unknown;
}

export interface FileRecord {
  id: string;
  type: "file";
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface VaultRecord {
  id: string;
  type: "vault";
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CredentialRecord {
  id: string;
  type: "credential";
  vault_id: string;
  credential_type: "environment_variable" | "static_bearer" | "bearer";
  name: string;
  description: string | null;
  masked_value: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface MemoryStoreRecord {
  id: string;
  type: "memory_store";
  name: string;
  slug: string;
  description: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SkillRecord {
  id: string;
  type: "skill";
  name: string;
  directory: string;
  description: string | null;
  version: number;
  size: number;
  sha256: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DeploymentRecord {
  id: string;
  type: "deployment";
  agent_id: string;
  agent_version: number;
  name: string;
  description: string | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  manual_only: boolean;
  last_scheduled_at: string | null;
  upcoming_runs_at: string[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface WebhookRecord {
  id: string;
  type: "webhook";
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Page<T> {
  data: T[];
  next_page: string | null;
}

export interface ApiError {
  type: string;
  message: string;
  request_id?: string;
}
