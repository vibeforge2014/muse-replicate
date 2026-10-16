import { call, listAll, getApiKey, setApiKey, getApiBase, setApiBase, MasApiError } from "./client";
import type {
  AgentRecord,
  EnvironmentRecord,
  SessionRecord,
  SessionResource,
  UserInputEvent,
  EventEnvelope,
  FileRecord,
  VaultRecord,
  CredentialRecord,
  MemoryStoreRecord,
  SkillRecord,
  DeploymentRecord,
  WebhookRecord,
  Page,
  SessionUsage,
  ModelConfig,
} from "./types";

// ---------- Agents ----------
export const agents = {
  list: (includeArchived = false) =>
    listAll<AgentRecord>("/v1/agents", { include_archived: includeArchived ? "true" : "false" }),
  get: (id: string) => call<AgentRecord>(`/v1/agents/${id}`),
  create: (body: {
    name: string;
    description?: string | null;
    model: ModelConfig;
    system?: string | null;
    tools?: any[];
    mcp_servers?: any[];
    skills?: string[];
    metadata?: Record<string, string>;
  }) => call<AgentRecord>("/v1/agents", { method: "POST", body }),
  update: (
    id: string,
    body: Partial<{
      name: string;
      description: string | null;
      model: ModelConfig;
      system: string | null;
      tools: any[];
      mcp_servers: any[];
      skills: string[];
      metadata: Record<string, string>;
    }> & { version: number }
  ) => call<AgentRecord>(`/v1/agents/${id}`, { method: "POST", body }),
  archive: (id: string) => call<AgentRecord>(`/v1/agents/${id}/archive`, { method: "POST", body: {} }),
};

// ---------- Environments ----------
export const environments = {
  list: (includeArchived = false) =>
    listAll<EnvironmentRecord>("/v1/environments", { include_archived: includeArchived ? "true" : "false" }),
  get: (id: string) => call<EnvironmentRecord>(`/v1/environments/${id}`),
  create: (body: {
    name: string;
    description?: string | null;
    config: any;
    metadata?: Record<string, string>;
  }) => call<EnvironmentRecord>("/v1/environments", { method: "POST", body }),
  update: (
    id: string,
    body: { name?: string; description?: string | null; config?: any; metadata?: Record<string, string> }
  ) => call<EnvironmentRecord>(`/v1/environments/${id}`, { method: "POST", body }),
  archive: (id: string) => call<EnvironmentRecord>(`/v1/environments/${id}/archive`, { method: "POST", body: {} }),
};

// ---------- Sessions ----------
export const sessions = {
  list: (query: { agent_id?: string; statuses?: string; include_archived?: boolean } = {}) =>
    listAll<SessionRecord>("/v1/sessions", {
      ...(query.agent_id ? { agent_id: query.agent_id } : {}),
      ...(query.statuses ? { statuses: query.statuses } : {}),
      include_archived: query.include_archived ? "true" : "false",
    }),
  get: (id: string) => call<SessionRecord>(`/v1/sessions/${id}`),
  create: (body: {
    agent: string | { type: "agent"; id: string; version: number } | any;
    environment_id: string;
    title?: string;
    metadata?: Record<string, string>;
    resources?: SessionResource[];
    vault_ids?: string[];
    initial_events?: { type: "user.message"; content: any[] }[];
  }) => call<SessionRecord>("/v1/sessions", { method: "POST", body }),
  update: (id: string, body: { title?: string; metadata?: Record<string, string> }) =>
    call<SessionRecord>(`/v1/sessions/${id}`, { method: "POST", body }),
  archive: (id: string) => call<SessionRecord>(`/v1/sessions/${id}/archive`, { method: "POST", body: {} }),
  delete: (id: string) => call<{ id: string; type: "session"; deleted: true }>(`/v1/sessions/${id}`, { method: "DELETE" }),

  // events
  sendEvents: (id: string, events: UserInputEvent[], laneId = "main") =>
    call<{ data: EventEnvelope[] }>(`/v1/sessions/${id}/events`, {
      method: "POST",
      body: { events, lane_id: laneId },
    }),
  listEvents: (id: string, query: { types?: string; order?: "asc" | "desc"; limit?: number; after_seq?: number } = {}) =>
    call<Page<EventEnvelope>>(`/v1/sessions/${id}/events`, { query }),
  // resources
  listResources: (id: string) =>
    call<{ data: SessionResource[] }>(`/v1/sessions/${id}/resources`),
  mountResource: (id: string, resource: SessionResource) =>
    call<{ data: SessionResource[] }>(`/v1/sessions/${id}/resources`, { method: "POST", body: resource }),
  unmountResource: (id: string, rid: string) =>
    call<{ data: SessionResource[] }>(`/v1/sessions/${id}/resources/${rid}`, { method: "DELETE" }),
};

