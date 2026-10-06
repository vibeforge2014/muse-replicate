/**
 * @mas/sdk — 由 docs/openapi.yaml 生成的类型 + 轻量 fetch client。
 *
 * 类型来自 `pnpm --filter @mas/sdk gen`（openapi-typescript）；
 * client 发送 BigModel 方言 headers（zai-version / zai-beta）与 Bearer 凭证，
 * 非 2xx 统一抛 MasApiError（错误信封 {type:"error", error:{...}, request_id}）。
 */
import type { components } from "./generated/schema.js";

export type { components, operations, paths } from "./generated/schema.js";

// 常用实体类型别名（生成类型的薄外壳）
export type Agent = components["schemas"]["Agent"];
export type AgentCreate = components["schemas"]["AgentCreate"];
export type AgentUpdate = components["schemas"]["AgentUpdate"];
export type Environment = components["schemas"]["Environment"];
export type Session = components["schemas"]["Session"];
export type SessionEvent = components["schemas"]["SessionEvent"];
export type FileObject = components["schemas"]["FileObject"];
export type Vault = components["schemas"]["Vault"];
export type Credential = components["schemas"]["Credential"];
export type MemoryStore = components["schemas"]["MemoryStore"];
export type Memory = components["schemas"]["Memory"];
export type MemoryVersion = components["schemas"]["MemoryVersion"];
export type Skill = components["schemas"]["Skill"];
export type SkillVersion = components["schemas"]["SkillVersion"];
export type Deployment = components["schemas"]["Deployment"];
export type DeploymentRun = components["schemas"]["DeploymentRun"];
export type Webhook = components["schemas"]["Webhook"];
export type WebhookDelivery = components["schemas"]["WebhookDelivery"];

/** 列表响应（next_page 游标原样回传给下一页请求）。 */
export interface ListResult<T> {
  data: T[];
  next_page?: string | null;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface MasClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
}

/** 服务端错误信封的异常化形态。 */
export class MasApiError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly details?: unknown;
  readonly requestId?: string;
  constructor(status: number, errorType: string, message: string, details?: unknown, requestId?: string) {
    super(`[${status} ${errorType}] ${message}`);
    this.name = "MasApiError";
    this.status = status;
    this.errorType = errorType;
    this.message = message;
    this.details = details;
    this.requestId = requestId;
  }
}

