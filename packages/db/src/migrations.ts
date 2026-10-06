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
];
