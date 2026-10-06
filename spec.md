# 企业私有化 Managed Agents 平台 — 后端架构规格（spec）

> 版本：v0.1（Draft）｜日期：2026-10-04
> 技术栈：TypeScript / Node.js 22 LTS ｜部署：Docker Compose（单机）→ 小集群（多 worker 节点）
> 依据：`managed-agents-调研报告.md`
> 子规格：`codex-app-server-adapter/spec.md`（CodexAppServerDriver，本文 §8）
> ADR-001（mosoo-agent-driver 仅作参考）：`codex-app-server-adapter/mosoo-agent-driver-技术预研报告.md`
> v0.3 修订（2026-10-05）：§7.3 事件排序对齐 Anthropic（排队事件直接进历史，`processed_at=null`；按 processed_at 排序；删除 `session_pending_inputs`、`include_pending`、`input_queued`）。
> v0.2 修订（2026-10-04）：吸收 OpenMA 的设计，依据 `open-managed-agents-调研报告.md` §4 的 T1–T12。涉及 §5.4–5.6、§6、§7、§8.4、§9、§10、§13、§14、§17、§19

---

## 1. 目标与原则

### 1.1 目标

1. 在企业内网用 Docker 部署一个**托管 Agent 运行平台**。业务方通过 HTTP API 创建 Agent、启动会话，平台在隔离沙箱中运行长时任务（分钟到小时级），通过 SSE 推送进度。
2. **不自研 harness**：沙箱内运行官方 `codex app-server`，平台只负责驱动和归一化。
3. **沙箱用开源方案**：OpenSandbox（首选）或 Docker + gVisor（兜底），放在 `SandboxProvider` 接口之后，可以替换。
4. **对外 API 兼容 Managed Agents 事实标准**（Anthropic `managed-agents-2026-04-01` 与智谱 BigModel `managed-agents-2026-05-26` 的公共子集），以降低接入和迁移成本。BigModel 验收用例（`test-case-plan.md`）可以直接用于验收本平台。
5. 凭据**不进入沙箱**；沙箱出网必须经过平台控制的代理。

### 1.2 核心原则

| 原则 | 含义 |
| --- | --- |
| 事件日志是唯一事实来源 | `session_events` 是追加式日志，会话状态由事件推导并物化；SSE 只是日志的实时视图 |
| 单写者 | 同一 session 在任一时刻只有一个 worker 持有租约（lease + epoch），只有它能写事件、驱动 runtime |
| 先持久化再执行 | 用户输入先写入数据库（command），再交给 runtime，崩溃后不会丢失 |
| 最小可信面 | 沙箱被视为不可信：无真实凭据，出网只经代理，root 也只在 gVisor 内 |
| 协议防漂移 | Codex 版本 pin 到镜像 digest，协议类型由生成脚本产出，golden transcript 作为升级门禁 |
| 可替换 | Runtime（Driver）、沙箱（Provider）、模型（Gateway）三处都通过接口隔离 |

---

## 2. 范围

### 2.1 MVP 范围

- 资源：Agent（版本化）、Environment、Session、Event、File、Vault/Credential（environment_variable、static_bearer）、Session Resource（file）。
- 事件：`user.message`、`user.interrupt`、`user.tool_confirmation`；`agent.message`、`agent.thinking`、`agent.tool_use`、`agent.tool_result`、`agent.mcp_tool_use`、`agent.mcp_tool_result`；`session.status_*`、`session.error`、`session.usage`、`session.updated`、`session.deleted`；`span.model_request_start|end`。
- SSE 实时流（可选 `event_deltas` 增量帧）、历史事件分页。
- 权限策略：`always_allow` / `always_ask`。
- 网络：`unrestricted` / `limited(allowed_hosts, allow_package_managers, allow_mcp_servers)`。
- 多租户：organization → workspace → API key。
- 单机 Docker Compose 部署；worker 可以水平扩展。

### 2.2 非目标（MVP 之后）

- `custom` 工具（需要 Codex dynamic tools，属实验性 API）→ M-next。
- Memory Store、Skills、Deployments（cron）、Webhooks、multiagent threads、outcomes → 第二阶段（§19 路线图）。
- `self_hosted` 环境（客户机器执行）。
- 内置 web_search（可以通过 MCP 提供）。
- 计费结算（只做计量）。

---

## 3. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言/运行时 | TypeScript 5.x（strict）、Node.js 22 LTS | ESM；`tsx` 开发，`tsup` 构建 |
| Monorepo | pnpm workspace + Turborepo | |
| HTTP | **Fastify 5** + `@fastify/type-provider-zod` | SSE 用原生 `reply.raw`，自行实现心跳 |
| Schema | **Zod** → OpenAPI 3.1（`zod-openapi`） | 同一份 schema 用于请求校验、响应序列化和文档 |
| 数据库 | **PostgreSQL 16** | 事件日志、资源、租约、outbox；`LISTEN/NOTIFY` 用于 SSE 扇出 |
| DB 访问 | **Kysely** + `pg` | 类型安全的 SQL；迁移用 `kysely-ctl` |
| 任务/调度 | 基于 PostgreSQL 的队列（`graphile-worker`） | 不引入额外中间件；Redis 为可选项（§13.4） |
| 对象存储 | **MinIO**（S3 API，`@aws-sdk/client-s3`） | 文件、会话输出、沙箱快照 |
| 沙箱 | **OpenSandbox**（Docker runtime + runsc），兜底方案为 Docker Engine API（`dockerode`）+ runsc | §9 |
| Harness | `@openai/codex@<pinned>` 的 `codex app-server` | §8 |
| 出网代理 | 自研 Node 代理（`http-proxy` + CONNECT 隧道）或 Envoy | §10 |
| 模型网关 | 自研轻量 Responses API 代理，可接 LiteLLM | §10.3 |
| 日志/指标/追踪 | pino（JSON）、OpenTelemetry SDK → Prometheus / Tempo | §16 |
| 测试 | Vitest、Testcontainers（PG/MinIO）、golden transcript 回放 | §17 |
| 密钥 | KMS 抽象：MVP 用环境变量主密钥 + AES-256-GCM 信封加密；可接 Vault/KMS | §10.1 |

---

## 4. 总体架构

```text
                         ┌──────────────────────────────────────────────────────────────┐
  Client / SDK ── HTTPS ─▶│ api  (Fastify, 无状态, ×N)                                    │
                         │  • 鉴权/限流/校验 → 资源 CRUD                                  │
                         │  • POST events → 写 commands + 输入事件（单事务）→ NOTIFY        │
                         │  • GET stream → LISTEN session:{id} → SSE                      │
                         └───────┬──────────────────────────────────────▲───────────────┘
                                 │ PostgreSQL（真相源）                  │ NOTIFY
                         ┌───────▼──────────────────────────────────────┴───────────────┐
                         │ session-worker  (×N, 有状态, 持租约)                           │
                         │  • 抢占会话租约 → SessionRunner                                 │
                         │  • SandboxProvider: create/resume/pause/destroy                │
                         │  • CodexAppServerDriver ⇄ stdio ⇄ codex app-server（沙箱内）   │
                         │  • 归一化事件 → append session_events（epoch 条件写）          │
                         └───────┬───────────────────────────────┬──────────────────────┘
                                 │ OpenSandbox API / Docker API   │
                         ┌───────▼────────────────────────┐      │
                         │ 沙箱容器（runsc, 每会话一个）    │      │
                         │  codex app-server              │──────┼──▶ egress-proxy ──▶ 允许的外部主机
                         │  /workspace  /mnt/session/*    │      │        (凭据注入)
                         │  CODEX_HOME=/session/.codex    │──────┴──▶ model-gateway ──▶ OpenAI / 内部模型
                         └────────────────────────────────┘
   scheduler (×1, leader 选举): 租约回收、空闲暂停/回收、超时、文件 TTL、outbox 投递
   MinIO: files / outputs / snapshots
```

### 4.1 服务边界

| 服务 | 职责 | 状态 | 扩展方式 |
| --- | --- | --- | --- |
| `api` | 对外 REST + SSE、鉴权、限流、校验、资源 CRUD、命令入队 | 无状态 | 水平扩展 |
| `session-worker` | 会话执行：租约、沙箱生命周期、驱动 Codex、写事件 | 内存中持有 runtime 句柄；持久状态在 PG | 水平扩展；单 worker 承载并发会话数可配置（默认 50） |
| `scheduler` | 定时任务：租约过期回收、空闲沙箱暂停/销毁、文件 TTL、outbox | 无状态（PG advisory lock 选主） | 1 活跃 + 备 |
| `egress-proxy` | 沙箱出网白名单、凭据占位符替换、审计 | 只读策略缓存 | 水平扩展 |
| `model-gateway` | 模型 API 代理：注入真实 key、按会话计量 token、限流、模型白名单 | 无状态 | 水平扩展 |

MVP 可以把 `api`、`scheduler`、`model-gateway` 合并为一个进程（`apps/server`，用启动参数选择角色），`session-worker` 单独部署（需要访问 Docker 或 OpenSandbox）。

---

## 5. 领域模型

ID 统一格式：`<prefix>_<ULID>`（26 位 Crockford base32，时间有序）。

| 资源 | 前缀 |
| --- | --- |
| Agent | `agent_` |
| Environment | `env_` |
| Session | `sesn_` |
| Event | `sevt_` |
| File | `file_` |
| Session Resource | `sesrsc_` |
| Vault | `vlt_` |
| Credential | `vcrd_` |
| Request | `req_` |

### 5.1 Agent（版本化）

