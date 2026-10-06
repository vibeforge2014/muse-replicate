# muse-replicate — 企业私有化 Managed Agents 平台（MVP）

对 `spec.md`（后端架构规格）的参考实现，按 `plan.md` 的里程碑推进，验收用例来自 `test-case-plan.md`（BigModel Managed Agents 方言子集）。

目标：在企业内网部署一个托管 Agent 运行平台 —— 业务方通过 HTTP API 创建 Agent、启动会话，平台在隔离运行时中执行长时任务，通过 SSE 推送进度；事件日志是唯一事实来源（spec §1.2）。

## 当前实现范围（对应 plan.md M1 + M2 + M3 核心）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Monorepo（pnpm workspace + TS strict + vitest） | ✅ | 5 个包：core / db / runtime / server / worker |
| Agent 版本化 CRUD | ✅ | 乐观锁、无变化不升版、metadata 合并、归档幂等（AGT-01~25） |
| Environment CRUD | ✅ | networking/packages 校验、规范化、归档/删除引用检查（ENV-01~14） |
| Session 生命周期 | ✅ | 三种 agent 引用形态、快照固化、initial_events、归档/删除前置条件（SES-01~29） |
| 事件准入与排序 | ✅ | 排队事件（`processed_at=null`）+ 处理时定序（seq 单调、会话内唯一）（§7.3 / EVT-S/L） |
| session_executions 队列 | ✅ | claim（FOR UPDATE SKIP LOCKED）+ generation fencing + renew + settle-before-renew（§5.6/§7.1） |
| Worker 事件循环 | ✅ | 归一化事件映射（§12.1）、状态物化、interrupt 持久化（§6） |
| 审批流 | ✅ | `always_ask` → `requires_action` → `user.tool_confirmation`（TOOL-04~11） |
| 持久化中断 | ✅ | running 中断 / requires_action 作废未决审批（TOOL-09/15） |
| SSE 实时流 | ✅ | LISTEN/NOTIFY、15s 心跳、Last-Event-ID 回补、只推实时、session.deleted 关闭（§11.5 / EVT-R） |
| 鉴权 / 错误信封 / request-id / 限流 | ✅ | 方言检测（zai-* / anthropic-*），BigModel 409 → invalid_request_error（§11.1） |
| Checkpoint 提交协议 | ✅ | 轮末不可变候选（json.gz/v1）+ sha256 校验 + fence CAS 发布 + GC keep=3（§9.4） |
| 水位线恢复 | ✅ | 水位线+digest 一致 → Level 1 原生 resume；不一致 → Level 0 语义重放（仅 user/agent 消息）+ `runtime.recovered` 内部事件（§14.2.1 / REC-01~06） |
| Worker 接管语义 | ✅ | 已 delivered 的过期租约不重放用户消息（terminal error）；持久化中断被接管方遵守（REC-01/02） |
| 毒任务回收 | ✅ | attempt 耗尽 + 租约过期 → failed + `session.error(exhausted)` + idle(retries_exhausted)（REC-06） |
| Idempotency-Key | ✅ | POST events：同 key 同 body 回放首次响应、异 body 409 idempotency_conflict（REC-07） |
| Vaults / Credentials | ✅ | 信封加密（AES-256-GCM 双层，主密钥 `MAS_MASTER_KEY`）、API 永不回显（`***`+末 4 位）、轮换语义、归档（VLT-01~04/09） |
| Files API | ✅ | multipart 上传、sha256 校验、before_id/after_id 分页、下载/删除（FILE-01~05） |
| Session Resource 挂载 | ✅ | 创建/运行中挂载、worker 每轮物化到沙箱 uploads（只读语义）、卸载即消失（RES-01/02/06、SES-28） |
| 输出清单 | ✅ | 轮末枚举 outputs → sha256 内容寻址上传 → fence CAS 发布 manifest → `(session,path,sha256)` 去重登记 File（§5.5 / REC-08） |
| 能力协商 fail closed | ✅ | env.isolation 要求 vs provider 实际等级，不满足 → terminated + capability_unsatisfied，禁止降级（REC-09） |
| digest 下线降级 | ✅ | 原 codex digest 不一致 → 强制 Level 0 + `runtime_upgraded`（retrying），会话可继续（REC-10） |
| Fake Codex runtime | ✅ | JSON-RPC over stdio 的脚本化假 app-server（plan 1.9），支撑全部集成测试；`out <text>` 模拟沙箱产出 |

未实现（按 plan 后续里程碑）：OpenSandbox/gVisor 真实沙箱与 egress-proxy + CredentialEgress（M4 后半，VLT-05~08/SBX-06~08 的前置）、model-gateway（M2 2.11）、确定性混沌车道（M3 3.9）、Memory Stores / Skills / Deployments（二期 API 面）。当前 runtime 用 `FakeCodexDriver`（本机子进程）替代沙箱内的 `codex app-server`，`AgentRuntimeDriver` 接口与 spec §8.1 一致，可替换。

