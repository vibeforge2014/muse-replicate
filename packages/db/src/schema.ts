import type { Generated } from "kysely";

export interface OrgRow {
  id: string;
  name: string;
  settings: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
}
export interface WorkspaceRow {
  id: string;
  org_id: string;
  name: string;
  created_at: Generated<Date>;
}
export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  hash: string;
  prefix: string;
  scopes: Generated<unknown>;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}
export interface AgentRow {
  id: string;
  workspace_id: string;
  head_version: Generated<number>;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface AgentVersionRow {
  agent_id: string;
  version: number;
  config: Record<string, unknown>;
  created_at: Generated<Date>;
}
export interface EnvironmentRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  metadata: Generated<Record<string, string>>;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface SessionRow {
  id: string;
  workspace_id: string;
  agent_snapshot: Record<string, unknown>;
  environment_id: string;
  environment_snapshot: Record<string, unknown>;
  status: Generated<string>;
  stop_reason: Record<string, unknown> | null;
  title: string | null;
  metadata: Generated<Record<string, string>>;
  vault_ids: Generated<string[]>;
  usage: Generated<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number }>;
  last_event_seq: Generated<number>;
  last_processed_at: Date | null;
  last_completed_execution_id: string | null;
  active_workspace_checkpoint: Record<string, unknown> | null;
  active_output_manifest: Record<string, unknown> | null;
  sandbox_id: string | null;
  codex_thread_id: string | null;
  codex_version_digest: string | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface SessionEventRow {
  session_id: string;
  seq: number | null;
  id: string;
  type: string;
  payload: Generated<Record<string, unknown>>;
  processed_at: Date | null;
  received_at: Generated<Date>;
  disposition: Generated<string>;
  source_event_id: string | null;
  generation: number | null;
  created_at: Generated<Date>;
}
export interface ExecutionRow {
  id: string;
  workspace_id: string;
  session_id: string;
  lane_id: Generated<string>;
  kind: string;
  input_event_ids: Generated<string[]>;
  input_fingerprint: string;
  state: Generated<string>;
  owner_id: string | null;
  attempt_id: string | null;
  generation: Generated<number>;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  deadline_at: Date;
  lease_expires_at: Date | null;
  interrupt_requested_at: Date | null;
  admitted_at: Generated<Date>;
  claimed_at: Date | null;
  delivered_at: Date | null;
  settled_at: Date | null;
  failure: Record<string, unknown> | null;
  revision: Generated<number>;
}
export interface FileRow {
  id: string;
  workspace_id: string;
  scope_type: Generated<string>;
  scope_id: string | null;
  filename: string;
  mime: Generated<string>;
  size: number;
  sha256: string;
  object_key: string;
  created_at: Generated<Date>;
  expires_at: Date | null;
}
export interface VaultRow {
  id: string;
  workspace_id: string;
  display_name: string;
  metadata: Generated<Record<string, unknown>>;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface CredentialRow {
  id: string;
  vault_id: string;
  workspace_id: string;
  type: string;
  identity_key: string;
  secret_ciphertext: string;
  networking: Generated<Record<string, unknown>>;
  injection: Record<string, unknown> | null;
  last_four: Generated<string>;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface SessionResourceRow {
  id: string;
  session_id: string;
  type: string;
  file_id: string;
  mount_path: string;
  created_at: Generated<Date>;
}
export interface IdempotencyKeyRow {
  workspace_id: string;
  key: string;
  request_hash: string;
  response: Record<string, unknown> | null;
  created_at: Generated<Date>;
}
export interface SandboxOrphanRow {
  id: Generated<number>;
  sandbox_ref: string;
  session_id: string;
  generation: number;
  reason: string;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: Generated<Date>;
  resolved_at: Date | null;
}
export interface WorkspaceCheckpointRow {
  checkpoint_id: string;
  session_id: string;
  generation: number;
  execution_id: string;
  manifest: Record<string, unknown>;
  state: string;
  created_at: Generated<Date>;
}

export interface SessionInternalEventRow {
  id: Generated<number>;
  session_id: string;
  type: string;
  payload: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface Database {
  orgs: OrgRow;
  workspaces: WorkspaceRow;
  api_keys: ApiKeyRow;
  agents: AgentRow;
  agent_versions: AgentVersionRow;
  environments: EnvironmentRow;
  sessions: SessionRow;
  session_events: SessionEventRow;
  session_executions: ExecutionRow;
  files: FileRow;
  vaults: VaultRow;
  credentials: CredentialRow;
  session_resources: SessionResourceRow;
  idempotency_keys: IdempotencyKeyRow;
  session_internal_events: SessionInternalEventRow;
  workspace_checkpoints: WorkspaceCheckpointRow;
  sandbox_orphans: SandboxOrphanRow;
}