```ts
interface Agent {
  id: string; type: "agent";
  name: string;                 // 1–256
  description: string | null;   // ≤2048
  model: { id: string; effort?: "low" | "medium" | "high" | "max"; speed?: "standard" };
  system: string | null;        // ≤100_000
  tools: ToolConfig[];          // ≤128
  mcp_servers: McpServer[];     // ≤20
  skills: [];                   // MVP 恒为 []
  metadata: Record<string, string>; // ≤16 键，键 ≤64，值 ≤512
  version: number;              // 从 1 开始
  created_at: string; updated_at: string; archived_at: string | null;
}
type ToolConfig =
  | { type: "agent_toolset_20260401" | "agent_toolset_20260601";   // 两个方言名均接受
      default_config?: { enabled?: boolean; permission_policy?: PermissionPolicy };
      configs?: { name: BuiltinToolName; enabled?: boolean; permission_policy?: PermissionPolicy }[] }
  | { type: "mcp_toolset"; mcp_server_name: string;
      default_config?: {...}; configs?: {...}[] };
type PermissionPolicy = { type: "always_allow" } | { type: "always_ask" };
type McpServer = { type: "url"; name: string; url: string };      // https://，≤2048
```

- 存储：`agents`（当前头部版本）+ `agent_versions`（不可变快照，主键为 `(agent_id, version)`）。
- 更新：`POST /v1/agents/{id}`，可带 `version` 做乐观锁（不匹配返回 409）。省略的字段保持不变；数组整体替换；`metadata` 按键合并；**配置规范化后与上一版本相同时不产生新版本**。
- 只能归档，不能删除。

### 5.2 Environment（不版本化）

```ts
interface Environment {
  id: string; type: "environment"; name: string; description: string | null;
  config: {
    type: "cloud";
    packages: { apt: string[]; npm: string[]; pip: string[]; cargo: string[]; gem: string[]; go: string[] };
    networking: { type: "unrestricted" }
              | { type: "limited"; allowed_hosts: string[]; allow_package_managers: boolean; allow_mcp_servers: boolean };
  };
  metadata: Record<string, string>;
  created_at: string; updated_at: string; archived_at: string | null;
}
```

- 内部扩展字段（不对外暴露，由管理员配置）：`image`（沙箱镜像 digest，默认 `codex-runtime@sha256:...`）、`resources`（cpu/mem/disk）、`idle_timeout`、`max_session_duration`。
- 会话创建时把 Environment **固化为快照**（`sessions.environment_snapshot`）；后续更新只影响新会话。
- packages 安装：首次使用某个 `(image, packages hash)` 组合时构建**派生镜像**（`docker build` 或 OpenSandbox template），按 hash 缓存，避免每个会话重复安装（对应 Anthropic 的"packages 跨会话缓存"）。

### 5.3 Session

```ts
interface Session {
  id: string; type: "session";
  status: "idle" | "running" | "rescheduling" | "terminated";
  stop_reason: null | { type: "end_turn" } | { type: "requires_action"; event_ids: string[] }
             | { type: "retries_exhausted" } | { type: "error"; error_type: string };
  agent: AgentSnapshot;          // 创建时固化（含 version）
  environment_id: string;
  title: string | null; metadata: Record<string, string>;
  resources: SessionResource[];
  vault_ids: string[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  stats: { active_seconds: number; duration_seconds: number };
  created_at: string; updated_at: string; archived_at: string | null;
}
```

内部字段（`sessions` 表）：`runtime_state`（`none|provisioning|ready|paused|destroyed`）、`sandbox_id`、`codex_thread_id`、`codex_version_digest`（§8.4）、`last_event_seq`、`last_completed_execution_id`（canonical 水位线，§14.2）、`active_workspace_checkpoint`（§9.4）、`active_output_manifest`（§5.5）、`needs_restart`。租约和 generation 不放在 sessions 表上，而是放在 `session_executions`（§5.6）。

### 5.4 Event

```ts
interface SessionEvent {
  id: string;                 // sevt_
  type: EventType;            // §12
  processed_at: string | null;
  // 以下为各类型字段（content / name / input / tool_use_id / stop_reason / error / usage ...）
  [k: string]: unknown;
}
```

存储表 `session_events`：

| 列 | 说明 |
| --- | --- |
| `seq` | bigint，**会话内单调**，可为空：排队中的用户输入为 NULL，定序时由持有 fence 的 worker 分配（§7.3）。内部列，不对外暴露 |
| `id` | 事件 ID |
| `type` | 事件类型 |
| `payload` | jsonb |
| `processed_at` | 处理时间。与 seq 同时写入，会话内单调且唯一；排队中为 NULL |
| `received_at` | api 接收时间（内部列，用于排队事件之间的排序） |
| `disposition` | 内部列：`normal` 或 `flushed`（被 interrupt 取消或 exhausted 时清空的排队输入，不交给模型） |
| `source_event_id` | 来自 driver 的确定性 ID，唯一约束 `(session_id, source_event_id)`，用于去重 |
| `generation` | 写入时的 execution generation（§7.1） |
| `created_at` | 创建时间 |

用户输入事件由 api 直接写入 `session_events`，此时 `seq` 和 `processed_at` 都为 NULL（排队中，在历史中可见）。worker 开始处理时为它定序：分配 seq，并写入会话内单调的 `processed_at`。这样对外的 processed_at 顺序等于"模型实际看到输入的顺序"（§7.3）。`seq` 是内部列，不出现在事件 JSON 中。

### 5.5 File 与 Session Resource

- `files`：org 级上传，或会话输出（`scope = {type:"session", id}`）。内容存储在 MinIO `files/{org}/{file_id}`。单文件 ≤500 MB（可配置），保留期可配置。
- Session Resource `{type:"file", file_id, mount_path}`：会话启动时或运行中（`POST /v1/sessions/{id}/resources`）拷贝到沙箱 `/mnt/session/uploads/<mount_path>`（只读）。
- 输出：沙箱内的 `/mnt/session/outputs/` 采用**不可变、内容寻址的 output manifest**（借鉴 OpenMA ADR 0005）：
  1. turn 结束时 worker 枚举目录，对每个文件计算 sha256，按 `outputs/{session}/{sha256}` 上传到 MinIO。已存在且**字节**一致的对象视为幂等重试，只比较大小不算一致。
  2. 生成 manifest `{session_id, turn_seq, generation, entries:[{path, sha256, size}]}`。**只有当前 generation** 能用 CAS 把 manifest 发布为 `sessions.active_output_manifest`。
  3. manifest 中每个条目登记为 session 范围的 File，身份为 `(session_id, path, sha256)`。重复收集不会产生重复 File。
  4. 枚举后文件仍在变化，或上传失败的条目，标记为 `incomplete`，不作为正式产物暴露；同时写一条 `session.error{type:"output_incomplete"}`。

### 5.6 Execution 与 Driver WAL

每个被接受的输入批次对应**唯一一条持久执行记录**（借鉴 OpenMA ADR 0006）。它取代 v0.1 的 `runtime_commands`：

```text
session_executions(
  id,                                -- exe_<ULID>
  workspace_id, session_id,
  lane_id,                           -- MVP 恒为 "main"；二期多线程时为 thread_id
  kind: user_message|interrupt|tool_confirmation,
  input_event_ids text[],            -- 对应 session_events 中排队的用户事件（§7.3）
  input_fingerprint,                 -- 批次内容的 sha256，用于幂等去重
  state: queued|claimed|delivered|completed|failed|cancelled,
  owner_id, attempt_id,              -- 每次 claim 生成新的 attempt_id
  generation bigint,                 -- 每次 claim 单调 +1（fencing token）
  attempt_count, max_attempts,       -- 默认 max_attempts = 5
  deadline_at,                       -- 总截止时间（默认 admitted_at + 6h）
  lease_expires_at,
  interrupt_requested_at,            -- 持久化的中断请求（§6）
  admitted_at, claimed_at, delivered_at, settled_at,
  failure jsonb, revision bigint
)
INDEX (state, lease_expires_at, admitted_at)            -- claim 扫描
INDEX (workspace_id, session_id, lane_id, admitted_at)  -- 同 lane FIFO
```

- **准入**：api 在**同一事务**中写入排队的用户事件（`session_events`，seq 为 NULL）和 `session_executions(queued)`，然后发 `NOTIFY session_exec`。同一 `(session_id, input_fingerprint, Idempotency-Key)` 重复提交时返回首次结果。
- **认领**：同一 `(session_id, lane_id)` 严格 FIFO，任何时刻最多一条处于 claimed 或 delivered 状态。不同 lane 可以并发（二期）。
- **流转**：`claimed` → `delivered`（已写入 Codex stdin）→ 收到对应终态事件后 `completed`。`settle`（写入终态）**之前必须再续约一次**，续约失败就禁止 settle。
- **毒任务**：`attempt_count ≥ max_attempts` 或超过 `deadline_at` 时，置为 `failed`，并写 `session.error{retry_status:"exhausted"}`，不再回收。
- 这张表是 driver 的 WAL。恢复时，处于 `delivered` 但没有终态的执行按 §14.2 处理，**不自动重发 `user.message`**，避免重复执行有副作用的操作。

#### 5.6.1 成本与副作用操作（op journal）

模型请求、带凭据的出站请求、MCP 写操作等"花钱或有外部副作用"的操作，记录到 `session_ops`（借鉴 OpenMA 的 recovery-and-idempotency 规则）：

```text
session_ops(op_id, session_id, execution_id, generation, kind, started_at, completed_at, result_ref, upstream_idempotency_key)
op_id = sha256(kind || canonical_args || execution_id || ordinal)
```

- 发起操作前写入 `started`，成功后写入 `completed`。
- 恢复时扫描"有 started 没有 completed"的记录：
  - 上游支持幂等键的（OpenAI `Idempotency-Key` 等），用 `op_id` 重试，由上游去重。
  - 不支持的，**不静默重放**。改为通过 `session.error{type:"op_outcome_unknown", op_id}` 或恢复提示告知用户和 agent："该操作可能已执行，请先核实"。