## 快速开始

需要：Node ≥ 22、pnpm ≥ 10、PostgreSQL（任意 16/17 实例，或用 docker compose）。

```bash
pnpm install

# 方式一：docker compose（起 postgres + server + worker）
docker compose -f deploy/compose/docker-compose.yml up --build

# 方式二：本地开发（本仓库开发时用的是 5433 端口的本地实例）
export DATABASE_URL=postgres://<user>@localhost:5432/<db>
pnpm --filter @mas/db migrate      # 建表
pnpm dev:server                    # api（首次启动自动 bootstrap 并打印 API key）
pnpm dev:worker                    # session-worker（另开终端）
```

冒烟：

```bash
API_KEY=<启动时打印的 mas_sk_...> npx tsx scripts/smoke.ts
```

测试（需要本地 PG，默认 `postgres://mas@localhost:5433/mas_test`，用 `DATABASE_URL` 覆盖；测试会清空该库）：

```bash
pnpm test        # 49 个集成用例：AUTH/AGT/ENV/SES/EVT-S/EVT-L/EVT-R/TOOL/ORD
```

## API 一览（BigModel 方言 headers：`zai-version: 2026-05-26`，`zai-beta: managed-agents-2026-05-26`）

```bash
KEY=mas_sk_...; BASE=http://127.0.0.1:8080

# Agent（版本化）
curl -XPOST $BASE/v1/agents -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"demo","model":{"id":"glm-5.3-flash"},"tools":[{"type":"agent_toolset_20260601","default_config":{"permission_policy":{"type":"always_allow"}}}]}'
curl $BASE/v1/agents -H "authorization: Bearer $KEY"

# Environment
curl -XPOST $BASE/v1/environments -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"default","config":{"type":"cloud"}}'

# Session + 一轮对话
curl -XPOST $BASE/v1/sessions -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"agent":"agent_xxx","environment_id":"env_xxx"}'
curl -XPOST $BASE/v1/sessions/sesn_xxx/events -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"run echo hi"}]}]}'
curl $BASE/v1/sessions/sesn_xxx/events -H "authorization: Bearer $KEY"     # 历史
curl -N $BASE/v1/sessions/sesn_xxx/events/stream -H "authorization: Bearer $KEY"  # SSE
```

## 仓库结构（对应 spec §18）

```text
packages/core        # ID/ULID、MasError（方言错误信封）、分页游标、Zod schema（Agent/Env/Session/Event）
packages/db          # Kysely + pg：前向迁移（4 组）、repos（准入/定序/claim/renew/settle/历史查询）
packages/runtime     # AgentRuntimeDriver 接口 + FakeCodexDriver（JSON-RPC stdio 假 app-server）
apps/server          # Fastify：鉴权、request-id、方言、限流、Agent/Env/Session/Events 路由 + SSE
apps/worker          # session-worker：NOTIFY + 扫描驱动，SessionRunner 持租约执行
deploy/compose       # docker-compose（postgres + server + worker）
tests/               # 集成测试（test-case-plan 的 P0 子集，编号对应用例）
scripts/smoke.ts     # 端到端冒烟
```

## 关键设计落地（与 spec 章节映射）