const DIALECT_HEADERS: Record<string, string> = {
  "zai-version": "2026-05-26",
  "zai-beta": "managed-agents-2026-05-26",
};

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export class MasClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: MasClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const env = (json ?? {}) as { error?: { type?: string; message?: string; details?: unknown }; request_id?: string };
      throw new MasApiError(
        res.status,
        env.error?.type ?? "api_error",
        env.error?.message ?? res.statusText,
        env.error?.details,
        env.request_id,
      );
    }
    return json as T;
  }

  /** 通用请求入口：JSON body + 方言 headers + 错误信封解析。 */
  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    opts?: { query?: Record<string, QueryValue>; idempotencyKey?: string },
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}${buildQuery(opts?.query)}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...DIALECT_HEADERS,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res);
  }

  private async multipart<T>(
    path: string,
    form: FormData,
    opts?: { idempotencyKey?: string },
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...DIALECT_HEADERS,
        ...(opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: form,
    });
    return this.parse<T>(res);
  }

  /** 二进制下载（文件内容 / skill zip）：返回原始 Response，由调用方读流。 */
  async download(path: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.apiKey}`, ...DIALECT_HEADERS },
    });
  }

  /** SSE 事件流：返回原始 Response（text/event-stream），由调用方读流。 */
  async streamEvents(sessionId: string, lastEventId?: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/v1/sessions/${sessionId}/events/stream`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...DIALECT_HEADERS,
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
    });
  }

  // ---- Agents ----
  createAgent(body: AgentCreate, opts?: { idempotencyKey?: string }): Promise<Agent> {
    return this.request("POST", "/v1/agents", body, opts);
  }
  listAgents(query?: Record<string, QueryValue>): Promise<ListResult<Agent>> {
    return this.request("GET", "/v1/agents", undefined, { query });
  }
  getAgent(id: string, version?: number): Promise<Agent> {
    return this.request("GET", `/v1/agents/${id}`, undefined, { query: { version } });
  }
  updateAgent(id: string, body: AgentUpdate, opts?: { idempotencyKey?: string }): Promise<Agent> {
    return this.request("POST", `/v1/agents/${id}`, body, opts);
  }
  listAgentVersions(id: string): Promise<ListResult<Agent>> {
    return this.request("GET", `/v1/agents/${id}/versions`);
  }
  archiveAgent(id: string): Promise<Agent> {
    return this.request("POST", `/v1/agents/${id}/archive`);
  }

  // ---- Environments ----
  createEnvironment(body: components["schemas"]["EnvironmentCreate"], opts?: { idempotencyKey?: string }): Promise<Environment> {
    return this.request("POST", "/v1/environments", body, opts);
  }
  listEnvironments(query?: Record<string, QueryValue>): Promise<ListResult<Environment>> {
    return this.request("GET", "/v1/environments", undefined, { query });
  }
  getEnvironment(id: string): Promise<Environment> {
    return this.request("GET", `/v1/environments/${id}`);
  }
  updateEnvironment(id: string, body: components["schemas"]["EnvironmentUpdate"], opts?: { idempotencyKey?: string }): Promise<Environment> {
    return this.request("POST", `/v1/environments/${id}`, body, opts);
  }
  deleteEnvironment(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/environments/${id}`);
  }
  archiveEnvironment(id: string): Promise<Environment> {
    return this.request("POST", `/v1/environments/${id}/archive`);
  }

  // ---- Sessions ----
  createSession(body: components["schemas"]["SessionCreate"], opts?: { idempotencyKey?: string }): Promise<Session> {
    return this.request("POST", "/v1/sessions", body, opts);
  }
  listSessions(query?: Record<string, QueryValue>): Promise<ListResult<Session>> {
    return this.request("GET", "/v1/sessions", undefined, { query });
  }
  getSession(id: string): Promise<Session> {
    return this.request("GET", `/v1/sessions/${id}`);
  }
  updateSession(id: string, body: components["schemas"]["SessionUpdate"], opts?: { idempotencyKey?: string }): Promise<Session> {
    return this.request("POST", `/v1/sessions/${id}`, body, opts);
  }
  deleteSession(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/sessions/${id}`);
  }
  archiveSession(id: string): Promise<Session> {
    return this.request("POST", `/v1/sessions/${id}/archive`);
  }
  listSessionResources(id: string): Promise<ListResult<components["schemas"]["SessionResource"]>> {
    return this.request("GET", `/v1/sessions/${id}/resources`);
  }
  mountSessionResource(id: string, body: components["schemas"]["SessionResourceMount"]): Promise<components["schemas"]["SessionResource"]> {
    return this.request("POST", `/v1/sessions/${id}/resources`, body);
  }
  unmountSessionResource(id: string, rid: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/sessions/${id}/resources/${rid}`);
  }

  // ---- Events ----
  sendEvents(
    sessionId: string,
    events: components["schemas"]["EventsSend"]["events"],
    opts?: { idempotencyKey?: string },
  ): Promise<{ data: SessionEvent[] }> {
    return this.request("POST", `/v1/sessions/${sessionId}/events`, { events }, opts);
  }
  listEvents(sessionId: string, query?: Record<string, QueryValue>): Promise<ListResult<SessionEvent>> {
    return this.request("GET", `/v1/sessions/${sessionId}/events`, undefined, { query });
  }

  // ---- Files ----
  async uploadFile(
    input: { filename: string; content: Uint8Array | string; content_type?: string },
    opts?: { idempotencyKey?: string },
  ): Promise<FileObject> {
    const form = new FormData();
    form.append("file", new Blob([input.content], input.content_type ? { type: input.content_type } : undefined), input.filename);
    return this.multipart("/v1/files", form, opts);
  }
  listFiles(query?: Record<string, QueryValue>): Promise<ListResult<FileObject>> {
    return this.request("GET", "/v1/files", undefined, { query });
  }
  getFile(id: string): Promise<FileObject> {
    return this.request("GET", `/v1/files/${id}`);
  }
  deleteFile(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/files/${id}`);
  }
  downloadFileContent(id: string): Promise<Response> {
    return this.download(`/v1/files/${id}/content`);
  }

  // ---- Vaults & credentials ----
  createVault(body: components["schemas"]["VaultCreate"], opts?: { idempotencyKey?: string }): Promise<Vault> {
    return this.request("POST", "/v1/vaults", body, opts);
  }
  listVaults(query?: Record<string, QueryValue>): Promise<ListResult<Vault>> {
    return this.request("GET", "/v1/vaults", undefined, { query });
  }
  getVault(id: string): Promise<Vault> {
    return this.request("GET", `/v1/vaults/${id}`);
  }
  deleteVault(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/vaults/${id}`);
  }
  archiveVault(id: string): Promise<Vault> {
    return this.request("POST", `/v1/vaults/${id}/archive`);
  }
  listCredentials(vaultId: string): Promise<ListResult<Credential>> {
    return this.request("GET", `/v1/vaults/${vaultId}/credentials`);
  }
  createCredential(vaultId: string, body: components["schemas"]["CredentialCreate"]): Promise<Credential> {
    return this.request("POST", `/v1/vaults/${vaultId}/credentials`, body);
  }
  getCredential(vaultId: string, cid: string): Promise<Credential> {
    return this.request("GET", `/v1/vaults/${vaultId}/credentials/${cid}`);
  }
  rotateCredential(vaultId: string, cid: string, body: components["schemas"]["CredentialRotate"]): Promise<Credential> {
    return this.request("POST", `/v1/vaults/${vaultId}/credentials/${cid}`, body);
  }
  deleteCredential(vaultId: string, cid: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/vaults/${vaultId}/credentials/${cid}`);
  }
  archiveCredential(vaultId: string, cid: string): Promise<Credential> {
    return this.request("POST", `/v1/vaults/${vaultId}/credentials/${cid}/archive`);
  }

  // ---- Memory ----
  createMemoryStore(body: components["schemas"]["MemoryStoreCreate"], opts?: { idempotencyKey?: string }): Promise<MemoryStore> {
    return this.request("POST", "/v1/memory-stores", body, opts);
  }
  listMemoryStores(query?: Record<string, QueryValue>): Promise<ListResult<MemoryStore>> {
    return this.request("GET", "/v1/memory-stores", undefined, { query });
  }
  getMemoryStore(id: string): Promise<MemoryStore> {
    return this.request("GET", `/v1/memory-stores/${id}`);
  }
  deleteMemoryStore(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/memory-stores/${id}`);
  }
  archiveMemoryStore(id: string): Promise<MemoryStore> {
    return this.request("POST", `/v1/memory-stores/${id}/archive`);
  }
  upsertMemory(storeId: string, body: components["schemas"]["MemoryUpsert"], opts?: { idempotencyKey?: string }): Promise<Memory> {
    return this.request("POST", `/v1/memory-stores/${storeId}/memories`, body, opts);
  }
  listMemories(storeId: string, query?: Record<string, QueryValue>): Promise<ListResult<components["schemas"]["MemoryListItem"]>> {
    return this.request("GET", `/v1/memory-stores/${storeId}/memories`, undefined, { query });
  }
  getMemory(storeId: string, memoryId: string): Promise<Memory> {
    return this.request("GET", `/v1/memory-stores/${storeId}/memories/${memoryId}`);
  }
  deleteMemory(storeId: string, memoryId: string, expectedContentSha256?: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/memory-stores/${storeId}/memories/${memoryId}`, undefined, {
      query: { expected_content_sha256: expectedContentSha256 },
    });
  }
  listMemoryVersions(storeId: string, memoryId: string, query?: Record<string, QueryValue>): Promise<ListResult<MemoryVersion>> {
    return this.request("GET", `/v1/memory-stores/${storeId}/memories/${memoryId}/versions`, undefined, { query });
  }
  redactMemoryVersion(storeId: string, memoryId: string, versionId: string): Promise<MemoryVersion> {
    return this.request("POST", `/v1/memory-stores/${storeId}/memories/${memoryId}/versions/${versionId}/redact`);
  }

  // ---- Skills ----
  async uploadSkill(
    input: { zip: Uint8Array; directory?: string; description?: string },
    opts?: { idempotencyKey?: string },
  ): Promise<Skill> {
    const form = new FormData();
    form.append("file", new Blob([input.zip], { type: "application/zip" }), "skill.zip");
    if (input.directory !== undefined) form.append("directory", input.directory);
    if (input.description !== undefined) form.append("description", input.description);
    return this.multipart("/v1/skills", form, opts);
  }
  listSkills(query?: Record<string, QueryValue>): Promise<ListResult<Skill>> {
    return this.request("GET", "/v1/skills", undefined, { query });
  }
  getSkill(id: string): Promise<Skill> {
    return this.request("GET", `/v1/skills/${id}`);
  }
  deleteSkill(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/skills/${id}`);
  }
  archiveSkill(id: string): Promise<Skill> {
    return this.request("POST", `/v1/skills/${id}/archive`);
  }
  listSkillVersions(id: string): Promise<ListResult<SkillVersion>> {
    return this.request("GET", `/v1/skills/${id}/versions`);
  }
  async uploadSkillVersion(id: string, zip: Uint8Array, opts?: { idempotencyKey?: string }): Promise<SkillVersion> {
    const form = new FormData();
    form.append("file", new Blob([zip], { type: "application/zip" }), "skill.zip");
    return this.multipart(`/v1/skills/${id}/versions`, form, opts);
  }
  downloadSkillContent(id: string): Promise<Response> {
    return this.download(`/v1/skills/${id}/content`);
  }
  downloadSkillVersionContent(id: string, version: number): Promise<Response> {
    return this.download(`/v1/skills/${id}/versions/${version}/content`);
  }

  // ---- Deployments ----
  createDeployment(body: components["schemas"]["DeploymentCreate"], opts?: { idempotencyKey?: string }): Promise<Deployment> {
    return this.request("POST", "/v1/deployments", body, opts);
  }
  listDeployments(query?: Record<string, QueryValue>): Promise<ListResult<Deployment>> {
    return this.request("GET", "/v1/deployments", undefined, { query });
  }
  getDeployment(id: string): Promise<Deployment> {
    return this.request("GET", `/v1/deployments/${id}`);
  }
  archiveDeployment(id: string): Promise<Deployment> {
    return this.request("POST", `/v1/deployments/${id}/archive`);
  }
  pauseDeployment(id: string): Promise<Deployment> {
    return this.request("POST", `/v1/deployments/${id}/pause`);
  }
  unpauseDeployment(id: string): Promise<Deployment> {
    return this.request("POST", `/v1/deployments/${id}/unpause`);
  }
  runDeployment(id: string, input?: Record<string, unknown>, opts?: { idempotencyKey?: string }): Promise<DeploymentRun> {
    return this.request("POST", `/v1/deployments/${id}/runs`, input ?? {}, opts);
  }
  listDeploymentRuns(id: string, query?: Record<string, QueryValue>): Promise<ListResult<DeploymentRun>> {
    return this.request("GET", `/v1/deployments/${id}/runs`, undefined, { query });
  }
  listAllDeploymentRuns(query?: Record<string, QueryValue>): Promise<ListResult<DeploymentRun>> {
    return this.request("GET", "/v1/deployment_runs", undefined, { query });
  }

  // ---- Webhooks ----
  createWebhook(body: components["schemas"]["WebhookCreate"], opts?: { idempotencyKey?: string }): Promise<components["schemas"]["WebhookCreated"]> {
    return this.request("POST", "/v1/webhooks", body, opts);
  }
  listWebhooks(query?: Record<string, QueryValue>): Promise<ListResult<Webhook>> {
    return this.request("GET", "/v1/webhooks", undefined, { query });
  }
  getWebhook(id: string): Promise<Webhook> {
    return this.request("GET", `/v1/webhooks/${id}`);
  }
  deleteWebhook(id: string): Promise<{ id: string; type: string }> {
    return this.request("DELETE", `/v1/webhooks/${id}`);
  }
  listWebhookDeliveries(id: string, query?: Record<string, QueryValue>): Promise<ListResult<WebhookDelivery>> {
    return this.request("GET", `/v1/webhooks/${id}/deliveries`, undefined, { query });
  }
}

export function createMasClient(opts: MasClientOptions): MasClient {
  return new MasClient(opts);
}