- MVP 覆盖两类：model-gateway 的模型请求（由 gateway 记录），以及 egress-proxy 中非 GET 的凭据请求（由 proxy 记录）。Codex 内部的 shell 命令无法逐条拦截，依靠 §14.2 的"不重放工具输入"原则。

---

## 6. Session 状态机

```text
                   create (无 initial_events)
   (none) ──────────────────────────────▶ idle(stop_reason=null)
      │ create(含 initial_events)            │ user.message
      ▼                                      ▼
   running ◀───────────────────────────── running ─────────────┐
      │  turn 完成                          │  审批请求          │ 瞬时错误(模型 5xx/沙箱丢失)
      ▼                                      ▼                    ▼
   idle(end_turn)        idle(requires_action, event_ids)   rescheduling ──(重试成功)──▶ running
                              │ user.tool_confirmation         │ 重试耗尽
                              ▼                                ▼
                           running                     idle(retries_exhausted)
   不可恢复错误（环境被删除/镜像不可用/策略违规）────────────────▶ terminated
```

- 状态转换只由持租约的 worker 写入，并通过事件表达：`session.status_running`、`session.status_idle{stop_reason}`、`session.status_rescheduled`、`session.status_terminated`。`sessions.status` 是物化视图，与事件写在同一事务中。
- `requires_action` 期间只接受 `user.tool_confirmation` 和 `user.interrupt`。发送 `user.message` 时整批返回 400（与 BigModel 行为一致）。
- `user.interrupt`：**中断是持久状态**。api 在接受 interrupt 的同一事务中，对当前 lane 的活跃 execution 写入 `interrupt_requested_at`，并取消该 lane 中仍处于 queued 的输入（对应的排队事件按 §7.3 标记为 flushed）。持租约的 worker 通过 NOTIFY 尽快感知；就算 NOTIFY 丢了，下一次续约时也会读到。之后执行 `turn/interrupt`，10 秒内未完成则硬取消（见子规格 §5.3）。如果 worker 在此期间崩溃，**接手的 worker 在 claim 时看到 `interrupt_requested_at`，就不再启动 turn**，直接收尾。未决审批按 deny 处理，最终状态为 `idle(end_turn)`，不发出 `session.error`。worker 内存中的 AbortController 只用来降低延迟，不是事实来源。
- 运行时资源状态（沙箱）与会话状态**解耦**：会话 idle 超过 `idle_pause_after`（默认 10 分钟）时暂停沙箱；超过 `idle_destroy_after`（默认 24 小时）时做快照并销毁。下一条消息到来时懒恢复（§14.2）。

---

## 7. 一致性与并发

### 7.1 单写者租约（execution 级 fencing）

租约挂在 `session_executions` 上，而不是 sessions 表上（借鉴 OpenMA ADR 0006）：

```sql
-- claim：取该 session/lane 最早的可执行记录（queued，或租约已过期）
UPDATE session_executions e
   SET state='claimed', owner_id=$worker, attempt_id=$attempt,
       generation=generation+1, attempt_count=attempt_count+1,
       claimed_at=now(), lease_expires_at=now()+'30s', revision=revision+1
 WHERE e.id = (
   SELECT id FROM session_executions
    WHERE session_id=$sid AND lane_id=$lane
      AND (state='queued' OR (state IN ('claimed','delivered') AND lease_expires_at < now()))
      AND attempt_count < max_attempts AND deadline_at > now()
    ORDER BY admitted_at, id LIMIT 1
    FOR UPDATE SKIP LOCKED)
RETURNING id, generation, attempt_id, interrupt_requested_at;
```

- **fence** = `(execution_id, generation, attempt_id)`。worker 每 10 秒续约一次，条件为 `generation=$g AND attempt_id=$a`，影响行数为 0 就视为失去租约。失去租约后立即中止 runtime：先 fence，再请求协作式取消，最后强杀沙箱进程。
- **写入守卫**：以下所有写入都带 fence 条件，旧 generation 的写入一律失败：
  - 事件 append（`session_events.generation`）
  - 用户输入定序（§7.3）
  - checkpoint 指针 CAS（§9.4）
  - output manifest 发布（§5.5）
  - 凭据出站授权（§10.4）
- **沙箱调用守卫**：`SessionRunner` 把 `SandboxProvider` 包在 `withExecutionGuard(fence)` 中。exec、putFiles、getFiles 等每个方法**调用前后**都检查本地 AbortSignal 和 `lease_expires_at`，读操作也不例外。fence 失效时，由守卫启动的进程收到 SIGTERM。
- **settle 前再续约一次**，然后在同一事务中写入终态事件并把 execution 置为 `completed`。
- 触发会话分派的情况：
  - 有 queued execution（来自 NOTIFY）。
  - scheduler 每 5 秒扫描一次 `(state, lease_expires_at)` 索引，找出租约过期的记录。
  - worker 启动时全量扫描。
- 恢复语义是 **at-least-once 执行、at-most-once canonical 提交**。外部副作用由 §5.6.1 的 op journal 处理。

### 7.1.1 Session 运行锁

同一 session 在任一时刻只允许一个沙箱 / Codex 进程，以保证 `CODEX_HOME` 只有一个写者。用 `session_runtime_locks(session_id PK, holder_execution_id, generation)` 加 CAS 实现：claim 成功后在同一事务中获取，settle 或失去租约时释放。MVP 只有单 lane，这把锁与 execution 租约一一对应；二期多 lane 时，由它串行化沙箱的独占操作。

### 7.2 Transactional outbox

- 写事件的同一事务内插入 `outbox(topic, payload)`。投递方式：MVP 为事务提交后 `pg_notify('session:'||id, seq)`，投递失败无影响，因为 SSE 消费者按 seq 回补。Webhook（二期）由 scheduler 轮询 outbox 投递，保证至少一次。

### 7.3 Event ordering（对齐 Anthropic：processed_at 排序 + 处理时定序）

**不变量**：任何被接受的用户输入，在对外顺序上必须**严格位于**模型处理它之前已发出的所有 agent 事件**之后**，并且**严格位于**因它而产生的所有 agent 事件**之前**。v0.1 让 api 在写入时分配 seq，这是到达顺序，违反了这条不变量。OpenMA 的 `ORDERING_DESIGN.md` 记录了同样的缺陷。

**Anthropic 的做法**（2026-10-05 核对官方文档）：

| 要点 | Anthropic 原文要点 | 出处 |
| --- | --- | --- |
| 排队语义 | 发出的事件在排到之前 `processed_at` 为 null（"null while the event is still queued behind earlier events"）；`user.custom_tool_result`、`user.tool_result`、`user.define_outcome` 收到即处理，返回时 `processed_at` 已有值 | events-and-streaming |
| 排队事件可见 | 每个持久化事件都带 `processed_at`；Send Events 返回已持久化的事件（带 `id`） | events-and-streaming、Send Events API |
| 历史排序键 | `GET /events` 的 `order` 是"ordered by the event's `processed_at`"，默认 asc | List Events API |
| 时间过滤 | `created_at[gt\|gte\|lt\|lte]`"Compared against the event's `processed_at` value" | List Events API |
| 不暴露 seq | 事件对象中没有序号字段，只有 `id` 和 `processed_at` | 事件 schema |
| 重连 | 开新流 → 列出全量历史建立 seen-id 集合 → 跳过已见 id | events-and-streaming |
| 失败清空 | `retry_status: exhausted` 时"queued inputs are flushed and the session returns to idle" | 事件 schema |
| 未写明 | 排队事件在历史列表里排在哪里；用户事件在流上何时出现；被 flush 的输入是否保留在历史中 | — |

BigModel 的做法与 Anthropic 一致："排队中的 user.message / user.interrupt 在历史接口中可能尚无该字段（processed_at）；公共 SSE 会等平台接手后再推送，并携带 processed_at"。

**本平台的设计**：只用 `session_events` 一张表，**处理时才定序**。

1. **接收**：api 校验通过后，在同一事务中执行：
   - 把用户事件**直接写入** `session_events`，`seq = NULL`、`processed_at = NULL`，事件 ID（`sevt_`）此时就分配。
   - 写入 `session_executions`（§5.6）。
   - 响应返回已持久化的事件，`processed_at = null`。
   - 例外：Anthropic 规定收到即处理的类型（MVP 中只有 `user.custom_tool_result`，属于二期），api 当场定序。
2. **定序**：worker claim 到 execution、即将把输入写入 Codex stdin 时，在带 fence 的事务中执行：
   - `seq = last_event_seq + 1`。
   - `processed_at = GREATEST(clock_timestamp(), last_processed_at + 1µs)`，保证**会话内单调且唯一**。
   - 然后才写 stdin。
   - agent 事件、状态事件**在写入时**就按同一规则得到 seq 和 processed_at。
   - 因此 **processed_at 顺序 = seq 顺序 = 模型实际看到的顺序**。
3. **清空与取消**：interrupt 取消的、或 `retry_status: exhausted` 时被 flush 的排队输入，在清空的那一刻定序，盖上 `processed_at`，并标记内部列 `disposition = 'flushed'`。这些输入**不会交给模型**。随后照常写 `session.status_idle`，会话回到 idle。
   - Anthropic 没有规定被 flush 的输入是否留在历史中。本平台选择**保留**：历史不丢数据，并且排在 idle 之前，位置合理。
   - 对外的事件 schema 保持 Anthropic 原样，**不增加字段**。内部可以通过 `GET /internal/sessions/{id}/debug` 查看 disposition。
