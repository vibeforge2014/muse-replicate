/** 前向迁移（只能追加，不能修改已发布的条目）。 */
export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0001_core",
    sql: /* sql */ `
CREATE TABLE orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  hash text NOT NULL,
  prefix text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '["*"]',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE agents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  head_version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_versions (
  agent_id text NOT NULL REFERENCES agents(id),
  version int NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);
CREATE TABLE environments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  description text,
  config jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    name: "0002_sessions_events",
    sql: /* sql */ `
CREATE TABLE sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  agent_snapshot jsonb NOT NULL,
  environment_id text NOT NULL,
  environment_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  stop_reason jsonb,
  title text,
  metadata jsonb NOT NULL DEFAULT '{}',
  vault_ids text[] NOT NULL DEFAULT '{}',
  usage jsonb NOT NULL DEFAULT '{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}',
  last_event_seq bigint NOT NULL DEFAULT 0,
  last_processed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session_events (
  session_id text NOT NULL,
  seq bigint,
  id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  disposition text NOT NULL DEFAULT 'normal',
  source_event_id text,
  generation bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);
CREATE UNIQUE INDEX session_events_seq_uk ON session_events (session_id, seq) WHERE seq IS NOT NULL;
CREATE UNIQUE INDEX session_events_source_uk ON session_events (session_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX session_events_history_ix ON session_events (session_id, seq ASC, received_at ASC);
CREATE INDEX session_events_pending_ix ON session_events (session_id, received_at ASC) WHERE seq IS NULL;
`,
  },
  {
    name: "0003_executions",
    sql: /* sql */ `
CREATE TABLE session_executions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  session_id text NOT NULL REFERENCES sessions(id),
  lane_id text NOT NULL DEFAULT 'main',
  kind text NOT NULL,
  input_event_ids text[] NOT NULL DEFAULT '{}',
  input_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  owner_id text,
  attempt_id text,
  generation bigint NOT NULL DEFAULT 0,
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  deadline_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  interrupt_requested_at timestamptz,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  settled_at timestamptz,
  failure jsonb,
  revision bigint NOT NULL DEFAULT 0
);
CREATE INDEX execution_claim_ix ON session_executions (state, lease_expires_at, admitted_at);
CREATE INDEX execution_lane_ix ON session_executions (workspace_id, session_id, lane_id, admitted_at);
`,
  },
  {
    name: "0005_checkpoints",
    sql: /* sql */ `
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_completed_execution_id text,
  ADD COLUMN IF NOT EXISTS active_workspace_checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS codex_thread_id text,
  ADD COLUMN IF NOT EXISTS codex_version_digest text;
CREATE TABLE workspace_checkpoints (
  checkpoint_id text PRIMARY KEY,
  session_id text NOT NULL,
  generation bigint NOT NULL,
  execution_id text NOT NULL,
  manifest jsonb NOT NULL,
  state text NOT NULL DEFAULT 'candidate',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_checkpoints_session_ix ON workspace_checkpoints (session_id, created_at DESC);
`,
  },
  {
    name: "0004_files_resources",
    sql: /* sql */ `
CREATE TABLE files (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  scope_type text NOT NULL DEFAULT 'org',
  scope_id text,
  filename text NOT NULL,
  mime text NOT NULL DEFAULT 'application/octet-stream',
  size bigint NOT NULL,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE TABLE session_resources (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  type text NOT NULL,
  file_id text NOT NULL,
  mount_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_keys (
  workspace_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
CREATE TABLE session_internal_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    name: "0006_vaults_outputs",
    sql: `
CREATE TABLE vaults (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  display_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credentials (
  id text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vaults(id),
  workspace_id text NOT NULL,
  type text NOT NULL,
  identity_key text NOT NULL,
  secret_ciphertext text NOT NULL,
  networking jsonb NOT NULL DEFAULT '{}',
  injection jsonb,
  last_four text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, type, identity_key)
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_output_manifest jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS files_session_output_ix
  ON files (scope_id, filename, sha256) WHERE scope_type = 'session';
`,
  },
  {
    name: "0007_sandbox",
    sql: `
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_id text;
CREATE TABLE IF NOT EXISTS sandbox_orphans (
  id bigserial PRIMARY KEY,
  sandbox_ref text NOT NULL,
  session_id text NOT NULL,
  generation bigint NOT NULL,
  reason text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
`,
  },
  {
    name: "0008_memory",
    sql: `
CREATE TABLE IF NOT EXISTS memory_stores (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  store_id text NOT NULL REFERENCES memory_stores(id),
  workspace_id text NOT NULL,
  path text NOT NULL,
  head_version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, path)
);
CREATE TABLE IF NOT EXISTS memory_versions (
  id text PRIMARY KEY,
  memory_id text NOT NULL REFERENCES memories(id),
  workspace_id text NOT NULL,
  version_no int NOT NULL,
  path text,
  content text,
  content_sha256 text,
  size_bytes bigint NOT NULL,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_id, version_no)
);
CREATE INDEX IF NOT EXISTS memory_versions_memory_ix ON memory_versions (memory_id, version_no DESC);
ALTER TABLE session_resources
  ALTER COLUMN file_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS memory_store_id text,
  ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT true;
`,
  },
  {
    name: "0009_skills",
    sql: `
CREATE TABLE IF NOT EXISTS skills (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  source text NOT NULL DEFAULT 'user',
  directory text NOT NULL,
  description text,
  latest_version int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, directory)
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id text PRIMARY KEY,
  skill_id text NOT NULL REFERENCES skills(id),
  workspace_id text NOT NULL,
  version int NOT NULL,
  object_key text NOT NULL,
  file_count int NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
ALTER TABLE session_resources
  ADD COLUMN IF NOT EXISTS skill_id text,
  ADD COLUMN IF NOT EXISTS skill_version int;
`,
  },
  {
    name: "0010_deployments",
    sql: `
CREATE TABLE IF NOT EXISTS deployments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  agent_id text NOT NULL,
  agent_version int NOT NULL,
  environment_id text NOT NULL,
  schedule text,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  input jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  last_scheduled_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS deployment_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  deployment_id text NOT NULL REFERENCES deployments(id),
  session_id text,
  trigger_type text NOT NULL,
  trigger_context jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  error jsonb,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deployment_runs_dep_ix ON deployment_runs (deployment_id, created_at DESC);
`,
  },
  {
    name: "0011_webhooks",
    sql: `
CREATE TABLE IF NOT EXISTS webhooks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  url text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]',
  secret text NOT NULL,
  description text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  webhook_id text NOT NULL REFERENCES webhooks(id),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code int,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_ix ON webhook_deliveries (status, next_attempt_at);
`,
  },
];