- **事件日志是唯一事实来源**（§1.2/§5.4/§7.3）：`session_events(seq 可空, processed_at, disposition, source_event_id 唯一, generation)`；用户输入由 api 写入（排队，`processed_at=null`，历史可见），worker claim 后在 fence 内定序（`seq = last+1`，`processed_at` 会话内单调唯一）；`GET events` 按 `ORDER BY seq NULLS LAST`（= 按 processed_at），排队事件排在 asc 末尾。
- **单写者 + execution 级 fencing**（§5.6/§7.1）：`session_executions` 表即队列即 WAL；claim 用 `FOR UPDATE SKIP LOCKED` 一次完成（state/owner/attempt_id/generation+1/attempt_count/lease）；事件追加前校验 fence（旧 generation 写入被拒）；settle 前强制再续约。
- **中断是持久状态**（§6）：POST events 同一事务内写 `interrupt_requested_at`、取消同 lane 的 queued 输入（其事件定序并标记 `flushed`，保留在历史）；worker tick 检测后调用 `turn/interrupt`；requires_action 期间的 interrupt 生成 `kind=interrupt` 执行，未决审批按 deny 处理。
- **审批映射**（§8.2/§12.1）：`always_ask` → driver `approvalPolicy=untrusted`；`item/awaitingApproval` → `agent.tool_use(evaluated_permission=ask)` + `session.status_idle{requires_action, event_ids}`；`user.tool_confirmation` 走 `kind=tool_confirmation` execution 回写 runtime；resolution 校验 404/409。
- **SSE**（§11.5）：每连接独立 LISTEN client；先 LISTEN 再回补再按 seq 去重；无 Last-Event-ID 时从当前 max(seq) 起步（默认只推实时）；15s 心跳；删除会话用 `pg_notify(payload='deleted')` 推送合成 `session.deleted` 帧后关闭。
- **Checkpoint 提交协议**（§9.4）：每轮 settle 后写 `watermark.json` 到 runtime home → 打包不可变候选（`json.gz/v1`，目录文件集的 gzip JSON）→ 重新读取校验 sha256 → 事务内 CAS 发布（fence 失效则候选作废）→ GC 保留最近 3 个。对象存储走 `SnapshotStore` 抽象（MVP 为本地 `FsSnapshotStore`，接 MinIO 换 S3 实现）。
- **输出清单**（§5.5）：轮末枚举沙箱 outputs 目录，逐文件 sha256 后按 `outputs/{session}/{sha256}` 内容寻址上传（字节一致 = 幂等）；manifest 只有当前 fence 能 CAS 发布为 `sessions.active_output_manifest`；条目登记为 session 范围 File，`(scope_id, filename, sha256)` 唯一索引保证重复收集不产生重复 File（REC-08）；失败条目写 `session.error{output_incomplete}`。
- **凭据与挂载**（§10.1/§5.5）：机密字段双层 AES-256-GCM 信封加密（数据密钥 + 主密钥包裹），API 只回 `***`+末 4 位；会话创建校验 `vault_ids`（存在/同租户/未归档）；File Resource 由 worker 每轮物化到 `<home>/uploads/<mount_path>`（重挂载重建、卸载即删）。
- **能力协商**（§9.0）：环境 `config.isolation`（gvisor/microvm/runc，缺省 = 平台默认 gvisor|microvm）对 worker 的 `providerIsolation`（`MAS_SANDBOX_ISOLATION`）校验，不满足 fail closed → `terminated` + `session.error{capability_unsatisfied}`，禁止静默降级（REC-09）。
- **水位线恢复**（§14.2.1）：接管方 acquire runtime 时判定 —— `active_workspace_checkpoint.completed_execution_watermark === sessions.last_completed_execution_id` 且 `codex_version_digest` 一致 → **Level 1**（restoreCheckpoint 还原文件 + `thread/resume` 原生续聊）；否则（checkpoint 缺失/落后/损坏）→ **Level 0** 语义恢复：从事件日志重放 `user.message`/`agent.message` 文本（绝不重放工具输入），写内部事件 `runtime.recovered{mode, reason}`；checkpoint 校验失败额外写 `session.error{checkpoint_corrupt}`。

## 与规格的已知偏差（务实取舍）

1. runtime 为 FakeCodexDriver（本机子进程 + `/tmp` rollout），非沙箱内 `codex app-server`；协议形态一致（initialize/thread/start/turn/start/item/*/turn/completed），替换真实 driver 不动 worker。
2. api 在 `requires_action` 等状态下可能从快照读 stop_reason 而非事件推导（物化视图已同步维护）。
3. 限流为单进程内存令牌桶；多实例部署需换 PG/Redis（spec §13.4 预留）。
4. checkpoint 归档格式为 `json.gz/v1`（文件集 gzip JSON）而非 spec 的 tar.gz；对象存储为本地 `FsSnapshotStore` 而非 S3（`SnapshotStore` 接口已抽象，替换实现即可）。
5. File 内容与 output 对象存本地 FS（`MAS_FILES_DIR`，默认 `/tmp/mas-files`）而非 MinIO；Key 布局与 spec 一致（`files/{org}/{file_id}`、`outputs/{session}/{sha256}`），换 S3 实现即可。
6. 沙箱能力协商目前是 worker 侧静态声明（`MAS_SANDBOX_ISOLATION`），OpenSandbox/Docker+runsc provider 接入后改为 provider 真实上报。
7. Idempotency-Key 已挂 POST events；其余 POST 路由（agents/environments 等）幂等按 M5 全量化推进。
8. agent 事件 `span.model_request_*`/`session.usage` 由 runtime 上报路径尚未接线（fake 不产生计量）。

## 后续路线（按 plan.md）

M3 已完成（checkpoint/水位线恢复 + REC-01~07）→ M4 前半已完成（Vault/Files/Resources + 输出清单 + REC-08/09/10，测试 74/74 绿）→ M4 后半：sandbox provider（OpenSandbox/Docker+runsc）、egress-proxy/CredentialEgress、model-gateway → M5：幂等全量、可观测、性能。