4. **seq 只由持有 fence 的 worker 分配**。例外：没有活跃 execution 时，`session.updated`、`session.deleted` 等由 api 产生的事件，由 api 在 session 行锁内定序；此时不存在并发的 worker 写入。seq 是**内部列，不出现在事件 JSON 中**。
5. **对外**：
   - **`GET events`**：
     - 排序：`ORDER BY seq NULLS LAST, received_at, id`。`order=desc` 时反向，排队事件排在最前。因为 seq 与 processed_at 同序，这就等价于 Anthropic 的"按 `processed_at` 排序"，并且在末尾明确给出 `processed_at = null` 的排队事件。
     - 默认包含排队事件，没有额外参数，与 Anthropic、BigModel 一致。
     - `created_at[...]` 过滤比较的是 processed_at，因此排队事件自然被过滤掉，与官方语义一致。
   - **SSE**：用户事件在**定序时**推送，带 `processed_at`，与 BigModel 一致，也满足 Anthropic"user.interrupt appears on the stream"的描述。接收时**不推送**任何额外帧（v0.2 的 `input_queued` 帧已删除），避免官方 SDK 遇到未知事件类型。客户端从 POST 的响应中得知事件已排队。
   - 按官方建议做重连（新流 + 全量历史 + id 去重）完全可行。`Last-Event-ID`（值为内部 seq）是本平台的扩展（§11.5）。
6. 一条 SSE 连接内事件按 seq 递增推送。

v0.2 曾使用单独的 `session_pending_inputs` 表，默认在历史中隐藏排队输入，并推送 `input_queued` 帧。这些做法与 Anthropic、BigModel 都不一致，已在 v0.3 删除。

---

## 8. Codex Runtime Driver

### 8.1 抽象

```ts
interface AgentRuntimeDriver {
  readonly kind: "codex_app_server";
  probe(input: RuntimeProbeInput): Promise<RuntimeCapabilities>;
  start(input: RuntimeStartInput): Promise<RuntimeHandle>;
  send(handle: RuntimeHandle, command: RuntimeCommand): Promise<RuntimeAck>;
  events(handle: RuntimeHandle, cursor?: string): AsyncIterable<NormalizedRuntimeEvent>;
  inspect(handle: RuntimeHandle): Promise<RuntimeState>;
  stop(handle: RuntimeHandle, reason: string): Promise<void>;
}
```

完整类型、状态机、协议映射、背压和恢复规则见 **`codex-app-server-adapter/spec.md`**。本节只规定平台侧的约定：

- `SessionRunner`（worker 内，每会话一个）把 claim 到的 `session_executions` 转成 `RuntimeCommand`（转换前先按 §7.3 提升 pending 输入），再把 `NormalizedRuntimeEvent` 映射为对外事件（§12），然后带 fence 做 append。
- 映射关系：一个 Session 对应一个 Codex thread；一次"从 `user.message` 到 `idle`"对应一个 Codex turn；Codex 审批类 server request 对应 `agent.tool_use(evaluated_permission=ask)` + `session.status_idle(requires_action)`。

### 8.2 启动与能力探测

1. `SandboxProvider.create/resume` 得到 `SandboxHandle`。
2. `driver.probe`：校验镜像 digest 和 `codex --version`，确认能力（`turn/interrupt`、`thread/resume`、`inject_items`、三类审批）。结果缓存到 `runtime_instances` 表。
3. 生成 `CODEX_HOME/config.toml`：
   - `model_provider` 指向 `model-gateway` 的会话专用 URL（例如 `http://model-gateway:8080/v1/s/{session_token}`），token 为短期 JWT（sub=session，exp=租约周期×N）。
   - MCP servers 改写为经过 egress-proxy 的 URL。
   - `[features]` 只启用 allowlist 中的项。
   - 发现 `auth.json` 时 fail closed。
4. `driver.start`：`thread/start`，有 `codex_thread_id` 时改为 `thread/resume`。
5. Agent 配置映射：

| Managed Agents 字段 | Codex |
| --- | --- |
| `system` | `developerInstructions` |
| `model.id` / `effort` | `model` / `reasoningEffort` |
| 内置工具 enabled=false | config 中禁用对应 feature（shell / apply_patch / view_image）；无法禁用的在 probe 中报 `unsupported_tool_config` |
| `permission_policy` | `approvalPolicy`：所有工具 always_allow → `never`；存在 always_ask → `untrusted`，由平台 ApprovalBroker 按工具粒度裁决 |
| sandbox | `sandboxPolicy = dangerFullAccess`（外层 gVisor 是安全边界；若 spike 证明 `workspaceWrite` 在 runsc 下可用，可以切换） |
| `mcp_servers` + `mcp_toolset` | config.toml 中的 `[mcp_servers.<name>]`（streamable HTTP via proxy） |

### 8.3 mosoo-agent-driver 采用策略

- 依据 ADR-001，采用 **Reference-only**：不依赖 npm 包（未发布），不实现 mosoo ORPC 协议。
- 允许按 Apache-2.0 移植少量代码片段（帧解析、进程树清理），要求附 NOTICE 并记录来源 commit。
- 撤回条件：如果上游发布稳定版（≥1.0、有 npm 包、协议冻结），且提供与平台无关的 host 接口，再重新评估。自研 adapter 必须做到两周内可替换（接口不变）。

### 8.4 协议治理

- Codex 版本 pin 在镜像中（`codex-runtime:<codex-ver>-<build>@sha256`）。`scripts/sync-codex-protocol.mjs` 用相同版本运行 `codex app-server generate-ts|generate-json-schema`，按 allowlist 过滤后提交，CI 中执行 `--check`。
- 升级流程：bump 版本 → 重新生成 → 全量 golden transcript 回放 → live smoke（gVisor）→ 灰度：新会话按比例使用新镜像。
- **版本按 Session 固定**（借鉴 OpenMA harness release 设计）：
  - 会话首次启动沙箱时，把解析得到的 `{image_digest, codex_version}` 写入 `sessions.codex_version_digest`，同时写入 `/session/.mas/runtime.json`，随 workspace 快照一起迁移。
  - 之后每次恢复都使用**同一个 digest**，不再按 worker 标签解析。原生 rollout 的格式与 Codex 版本绑定，换版本做 `thread/resume` 有风险。
  - 原 digest 被下线（例如漏洞召回）时，该会话下次恢复强制走 Level 0 语义恢复（§14.2），并写 `session.error{type:"runtime_upgraded", retry_status:"retrying"}` 告知用户。
  - worker 需要同时支持多个 digest，镜像按需拉取。灰度粒度由"worker"改为"会话"。

---

## 9. SandboxProvider

```ts
interface SandboxProvider {
  readonly kind: "opensandbox" | "docker";
  capabilities(): Promise<SandboxCapabilities>;           // §9.0，启动前做能力协商
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  resume(ref: SandboxRef): Promise<SandboxHandle>;        // paused → running；snapshot → 重建
  pause(h: SandboxHandle): Promise<SandboxRef>;
  snapshot(h: SandboxHandle): Promise<SnapshotRef>;       // 文件系统级（/session 卷）
  destroy(h: SandboxHandle): Promise<void>;
  exec(h: SandboxHandle, cmd: ExecSpec): Promise<ExecProcess>; // 交互式：stdin/stdout/stderr 流 + exit
  putFiles(h: SandboxHandle, files: FilePut[]): Promise<void>;
  getFiles(h: SandboxHandle, glob: string): AsyncIterable<FileGet>;
  stats(h: SandboxHandle): Promise<SandboxStats>;
}
interface SandboxSpec {
  sessionId: string; tenantId: string;
  image: string;                         // digest
  resources: { cpus: number; memoryMiB: number; diskGiB: number; pids: number };
  env: Record<string, string>;           // 仅 allowlist，含占位符凭据
  network: { egressProxy: string; modelGateway: string };  // 沙箱只能访问这两个地址
  volumes: { session: string };          // 每会话一个 volume，挂载到 /session
  labels: Record<string, string>;
}
```

### 9.0 能力协商（禁止静默降级）

借鉴 OpenMA ADR 0005 的设计。provider 声明的是**语义能力**，平台不按 provider 名称写分支逻辑：

```ts
interface SandboxCapabilities {
  isolation: "gvisor" | "microvm" | "runc";               // 实际生效的隔离等级（由 probe 验证，不信任配置）
  lifecycle: { pause: boolean; hardTerminate: "supported" | "best_effort" };
  workspace: ("checkpoint_restore" | "retained_runtime" | "durable_mount" | "ephemeral")[];
  outputs: ("final_collect" | "durable_mount")[];
  interactiveStdio: boolean;                              // codex app-server 必需
  egress: "enforced" | "advisory" | "unsupported";        // §10.4
}
```

- **需求声明**：平台默认需求是 `isolation ∈ {gvisor, microvm}`、`workspace ∋ checkpoint_restore`、`interactiveStdio`、`egress=enforced`（会话挂载了 vault 时）。管理员可以按 Environment 的内部字段放宽，例如在 CI 中允许 `runc`。
- **协商时机**：worker 启动时协商一次（provider 级），每个会话 create/resume 前再按会话需求检查一次。**不满足就 fail closed**：会话进入 `terminated`，写 `session.error{type:"capability_unsatisfied", details}`。**禁止静默降级**，例如把持久化退化为 ephemeral，或把 gVisor 退化为 runc。
- `retained_runtime`（暂停后保留）**不等于持久化**。只有同时具备 `checkpoint_restore` 时，才能宣称会话可以跨宿主恢复。
- `isolation` 由 probe 实测：在沙箱内读取 `dmesg` 或 `/proc/version` 中的 gVisor 标识，与声明不一致时按不满足处理。

### 9.1 实现

**OpenSandboxProvider（首选）**

- 使用 OpenSandbox server 的 lifecycle API 创建沙箱，宿主 Docker 配置 runsc 为默认 runtime 或使用 `--runtime=runsc`。exec 走 execd，需要在 M0 验证 execd 是否支持长连接的交互式 stdin/stdout。
- 网络使用 OpenSandbox egress 策略：只放行 egress-proxy 和 model-gateway；真实的白名单在 egress-proxy 中执行（两层防护）。
- 如果 execd 不满足交互式 stdio 的要求，在沙箱内运行一个**轻量 stdio-bridge**（WebSocket ↔ codex app-server stdio，对应 mosoo 的"driver 外连"思路），由 worker 连接。