// ---------- Files ----------
export const files = {
  list: (scope?: "org") => listAll<FileRecord>(scope ? `/v1/files?scope=${scope}` : "/v1/files"),
  upload: async (filename: string, content: Blob, options: { expiresAt?: string } = {}) => {
    const fd = new FormData();
    fd.append("file", content, filename);
    if (options.expiresAt) fd.append("expires_at", options.expiresAt);
    return call<FileRecord>("/v1/files", { method: "POST", raw: fd });
  },
  get: (id: string) => call<FileRecord>(`/v1/files/${id}`),
  delete: (id: string) => call<{ id: string; deleted: true }>(`/v1/files/${id}`, { method: "DELETE" }),
  downloadUrl: (id: string) => `${window.location.origin}${getPath()}/v1/files/${id}/content`,
};

function getPath() {
  // base path for API; console base is /console/ so we need to remove it
  return window.location.pathname.startsWith("/console") ? "/console" : "";
}

// ---------- Vaults / Credentials ----------
export const vaults = {
  list: (includeArchived = false) =>
    listAll<VaultRecord>("/v1/vaults", { include_archived: includeArchived ? "true" : "false" }),
  get: (id: string) => call<VaultRecord>(`/v1/vaults/${id}`),
  create: (body: { name: string; description?: string | null; metadata?: Record<string, string> }) =>
    call<VaultRecord>("/v1/vaults", { method: "POST", body }),
  archive: (id: string) => call<VaultRecord>(`/v1/vaults/${id}/archive`, { method: "POST", body: {} }),
  credentials: {
    list: (vaultId: string) => listAll<CredentialRecord>(`/v1/vaults/${vaultId}/credentials`),
    create: (
      vaultId: string,
      body: {
        credential_type: "environment_variable" | "static_bearer" | "bearer";
        name: string;
        description?: string;
        secret_value: string;
        metadata?: Record<string, string>;
      }
    ) => call<CredentialRecord>(`/v1/vaults/${vaultId}/credentials`, { method: "POST", body }),
    archive: (vaultId: string, id: string) =>
      call<CredentialRecord>(`/v1/vaults/${vaultId}/credentials/${id}/archive`, { method: "POST", body: {} }),
  },
};

// ---------- Memory ----------
export const memory = {
  stores: {
    list: () => listAll<MemoryStoreRecord>("/v1/memory/stores"),
    create: (body: { name: string; description?: string; metadata?: Record<string, string> }) =>
      call<MemoryStoreRecord>("/v1/memory/stores", { method: "POST", body }),
  },
};

// ---------- Skills ----------
export const skills = {
  list: () => listAll<SkillRecord>("/v1/skills"),
  upload: async (name: string, zip: Blob) => {
    const fd = new FormData();
    fd.append("file", zip, name);
    return call<SkillRecord>("/v1/skills", { method: "POST", raw: fd });
  },
};

// ---------- Deployments ----------
export const deployments = {
  list: (query: { agent_id?: string; has_error?: boolean; trigger_type?: string } = {}) =>
    listAll<DeploymentRecord>("/v1/deployments", {
      ...(query.agent_id ? { agent_id: query.agent_id } : {}),
      ...(query.has_error !== undefined ? { has_error: String(query.has_error) } : {}),
      ...(query.trigger_type ? { trigger_type: query.trigger_type } : {}),
    }),
  get: (id: string) => call<DeploymentRecord>(`/v1/deployments/${id}`),
  create: (body: {
    agent_id: string;
    name: string;
    description?: string;
    cron?: string;
    manual_only?: boolean;
    metadata?: Record<string, string>;
  }) => call<DeploymentRecord>("/v1/deployments", { method: "POST", body }),
  archive: (id: string) => call<DeploymentRecord>(`/v1/deployments/${id}/archive`, { method: "POST", body: {} }),
  run: (id: string) => call<{ id: string }>(`/v1/deployments/${id}/run`, { method: "POST", body: {} }),
};

// ---------- Webhooks ----------
export const webhooks = {
  list: () => listAll<WebhookRecord>("/v1/webhooks"),
  get: (id: string) => call<WebhookRecord>(`/v1/webhooks/${id}`),
  create: (body: { name: string; url: string; events: string[]; enabled?: boolean }) =>
    call<WebhookRecord & { secret?: string }>("/v1/webhooks", { method: "POST", body }),
  archive: (id: string) => call<WebhookRecord>(`/v1/webhooks/${id}/archive`, { method: "POST", body: {} }),
  deliveries: (id: string) =>
    listAll<any>(`/v1/webhooks/${id}/deliveries`),
};

// ---------- Health ----------
export const health = {
  check: () => call<{ status: string }>("/healthz", { idempotent: false }),
};

// 认证 / 配置
export { getApiKey, setApiKey, getApiBase, setApiBase, MasApiError };

// 重新导出
export type { SessionUsage };