**DockerProvider（兜底，也用于 CI）**

- `dockerode`：`createContainer({HostConfig:{Runtime:"runsc", NetworkMode:"sandbox-net", ReadonlyRootfs:false, CapDrop:["ALL"], PidsLimit, Memory, NanoCpus, StorageOpt}})`。
- `sandbox-net` 是一个 internal 网络（无默认网关），只与 egress-proxy 和 model-gateway 互通。
- 交互式 exec：`container.exec({AttachStdin:true, AttachStdout:true, AttachStderr:true, Tty:false})`，并做 stdout/stderr demux。
- pause：`docker pause`（cgroup freeze）；snapshot：按 §9.4 的提交协议把 /session 卷打包上传；resume from snapshot：新建容器，恢复 active checkpoint 指向的卷内容。
- 必须显式设置隔离参数：`Runtime:"runsc"`、`CapDrop:["ALL"]`、`SecurityOpt:["no-new-privileges"]`、资源限制、internal 网络。OpenMA 的 Docker 参考实现没有设置这些，**不能照搬**。

### 9.2 沙箱目录约定（与 BigModel/Anthropic 对齐）

| 路径 | 说明 |
| --- | --- |
| `/workspace` | 工作目录（Codex `cwd`），实际是 `/session/workspace` 的软链 |
| `/mnt/session/uploads` | Session File Resource，只读 |
| `/mnt/session/outputs` | 产出目录，turn 结束时同步为 File |
| `/session/.codex` | `CODEX_HOME`（rollout、sqlite），持久化以支持 `thread/resume` |
| 运行用户 | root（只在 gVisor 用户态内核内） |

### 9.3 生命周期

```text
none ─create─▶ provisioning ─probe ok─▶ ready ─idle_pause_after─▶ paused ─idle_destroy_after─▶ snapshotted(destroyed)
                   │ fail → session.error(retry) / rescheduling          ▲ resume(消息到达)      │ resume = 重建+恢复卷
                   ▼                                                     └────────────────────┘
               failed
```

- 冷启动目标：P50 < 5 秒（预构建镜像 + 派生镜像缓存）。**warm pool**（按 Environment 预建 N 个空沙箱）放在二期。
- 无法确认已销毁的沙箱（强杀失败、宿主失联）记入 `sandbox_orphans(sandbox_ref, session_id, generation, reason, attempts, last_error)`，由 scheduler 定期 reconcile 直到 provider 确认已退出。orphan 记录中**不保存 fence token**，所以 reaper 只能销毁沙箱，不能发布状态。

### 9.4 Workspace checkpoint 提交协议

借鉴 OpenMA ADR 0005。快照必须是"完整、已校验、由当前 generation 发布"的，才能成为恢复源：

1. **静默**：每轮结束、execution settle 之前进行。Codex 此时处于空闲状态；需要的话可以执行 `docker pause` 冻结写入。
2. **写不可变候选**：把 `/session` 打包为 tar.zst，上传到 `mas-snapshots/{session}/{checkpoint_id}.tar.zst`。checkpoint_id 是 ULID，**永不覆盖**已有对象。
3. **生成并校验 manifest**：`{checkpoint_id, session_id, generation, execution_id, completed_execution_watermark, archive_sha256, size, format:"tar.zst/v1", codex_version_digest, created_at}`。上传完成后重新读取，校验 sha256。
4. **CAS 发布**：`UPDATE sessions SET active_workspace_checkpoint=$manifest WHERE id=$sid AND <当前 execution 的 fence 仍然有效>`。fence 失效时发布失败，候选作废。
5. **GC**：被替换的候选异步删除，保留最近 N=3 个以便回退。

失败语义：

| 情况 | 处理 |
| --- | --- |
| 上传中途崩溃 | 候选没有被 CAS 发布，不生效；GC 回收 |
| 上传完成但 CAS 之前崩溃 | 接手的 worker 用相同 checkpoint_id 重试 CAS；fence 已变时候选作废 |
| 恢复时校验失败（hash 不符、解包失败） | 回退到上一个有效 checkpoint，并写 `session.error{type:"checkpoint_corrupt"}` |
| checkpoint 落后于事件日志（水位线不一致） | 不做原生 resume，按 §14.2 走 Level 0 |

checkpoint 只包含**文件系统**，不包含进程内存。后台进程丢失是可以接受的，与 Claude Code cloud、OpenMA 一致。

---

## 10. 凭据与网络

### 10.1 凭据模型

- Vault（`display_name`、`metadata`）→ Credential：

| 类型 | 身份键 | 机密字段 |
| --- | --- | --- |
| `environment_variable` | `secret_name` | `secret_value`、`networking`（unrestricted 或 limited+allowed_hosts）、`injection`（header 名，默认 `Authorization: Bearer`） |
| `static_bearer` | `mcp_server_url` | `token` |
| `mcp_oauth`（二期） | `mcp_server_url` | `access_token`、`refresh{...}` |

- 存储：机密字段用信封加密（数据密钥 AES-256-GCM，主密钥来自 KMS 或环境变量）。**API 永不回显机密**，只返回 `***` 加末 4 位。
- 注入：
  - `environment_variable`：沙箱 env 中写入占位符 `mas_ph_<random>`。egress-proxy 在请求的目标 host 命中该凭据的 networking 时，把 header 或 query 中出现的占位符替换为真实值；未命中则原样转发（只会泄露占位符）。HTTPS 需要代理做 TLS 终止：沙箱镜像预置企业 CA，代理按 SNI 签发证书。
  - `static_bearer`：worker 生成 Codex MCP 配置时，URL 指向 egress-proxy 的 MCP 反向代理入口 `http://egress-proxy/mcp/{session}/{name}`，由代理附加 `Authorization`。
- 解析时机：会话创建时校验 `vault_ids` 存在、属于本 org 且未归档；每次请求实时解析（支持轮换，无需重启会话）。

### 10.2 Egress policy

- 来源：Environment 快照中的 `networking`，加上 Credential 的 networking，加上平台默认项（model-gateway、内部包镜像源）。
- `unrestricted`：放行 80/443 端口，但拦截平台黑名单（元数据服务 169.254.169.254、内网 CIDR、控制面地址）。
- `limited`：只放行 `allowed_hosts`（支持 `*.` 通配）；`allow_package_managers=true` 时追加包源（可指向企业内部镜像源 Nexus/Artifactory）；`allow_mcp_servers=true` 时追加 Agent 中声明的 MCP host。
- 被拒请求返回 403 + `x-mas-denied-host`，并写一条 `session.error{type:"egress_denied"}`（同一 host 每分钟最多记录一次）。
- 审计：每条出站请求记录 `(session, host, method, status, bytes)`，不记录 body。
- 身份识别：使用 proxy-authorization 中的**出站授权 token**（§10.4，在 HTTP_PROXY URL 中携带）。沙箱来源 IP 只用作辅助校验，必须与 token 绑定的沙箱一致，不能单独作为身份依据。

### 10.4 凭据出站授权（CredentialEgress）

借鉴 OpenMA ADR 0007。它刻意规避了 OpenMA 遗留 `oma-vault` 的几个缺陷：按 hostname 匹配第一个凭据、默认 `OMA_TENANT=*`、查询出错时回退到直连。

**授权范围**：每个出站授权绑定 `(workspace_id, session_id, execution_id, generation, sandbox_id)`，只覆盖该会话 `vault_ids` 中的凭据和凭据声明的 host。

```ts
interface CredentialEgress {
  capabilities(): Promise<{ level: "enforced" | "advisory" | "unsupported" }>;
  prepare(scope, fence): Promise<EgressBinding>;      // 签发短期出站 token（JWT，exp ≤ 租约周期×2），不含任何凭据
  attach(binding, sandbox): Promise<void>;            // 写入沙箱 HTTP(S)_PROXY 与 CA，并验证直连已被阻断
  revoke(binding, reason): Promise<void>;             // execution 结束、失去租约、取消时调用
}
```

**生命周期顺序**：claim → prepare → create/resume 沙箱（网络策略在创建时生效）→ attach 并验证 → 启动 Codex → 结束或失去租约时 revoke → pause/destroy。

**每个请求的校验**（egress-proxy）：

1. 验证出站 token 的签名和有效期。
2. 校验 token 中的 `(execution_id, generation)` 仍是该会话的当前 fence。可以缓存，但 TTL 必须小于 5 秒并短于租约。**旧 generation 的请求立即被拒绝**，不需要等沙箱被杀。
3. 先用 workspace 和会话的 `vault_ids` 缩小候选凭据范围，再按 host 匹配。因此跨租户、跨会话的同 host 凭据**不可能**被误用。
4. 匹配到凭据时：**剥离**沙箱自带的 `Authorization`、`x-api-key` 等竞争凭据头，替换占位符或注入凭据后转发。
5. 凭据查询出错时**拒绝**请求，不会无凭据放行，也不会直连。
6. 没匹配到凭据，不代表可以访问任意地址。是否允许匿名访问，由 §10.2 的公共出网策略单独决定。

**数据面分类**（分开处理）：

| 类别 | 处理 |
| --- | --- |
| Vault 目标 host | 注入凭据 |
| model-gateway / 控制面 | 白名单放行，不解析 Vault |
| 公共包源 | 按策略匿名放行 |
| 其他目标与非 HTTP 协议 | 在 `required` 模式下拒绝 |

**强制等级**：

| Provider 配置 | 等级 |
| --- | --- |
| DockerProvider / OpenSandbox：internal 网络 + 双网卡 egress-proxy，沙箱没有其他路由 | `enforced` |
| 只设置了 `HTTP_PROXY` 环境变量 | `advisory` |

会话挂载了 vault 时要求 `enforced`，否则按 §9.0 fail closed。`advisory` 只允许用于本地调试。

**日志**：只记录 binding_id、scope 哈希、host、决策、状态码、generation、耗时。**永不记录** token 值、上游请求头或请求体。

### 10.3 Model gateway

- 对 Codex 暴露 OpenAI **Responses API** 兼容端点（`/v1/responses`，支持流式），按会话 token 鉴权后转发到上游，并注入真实 API key。
- 上游可以配置为：OpenAI、Azure OpenAI，或企业内部模型网关（必须兼容 Responses API；只有 Chat Completions 时需要转换层，§19 Q3）。
- 计量：从流式响应的 `usage` 累加，写 `span.model_request_start/end` 和 `session.usage` 事件（由 gateway 回调 worker，或写入 `model_usage` 表后由 worker 合并）。
- 模型白名单：Agent 的 `model.id` 必须在 org 允许列表中，否则创建或更新时返回 400。

---

## 11. 外部 API

### 11.1 通用约定

| 项 | 规定 |
| --- | --- |
| Base | `https://<host>/v1` |
| 鉴权 | `Authorization: Bearer <api_key>`，同时兼容 `x-api-key`。API key 存储为 argon2/sha256 哈希，形如 `mas_sk_<id>_<secret>` |
| 版本 header | `mas-version: 2026-10-01`（缺省时取最新）。兼容方言：同时接受 `anthropic-version`/`anthropic-beta` 与 `zai-version`/`zai-beta`，并按方言调整工具集名称、错误细节等（§12.3） |
| 内容 | 请求为 `application/json`，文件上传用 `multipart/form-data` |
| 时间 | RFC 3339 UTC |
| 更新 | 一律使用 `POST /{resource}/{id}` |
| 分页 | `limit`（默认 20，最大 100）、`page`（不透明游标，base64url 编码的 `{seq|id, dir}`）、`order=asc|desc`，响应 `{data:[], next_page:string|null}` |
| 幂等 | 所有 POST 支持 `Idempotency-Key`（24 小时内同 key、同 body 返回首次响应；同 key、不同 body 返回 409 `idempotency_conflict`）。这一点**超出** Anthropic/BigModel 的能力 |
| 错误 | `{type:"error", error:{type, message, details?}, request_id}` |
| 限流 | 按 org 分读/写两个令牌桶：读 burst 100 / 每秒 50，写 burst 20 / 每秒 10；`POST events` 单独一个桶 100/50。返回 `ratelimit-*` 与 `retry-after` |
| 请求 ID | 响应头 `request-id: req_...` |

错误类型映射：

| HTTP | error.type |
| --- | --- |
| 400/422 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 404 | `not_found_error`（不存在与无权限都返回 404） |
| 409 | `conflict_error`（BigModel 方言下返回 `invalid_request_error`） |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `api_error` |
| 503/529 | `overloaded_error` |

### 11.2 Agent API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/agents` | 创建，返回 201 |
| GET | `/v1/agents` | 列表；`include_archived`、`created_at[gte\|lte]` |
| GET | `/v1/agents/{id}` | 获取当前版本；`?version=n` 获取历史版本 |
| POST | `/v1/agents/{id}` | 更新（乐观锁、无变化不升版本） |
| GET | `/v1/agents/{id}/versions` | 版本列表 |
| POST | `/v1/agents/{id}/archive` | 归档（幂等） |

### 11.3 Environment API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/environments` | 创建，返回 200（与 BigModel 一致）；按方言可返回 201 |
| GET | `/v1/environments` | 列表 |
| GET | `/v1/environments/{id}` | 获取 |
| POST | `/v1/environments/{id}` | 更新：config 整体替换；已归档时返回 400 |
| POST | `/v1/environments/{id}/archive` | 归档 |
| DELETE | `/v1/environments/{id}` | 删除；仍被非终态会话引用时返回 409 |

### 11.4 Session API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/sessions` | `agent`（string \| `{type:"agent",id,version}` \| `{type:"agent_with_overrides",...}`）、`environment_id`、`title`、`metadata`、`resources`、`vault_ids`、`initial_events`（≤50 条 user.message） |
| GET | `/v1/sessions` | `agent_id`、`agent_version`、`statuses[]`、`created_at[...]`、`include_archived` |
| GET | `/v1/sessions/{id}` | 获取 |
| POST | `/v1/sessions/{id}` | 更新：`title`、`metadata`；`agent.tools`/`agent.mcp_servers` 只能在 idle 时修改（否则 409），修改后的配置在下一个 turn 生效（driver 重建 thread 配置，参见子规格 resume 路径） |
| POST | `/v1/sessions/{id}/archive` | running 时 409；重复归档 409 |
| DELETE | `/v1/sessions/{id}` | running 时 409；删除事件、输出文件和沙箱快照；返回 `{id, type:"session_deleted"}` |
| POST | `/v1/sessions/{id}/events` | `{events:[1..10]}`，整批原子校验，返回 `{data:[已持久化的事件]}`。事件 ID 已经分配；用户输入此时 `processed_at=null`，表示排队中（§7.3，与 Anthropic 一致） |
| GET | `/v1/sessions/{id}/events` | 历史；`types[]`、`created_at[...]`、`limit`（默认 100）、`order`（默认 asc）、`page`；排序语义与 Anthropic 一致（按 processed_at，排队事件 `processed_at=null` 排在末尾，见 §7.3）；额外支持 `after_seq`（扩展） |
| GET | `/v1/sessions/{id}/events/stream` | SSE |
| POST | `/v1/sessions/{id}/resources` | 运行中挂载文件 |
| GET | `/v1/sessions/{id}/resources` | 列出资源 |
| GET | `/v1/sessions/{id}/resources/{rid}` | 获取资源 |
| DELETE | `/v1/sessions/{id}/resources/{rid}` | 卸载资源 |

Files：`POST /v1/files`、`GET /v1/files?scope_id=`、`GET /v1/files/{id}`、`GET /v1/files/{id}/content`、`DELETE /v1/files/{id}`。
Vaults：`/v1/vaults[/{id}[/archive]]`、`/v1/vaults/{id}/credentials[/{cid}[/archive]]`。

### 11.5 SSE

- `GET /v1/sessions/{id}/events/stream`，`Accept: text/event-stream`。
- 帧格式：`id: <seq>`、`event: <type>`、`data: <event json>`。每 15 秒发一次心跳 `: ping`。
- **默认只推实时事件**（与 Anthropic/BigModel 一致）。用户事件在**定序时**推送，带 `processed_at`；接收时不推送任何帧（§7.3）。`id:` 行的值是内部 seq，只用作 `Last-Event-ID` 游标。**扩展**：支持 `Last-Event-ID` 头或 `?after_seq=`，服务端先从 PG 回补 `seq > n` 的事件，再切换到实时推送（先 LISTEN，再查询，再按 seq 去重，避免空窗）。这样客户端不需要自己实现"拉历史 + 去重"。
- `event_deltas[]=agent.message|agent.thinking`：推送 `event_start{event:{id,type}}` / `event_delta{event_id, delta}` 帧（不持久化、没有 seq），最后推送完整事件。增量数据来自 Codex 的 `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`，worker 通过 `pg_notify('session_delta:'||id)` 直接扇出（≤8 KB/帧，超过则分片）。
- 会话被删除时推送 `session.deleted` 后关闭连接。
- 单会话最多 20 条 SSE 连接，单 org 最多 1000 条；超限返回 429。
- 背压：客户端读取慢、缓冲超过 4 MB 时断开连接，客户端用 `Last-Event-ID` 续传。

---

## 12. 事件分类

### 12.1 对外事件（平台 → 客户端）与 Codex 来源

| 对外事件 | Codex 来源 | 说明 |
| --- | --- | --- |
| `session.status_running` | `turn/started` | |
| `session.status_idle{stop_reason:end_turn}` | `turn/completed`（completed 或 interrupted） | |
| `session.status_idle{requires_action, event_ids}` | `item/*/requestApproval` | event_ids 指向对应的 `agent.tool_use` |
| `session.status_rescheduled` | 模型 5xx 或可重试错误、沙箱丢失后重建 | |
| `session.status_terminated` | 不可恢复错误 | |
| `agent.message{content:[{type:text,text}]}` | `item/completed(agentMessage)` | |
| `agent.thinking` | `item/started(reasoning)` | 只作为进度信号；可以选择附带 summary（`include_reasoning_summary`） |
| `agent.tool_use{name, input, evaluated_permission}` | `item/started(commandExecution\|fileChange\|webSearch...)` | name 映射：commandExecution→`bash`，fileChange→`edit`/`write`，其他使用原生名 |
| `agent.tool_result{tool_use_id, content, is_error}` | `item/completed(...)` | 命令输出超过 100k 字符时截断，全量写入沙箱文件并附路径 |
| `agent.mcp_tool_use` / `agent.mcp_tool_result{mcp_server_name}` | `item/started\|completed(mcpToolCall)` | |
| `session.error{error:{type,message,retry_status}}` | `error` 通知、driver 致命错误、沙箱错误、egress 拒绝 | |
| `session.usage` | `thread/tokenUsage/updated`，加上 gateway 计量 | |
| `span.model_request_start\|end{model_usage,is_error}` | model-gateway | |
| `session.updated` / `session.deleted` | api | |

客户端 → 平台：`user.message`（content：text / image(base64) / document(file_id)）、`user.interrupt`、`user.tool_confirmation{tool_use_id, result: allow|deny, deny_message?}`。二期加入 `user.custom_tool_result`。

### 12.2 不对外的内部事件

`runtime.started`、`runtime.recovered{mode}`、`runtime.exited`、`runtime.warning`、`runtime.unknown`、`approval.expired` 等写入 `session_internal_events` 表，供排障和审计使用。

### 12.3 方言与兼容差异（需要在文档中声明）

| 项 | Anthropic 方言 | BigModel 方言 | 本平台实际行为 |
| --- | --- | --- | --- |
| 工具集名 | `agent_toolset_20260401` | `agent_toolset_20260601` | 两者都接受，响应中回显请求时使用的名称 |
| 内置工具 | bash/read/write/edit/glob/grep/web_fetch/web_search | bash/read/write/edit/grep/find/ls | 底层是 Codex 的 shell + apply_patch。`read/grep/glob/find/ls` 映射为 shell 命令类工具（单独开关只能做到**审批粒度**，无法真正禁用，在 probe 中报告）；web_* 不支持，配置时返回 400 |
| 409 错误类型 | `conflict_error`？ | `invalid_request_error` | 按方言输出 |
| SSE 续传 | 不支持 | 不支持 | 支持 Last-Event-ID（扩展） |
| 排队事件在历史中 | 持久化，`processed_at=null`；排序位置未写明 | 可能没有 processed_at 或为 null | 持久化，`processed_at=null`，排在 asc 末尾、desc 开头（§7.3） |
| 历史排序键 | `processed_at` | 未写明（实际按处理时间） | processed_at（内部按 seq，两者同序） |
| 用户事件上流的时机 | 未写明 | 平台接手后推送，带 processed_at | 定序时推送，带 processed_at |
| 被 flush 的排队输入 | "queued inputs are flushed"，是否保留未写明 | 未写明 | 保留在历史中，在 flush 时定序；不交给模型；schema 不增加字段 |

---

## 13. 数据存储

### 13.1 PostgreSQL 表（核心）

```text
orgs(id, name, settings jsonb)
workspaces(id, org_id, name)
api_keys(id, workspace_id, hash, prefix, scopes, created_at, revoked_at)
agents(id, workspace_id, head_version, archived_at, ...)
agent_versions(agent_id, version, config jsonb, created_at)          PK(agent_id, version)
environments(id, workspace_id, config jsonb, internal jsonb, archived_at, ...)
sessions(id, workspace_id, agent_snapshot jsonb, environment_snapshot jsonb, status, stop_reason jsonb,
         title, metadata, vault_ids text[], usage jsonb, runtime_state, sandbox_id, codex_thread_id,
         codex_version_digest, last_event_seq, last_completed_execution_id,
         active_workspace_checkpoint jsonb, active_output_manifest jsonb, needs_restart, archived_at, ...)
session_events(session_id, seq null, id, type, payload jsonb, processed_at, received_at, disposition, source_event_id, generation, created_at)
         PK(session_id, id)  UNIQUE(session_id, seq)  UNIQUE(session_id, source_event_id)
         INDEX(session_id, seq NULLS LAST, received_at)   -- 历史列表
         INDEX(session_id, received_at) WHERE seq IS NULL -- 排队输入
         PARTITION BY HASH(session_id) 16
session_internal_events(...)
session_executions(...)            -- §5.6，取代 v0.1 的 runtime_commands
session_runtime_locks(session_id PK, holder_execution_id, generation)   -- §7.1.1
session_ops(...)                   -- §5.6.1 op journal
workspace_checkpoints(checkpoint_id, session_id, generation, manifest jsonb, state: candidate|active|superseded|corrupt, created_at)  -- §9.4
output_manifests(id, session_id, turn_seq, generation, entries jsonb, published_at)   -- §5.5
sandbox_orphans(...)               -- §9.3
egress_bindings(binding_id, session_id, execution_id, generation, sandbox_id, expires_at, revoked_at)  -- §10.4
runtime_instances(id, session_id, worker_id, codex_version, image_digest, started_at, exited_at, exit_info)
session_resources(id, session_id, type, file_id, mount_path, created_at)
files(id, workspace_id, scope_type, scope_id, filename, mime, size, sha256, object_key, created_at, expires_at)
vaults(...), credentials(id, vault_id, type, identity_key, secret_ciphertext, dek_wrapped, networking jsonb, ...)
idempotency_keys(workspace_id, key, request_hash, response jsonb, created_at)   TTL 24h
outbox(id, topic, payload, created_at, delivered_at)
egress_audit(...)  -- 按天分区，保留 30 天
```

### 13.2 MinIO

| Bucket | 键格式 | 用途 |
| --- | --- | --- |
| `mas-files` | `{workspace}/{file_id}` | 文件 |
| `mas-snapshots` | `{session_id}/{checkpoint_id}.tar.zst` | 不可变的 workspace checkpoint 候选（§9.4），由 `sessions.active_workspace_checkpoint` 指向当前生效的一个 |
| `mas-outputs` | `{session_id}/{sha256}` | 内容寻址的会话产物（§5.5） |

### 13.3 保留策略

- 事件永久保留，直到会话被删除；可按 org 配置 TTL。
- 快照：保留最近 3 个有效 checkpoint；会话归档后 7 天全部删除。
- `session_ops`、`egress_bindings`、已 settle 的 `session_executions`：保留 30 天。
- 幂等 key：24 小时。

### 13.4 Redis（可选）

- 当 SSE 连接数超过约 5k，或 PG NOTIFY 吞吐成为瓶颈时，引入 Redis Streams 替代 `LISTEN/NOTIFY` 做扇出。接口 `EventBus` 预先抽象好。

---

## 14. 可靠性与恢复

### 14.1 故障场景

| 场景 | 检测 | 处理 |
| --- | --- | --- |
| Codex 进程崩溃 | exec 流 EOF 或 exit | 子规格 §4：发出 turn.failed，标记 needs_restart；若有 active turn，进入 `rescheduling`，Level 1 恢复后**不重放**用户消息，而是发 `session.error{retry_status:"terminal"}` 并转 `idle(end_turn)`，由用户决定是否重试（避免重复副作用） |
| worker 崩溃 | execution 租约过期（30 秒） | 其他 worker 重新 claim：generation+1；旧 generation 的写入和出站授权立即失效 → 检查 `interrupt_requested_at` → resume 沙箱 → 按水位线选择 Level 1 或 0 |
| 沙箱丢失（宿主重启） | provider 报告 not found | 从最近快照重建；没有快照时新建沙箱，只恢复对话（Level 0）；发 `session.status_rescheduled` |
| 模型上游 5xx/超时 | Codex error 通知或 gateway | Codex 自身会重试；超过阈值后发 `session.error{retry_status:"retrying"}` → `rescheduling` → 指数退避，最多 3 次 → `idle(retries_exhausted)` |
| PG 不可用 | 写失败 | worker 暂停读取 Codex stdout（背压），超过 60 秒后停止 runtime 并释放租约；api 返回 503 |
| egress-proxy 不可用 | 沙箱请求失败 | **fail closed**（不直连）；由工具自身报错，平台告警 |
| 网络分区（worker 与 PG 断开） | 续约失败 | 不做投机续约；fence 失效后 drain，超过策略期限后强杀沙箱；无法确认已杀死的沙箱记入 `sandbox_orphans` |
| checkpoint 上传或发布中途崩溃 | 候选没有 active 指针 | 按 §9.4 的失败语义处理，候选不会生效 |
| 毒任务（反复崩溃） | `attempt_count ≥ max_attempts` 或超过 `deadline_at` | execution 置为 failed，写 `session.error{retry_status:"exhausted"}`，会话进入 `idle(retries_exhausted)` |

### 14.2 恢复策略

| Level | 名称 | 条件 | 效果 |
| --- | --- | --- | --- |
| 0 | 语义恢复 | 新沙箱，没有 `CODEX_HOME` | `thread/start` + `thread/inject_items(从事件日志重建的对话摘要/消息)`；文件系统丢失时提示用户 |
| 1 | 原生恢复 | 沙箱或快照中的 `/session/.codex` 仍在 | `thread/resume{threadId}`，对话和文件系统都保留；后台进程丢失 |
| 2 | 进程内状态迁移 | — | 不支持 |

空闲回收后的懒恢复走 Level 1：从 active checkpoint 重建沙箱，再执行 `thread/resume`。

#### 14.2.1 原生状态水位线（选择 Level 1 还是 Level 0）

借鉴 OpenMA `harness-runtime-acp` 的设计。它解决的崩溃窗口是："事件已经发布 `session.status_idle`，但 checkpoint 还没 CAS 发布"。这时 checkpoint 里的 Codex rollout 比事件日志**落后一轮**。直接 `thread/resume` 会静默丢掉最后一轮的上下文。

- **写入顺序**（每轮结束时，由 worker 执行）：
  1. Codex 报告 `turn/completed`。
  2. worker 把 `{last_completed_execution_id, codex_thread_id, codex_version_digest}` 写入 `/session/.mas/watermark.json`。
  3. 带 fence 的事务：写入 `session.status_idle`、更新 `sessions.last_completed_execution_id`、settle execution。
  4. 按 §9.4 提交 checkpoint，manifest 中带上 `completed_execution_watermark`。
  事件先于 checkpoint 发布，所以 checkpoint 失败时，用户依然能看到正确的输出。
- **恢复判定**：

| 条件 | 动作 |
| --- | --- |
| `checkpoint.watermark == sessions.last_completed_execution_id` 且 `codex_version_digest` 一致 | **Level 1**（`thread/resume`） |
| watermark 落后、缺少 rollout 文件，或 digest 不一致 | **拒绝原生 resume**，走 Level 0 |

- **Level 0 的限制**：只执行**一次**有界语义恢复。从事件日志构建对话（可以包含已完成的工具**结果**和附件引用），**绝不重放工具输入**。恢复后写 `runtime.recovered{mode:"semantic"}`（内部事件）。
- 这个判定与子规格 §8 的 Level 0/1 流程一起实现。子规格 §8 需要相应增加"水位线比对"这一步。

---

## 15. 安全模型

| 威胁 | 控制 |
| --- | --- |
| 沙箱逃逸 | gVisor runsc（或 Kata/Firecracker）；`CapDrop ALL`；无特权；宿主内核及时打补丁；沙箱节点与控制面节点分离（推荐） |
| 凭据窃取 | 沙箱内只有占位符；model key 只在 gateway 中；会话 token 短期有效且只对 gateway/proxy 有效 |
| 数据外泄 | `limited` 网络、默认拦截内网 CIDR 与元数据地址、出站审计 |
| 横向移动 | internal 网络，沙箱之间互不连通（`icc=false` 或每会话独立网络） |
| 资源滥用 | cpu/mem/pids/disk 配额；单 org 并发会话上限；会话最长运行时长 |
| 提示注入导致越权 | 工具审批（always_ask）；破坏性能力（如 git push）通过 MCP 或代理在策略层控制 |
| 租户隔离 | 所有查询都带 `workspace_id`；跨租户统一返回 404；行级安全（RLS）作为第二道防线 |
| 供应链 | 镜像签名（cosign）+ digest pin；SBOM；Codex 升级门禁 |
| 审计 | API 审计日志（谁在何时对哪个资源做了什么）、出站审计、审批决策记录 |

---

## 16. 可观测性

- 日志：pino JSON，统一字段 `request_id`、`org`、`session_id`、`execution_id`、`generation`、`runtime_instance_id`；沙箱 stderr 脱敏后进入日志。
- 指标（Prometheus）：

| 类别 | 指标 |
| --- | --- |
| API | `mas_api_requests_total{route,code}`、`mas_api_latency_seconds` |
| 会话 | `mas_sessions{status}`、`mas_session_turn_seconds`、`mas_session_ttft_seconds` |
| 沙箱 | `mas_sandbox_cold_start_seconds{phase}`、`mas_sandbox_active` |
| Runtime | `mas_runtime_restarts_total`、`mas_runtime_unknown_events_total{method}` |
| SSE | `mas_sse_connections` |
| 出网/模型 | `mas_egress_denied_total`、`mas_model_tokens_total{model,kind}` |

- 追踪：OpenTelemetry 链路 api → PG → worker → driver → gateway，`traceparent` 跟随 command 传递。
- 运维接口：`GET /internal/sessions/{id}/debug`（内部事件、runtime 状态、沙箱 stats），需要管理员权限。

---

## 17. 测试与发布门禁

### 17.1 测试层次

| 层 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | Zod schema、状态机、分页游标、egress 规则匹配、占位符替换 | Vitest |
| Driver | golden transcript 回放（`ReplayTransport`）、故障注入 | Vitest |
| 集成 | api + worker + PG + MinIO + DockerProvider（runc，跑在 CI 中）+ Fake Codex（按脚本应答的 JSON-RPC 假服务） | Testcontainers |
| 契约/验收 | `test-case-plan.md` 中的用例**以 BigModel 方言运行**（target=self），并**用官方 Anthropic SDK 黑盒运行**（target=self-anthropic-sdk，见 test-case-plan T-C） | 同一套 API 测试框架 + `@anthropic-ai/sdk` |
| 确定性混沌 | 带固定种子的多 owner 动作序列，枚举 execution 和 checkpoint 生命周期的每个边界：claim/renew/settle、提升、checkpoint 各阶段、output 发布、revoke；种子随用例提交，失败可以精确复现；使用虚拟时钟 | Vitest + 自研 model-based harness（`pnpm test:chaos`） |
| Live smoke | 真实 Codex + gVisor + 真实模型，跑 5 个代表任务 | nightly |
| 性能 | 冷启动、TTFT、SSE 扇出（1k 连接）、单 worker 50 并发会话 | k6 + 自定义 harness |
| 安全 | 逃逸基线（例如 `amicontained`）、凭据泄露扫描（检查沙箱 env 和文件中是否出现真实 key）、**CredentialEgress 一致性矩阵**（§10.4，test-case-plan SEC-01~10） | 脚本 + 验收框架 |

### 17.2 发布条件

- 验收用例中 P0 全部通过，P1 通过率 ≥95%（已声明的方言差异除外）。
- golden transcript 全部通过；live smoke 连续 3 晚通过。
- 冷启动 P50 < 5 秒、P95 < 15 秒；单 worker 50 并发会话时 worker RSS < 2 GB（不含沙箱）。
- 安全测试无高危问题；SEC-01~10 全部通过。
- 确定性混沌车道全绿（固定种子集合 ≥ 200 个）。

---

## 18. 建议仓库结构

```text
managed-agents/
├─ apps/
│  ├─ server/              # api + scheduler + model-gateway（按角色启动）
│  ├─ worker/              # session-worker
│  └─ egress-proxy/
├─ packages/
│  ├─ api-schema/          # Zod schema + OpenAPI 生成 + 方言适配
│  ├─ domain/              # 实体、状态机、事件映射（纯 TS）
│  ├─ db/                  # Kysely 类型、迁移、repo
│  ├─ event-bus/           # PG LISTEN/NOTIFY 实现（可替换为 Redis）
│  ├─ runtime-driver/      # AgentRuntimeDriver 抽象 + 归一化事件类型
│  ├─ codex-driver/        # CodexAppServerDriver（子规格）
│  ├─ codex-protocol/      # 生成的协议类型（pinned）
│  ├─ sandbox/             # SandboxProvider + opensandbox / docker 实现
│  ├─ vault/               # 信封加密、凭据解析
│  └─ observability/
├─ images/
│  └─ codex-runtime/       # Dockerfile：ubuntu 24.04 + node 22 + python 3.11 + codex@pinned + 企业 CA
├─ deploy/
│  ├─ compose/             # docker-compose.yml（单机）
│  └─ helm/                # 二期
├─ tests/
│  ├─ fixtures/codex/      # golden transcripts
│  ├─ acceptance/          # test-case-plan 落地的用例（可指向 bigmodel 或本平台）
│  └─ e2e/
└─ scripts/sync-codex-protocol.mjs
```

### 18.1 Docker Compose（单机）拓扑

```yaml
services:
  postgres:      { image: postgres:16, volumes: [pg:/var/lib/postgresql/data] }
  minio:         { image: minio/minio, command: server /data }
  server:        { image: mas/server, environment: [ROLES=api,scheduler,gateway], depends_on: [postgres, minio] }
  worker:        { image: mas/worker, volumes: ["/var/run/docker.sock:/var/run/docker.sock"],  # DockerProvider
                   environment: [SANDBOX_PROVIDER=opensandbox, OPENSANDBOX_URL=http://opensandbox:8080] }
  opensandbox:   { image: opensandbox/server, volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }
  egress-proxy:  { image: mas/egress-proxy, networks: [sandbox-net, default] }
networks:
  sandbox-net:   { internal: true }
```

宿主前置条件：Docker ≥ 25；已安装 gVisor（`runsc install` 后 `/etc/docker/daemon.json` 中注册 runtime）；如果使用 Firecracker 或 E2B，需要 KVM。

---

## 19. 待技术预研决策（M0 Spike）

| # | 问题 | 选项 | 决策依据 |
| --- | --- | --- | --- |
| Q1 | OpenSandbox execd 是否支持长连接的交互式 stdio（codex app-server 需要） | 支持 → 直接使用；不支持 → 沙箱内 stdio-bridge | spike 实测 |
| Q2 | gVisor 下 Codex 的 `workspaceWrite`（Landlock/seccomp）是否可用 | 可用 → 双层沙箱；不可用 → `dangerFullAccess` + gVisor | spike 实测 + 安全评审 |
| Q3 | 企业内部模型是否兼容 Responses API | 兼容 → 直连；不兼容 → gateway 转换（LiteLLM / CLIProxyAPI）并验证 Codex 工具调用质量 | 实测 |
| Q4 | `read/grep/glob` 等内置工具的禁用粒度 | 审批粒度 / 通过 Codex feature 禁用 / 不支持 | Codex config 能力调研 |
| Q5 | `custom` 工具是否通过 Codex `dynamicTools`（实验性）实现 | 二期，需要 `experimentalApi` allowlist | 协议稳定性 |
| Q6 | 事件扇出用 PG NOTIFY 还是 Redis | 压测阈值 | 性能测试 |
| Q7 | OpenMA fork 路线（R2）是否优于自研（R1） | 见 `open-managed-agents-调研报告.md` §5.2 的 G1–G5 | M0 并行 PoC（1 周） |
| Q8 | Codex rollout（`CODEX_HOME`）在 checkpoint 恢复后能否被同版本的 `thread/resume` 正确读取；水位线文件的写入时机是否覆盖所有退出路径 | 实测 kill -9 于 turn 中、turn 后 settle 前、settle 后 checkpoint 前三个时点 | spike 实测 |

### 19.1 二期路线图

Memory Store（挂载到 `/mnt/memory/<slug>`，借鉴 Anthropic 的版本化设计）→ Skills（挂载到 `/workspace/skills`，Codex skills 目录）→ Deployments（cron，复用 scheduler）→ Webhooks（outbox + Standard Webhooks 签名）→ warm pool → K8s（agent-sandbox CRD 作为另一个 SandboxProvider）→ custom tools / multiagent（启用 lane_id 并发，§5.6）。

另外两项可选：
- **`AcpDriver`**：作为 `AgentRuntimeDriver` 的第二个实现，用来托管 Claude Code、Gemini CLI、codex-acp 等 ACP agent。参考 OpenMA 的 `packages/acp-runtime` 与 `harness-runtime-acp`（Apache-2.0，移植时保留 NOTICE）。
- **`/openai/v1` 兼容层**：把同一套 Agent/Session/Event 投影成 OpenAI Agents API（`agent.session.*` 事件、`Idempotency-Key`），参考 OpenMA `packages/openai-agents-compat`。Codex 本身就是 OpenAI Agents API 的 harness，语义映射成本较低。
