# 企业私有化 Managed Agents 平台 — 代码实现计划书（plan）

> 对应规格：`claude/spec.md`｜子计划：`claude/codex-app-server-adapter/plan.md`（CodexAppServerDriver，5 周，与本计划 M0–M3 并行）
> 验收：`claude/test-case-plan.md`（以 BigModel 方言对本平台运行）
> 人力假设：4 人
> - **P**：平台/后端，负责 API、DB、事件
> - **R**：Runtime，负责 driver 与 worker
> - **S**：沙箱/基础设施，负责 provider、网络、镜像、部署
> - **Q**：测试，负责验收框架与性能
>
> 总工期：**10 周**到 MVP GA，另有 4 周二期。
> v0.2 修订（2026-10-05）：同步 spec v0.2（吸收 OpenMA 的 T1–T12），并在 M0 增加 OpenMA PoC（0.9）。

---

## 1. 里程碑总览

| 里程碑 | 周 | 目标 | 出口标准 |
| --- | --- | --- | --- |
| **M0 Spike** | W1 | 消除 spec §19 中的关键不确定性 | Q1–Q4、Q7、Q8 有结论；Codex 在 gVisor + OpenSandbox 中跑通一个 turn；模型网关跑通 Responses API；OpenMA PoC 给出 R1/R2 决策 |
| **M1 地基** | W2–W3 | Monorepo、DB、api 骨架、Agent/Environment CRUD、DockerProvider、Fake Codex | Agent/Environment 验收用例 P0 通过；CI 全绿 |
| **M2 会话主链路** | W4–W5 | Session + events + SSE + worker 租约 + Codex driver 接入 | 端到端：创建会话 → 发消息 → SSE 收到 agent.message → idle(end_turn)；Session/Event P0 通过 |
| **M3 审批、中断与恢复** | W6–W7 | always_ask、持久化 interrupt、execution fencing 接管、checkpoint 提交协议、水位线恢复、空闲暂停/懒恢复 | 审批/中断/恢复的验收、故障注入和确定性混沌用例通过 |
| **M4 凭据、网络与文件** | W7–W8 | Vault、egress-proxy + CredentialEgress（generation 绑定）、limited 网络、Files/Resources、内容寻址 output manifest、MCP | 凭据泄露扫描为 0；SEC-01~10 通过；网络与文件验收通过 |
| **M5 加固与 GA** | W9–W10 | 幂等、限流、可观测、性能、安全测试、部署文档 | spec §17.2 发布条件全部满足 |
| M6 二期 | W11–W14 | Memory / Skills / Deployments / Webhooks / warm pool | 各自的验收用例 |

依赖关系：

```text
M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M5
           └──▶ M4 ───┘
codex-driver 子计划: M0(spike)=W1, M1=W2, M2=W3, M3=W4, M4=W5 → 在本计划的 W4 接入 worker
```

---

## 2. 详细任务

### M0 Spike（W1）

| # | 任务 | 负责 | 产出 / 判定 |
| --- | --- | --- | --- |
| 0.1 | 构建 `images/codex-runtime`：Ubuntu 24.04 + Node 22 + Python 3.11 + `@openai/codex@<pin>` + 企业 CA，记录 digest，生成 SBOM | S | 镜像 digest |
| 0.2 | 宿主安装 gVisor，注册 runsc；部署 OpenSandbox server（Docker runtime） | S | 部署脚本 |
| 0.3 | **Q1**：通过 OpenSandbox execd 以交互式 stdio 运行 `codex app-server`，跑通 initialize → thread/start → turn/start → turn/completed；测量 30 分钟长连接的稳定性 | R + S | 结论：直接 exec，或改用 stdio-bridge |
| 0.4 | **Q2**：在 runsc 中测试 `workspaceWrite` 与 `dangerFullAccess` | R + S | 安全决策记录 |
| 0.5 | **Q3**：model-gateway 原型（Responses API 透传 + 注入 key）；对接企业模型，测试 Codex 工具调用质量（10 个任务） | P | 兼容结论 |
| 0.6 | **Q4**：调研 Codex 内置工具的开关粒度，形成 Managed Agents 工具名与 Codex 能力的映射表 | R | 映射表（写回 spec §12.3） |
| 0.7 | 搭建验收测试框架雏形（`tests/acceptance`），先对 BigModel 跑 smoke，验证框架和方言抽象（与 test-case-plan T0 同步） | Q | 框架 PoC |
| 0.8 | 录制首批 Codex golden transcript（与子计划 M0 共享） | R | fixtures |
| 0.9 | **Q7 OpenMA PoC**（与 0.1–0.8 并行，S 和 R 各投入半周）：内网部署 OpenMA main-node + PostgreSQL，执行 `open-managed-agents-调研报告.md` §5.2 的 G1–G5：官方 SDK 冒烟、E2B 自托管或 BoxLite 下 codex-acp 一轮工具调用与审批、oma-vault 跨会话/直连测试、kill -9 恢复、fork 维护成本评估 | S + R | R1/R2 决策记录；不论结论如何，都产出"OpenMA 行为观察"作为设计输入 |
| 0.10 | **Q8**：在 gVisor 中对 `codex app-server` 做 3 个时点的 kill -9（turn 中、turn 后 settle 前、settle 后 checkpoint 前），验证恢复 checkpoint 后同版本 `thread/resume` 是否可用，以及水位线判定是否正确 | R | 水位线方案确认（写回子规格 §8.1） |

**Go/No-Go**：
- 0.3 失败且 stdio-bridge 也不可行时，切换到 DockerProvider（`docker exec -i` + runsc）作为 MVP 唯一 provider，OpenSandbox 延后。
- 0.9 的 G1–G5 全部通过，**并且**团队接受"ACP 替代 app-server、microVM 替代 gVisor"时，召开评审决定是否切换到 R2（fork OpenMA）。切换后需要重写 M1–M5 计划。否则维持 R1，PoC 观察作为设计输入。

### M1 地基（W2–W3）

| # | 任务 | 负责 | 说明 |
| --- | --- | --- | --- |
| 1.1 | Monorepo：pnpm + turbo + tsconfig（strict、ESM）+ eslint/biome + Vitest + Changesets；CI（lint/type/test/build/镜像） | P | |
| 1.2 | `packages/db`：Kysely 迁移，建表 orgs/workspaces/api_keys/agents/agent_versions/environments/idempotency_keys/outbox | P | |
| 1.3 | `packages/api-schema`：Zod 定义通用信封（error、分页、metadata 规则）、Agent、Environment；生成 OpenAPI | P | 同一份 schema 用于校验与文档 |
| 1.4 | `apps/server`：Fastify 骨架、鉴权中间件（API key 哈希）、request-id、错误映射、方言检测（`anthropic-*` / `zai-*` / `mas-version`） | P | |
| 1.5 | Agent API：CRUD、版本化（规范化 + 深比较，无变化不升版本）、乐观锁、metadata 合并、archive | P | |
| 1.6 | Environment API：CRUD、networking 校验规则（limited 字段互斥、packages 需要 allow_package_managers）、archive/delete | P | |
| 1.7 | 分页游标工具（base64url，按 id 或 seq） | P | |
| 1.8 | `packages/sandbox`：`SandboxProvider` 接口 + `DockerProvider`（dockerode：create/exec 交互/pause/destroy/putFiles/getFiles）；`sandbox-net` internal 网络 | S | CI 中使用 runc |
| 1.9 | `tests/fakes/fake-codex`：按 YAML 脚本应答的 JSON-RPC 假 app-server（可模拟 delta、审批、崩溃、慢响应） | R | 集成测试的基础 |
| 1.10 | 验收框架：client（方言）、fixture 工厂、清理器；完成 Agent/Environment 的 P0 用例 | Q | |
| 1.11 | `deploy/compose`：postgres、minio、server，提供本地一键启动 | S | |

### M2 会话主链路（W4–W5）

| # | 任务 | 负责 | 说明 |
| --- | --- | --- | --- |
| 2.1 | 迁移：sessions、session_events（hash 分区）、**session_pending_inputs、session_executions、session_runtime_locks**、runtime_instances、session_internal_events（spec §5.6、§7.3、§13.1） | P | |
| 2.2 | Session API：create（agent 三种形态、快照固化、initial_events）、get/list（过滤）、update（title/metadata）、archive/delete 前置条件 | P | |
| 2.3 | `POST events`：1–10 条整批原子校验；状态前置校验（requires_action 时拒绝 user.message）；在同一事务中写入 pending input 和 execution（准入，`input_fingerprint` 去重）；**api 不分配 seq**（spec §7.3）；SSE 推送 `input_queued` | P | |
| 2.4 | `GET events`：历史分页、types 过滤、created_at（按 processed_at 比较）、after_seq、`include_pending` | P | |
| 2.5 | `packages/event-bus`：PG LISTEN/NOTIFY（单连接多路复用，按 session 订阅） | P | |
| 2.6 | SSE：实时推送、15 秒心跳、`Last-Event-ID`/`after_seq` 回补（先 LISTEN 再查询，按 seq 去重）、`session.deleted` 后关闭、连接配额 | P | |
| 2.7 | `apps/worker`：execution 级 claim/renew/settle（generation + attempt_id + deadline + max_attempts，settle 前再续约一次）、session 运行锁、会话分派（SKIP LOCKED + scheduler 扫描过期租约）、pending 输入提升并分配 seq、`withExecutionGuard` 包装 SandboxProvider、`SessionRunner` 生命周期（spec §7.1、§7.3） | R | |
| 2.8 | 接入 `codex-driver`（子计划 M2 产物）：start/probe、CODEX_HOME 与 config.toml 生成、user.message → turn/start | R | |
| 2.9 | 事件映射：NormalizedRuntimeEvent → 对外事件（spec §12.1 最小集）、session.status_* 物化、usage 汇总 | R | |
| 2.10 | delta 扇出：agent.message/thinking 的 `event_start`/`event_delta` | R + P | |
| 2.11 | model-gateway 正式版：会话 JWT、计量写入 model_usage、span 事件 | P | |
| 2.12 | 沙箱创建流程：Environment → 派生镜像（packages hash 缓存）→ **能力协商**（`capabilities()` + 实测 isolation，不满足 fail closed）→ create → probe；会话固定 `codex_version_digest`（spec §8.4、§9.0） | S | |
| 2.13 | 验收：Session/Event P0；E2E smoke（Fake Codex + 真实 Codex 各一条） | Q | |

### M3 审批、中断与恢复（W6–W7）

| # | 任务 | 负责 | 说明 |
| --- | --- | --- | --- |
| 3.1 | 权限策略映射：tools/configs 映射为 Codex approvalPolicy + 平台 ApprovalBroker（按工具粒度自动裁决或转人工） | R | |
| 3.2 | requires_action：`agent.tool_use(evaluated_permission=ask)` + `idle(requires_action, event_ids)`；`user.tool_confirmation` 回写 server request；resolution 校验（404/409/400 规则） | R + P | |
| 3.3 | interrupt：**持久化 `interrupt_requested_at`**，同时取消该 lane 中 queued 的输入；turn/interrupt，10 秒后硬取消；接手的 worker 遵守同一个中断；未决审批按 deny 处理；流顺序为 user.interrupt → span end(is_error) → idle(end_turn) | R + P | |
| 3.4 | 故障：Codex 崩溃（needs_restart、懒重启）、worker 崩溃接管（generation fencing，旧写入被拒绝）、毒任务（max_attempts/deadline）、沙箱丢失重建；**水位线判定 Level 1/0**（spec §14.2.1，子规格 §8.1）；`sandbox_orphans` reaper | R | |
| 3.5 | scheduler：租约过期回收、空闲暂停（10 分钟）、快照 + 销毁（24 小时）、会话最长时长 | S + R | |
| 3.6 | **Checkpoint 提交协议**：不可变候选 → manifest（sha256、watermark、digest）→ 重新读取校验 → generation CAS 切换 active 指针 → GC 保留 3 个；resume = 重建沙箱 + 解包 active checkpoint + 水位线判定（spec §9.4） | S + R | |
| 3.7 | rescheduling：模型错误重试（指数退避，最多 3 次）→ retries_exhausted | R | |
| 3.8 | Session update：idle 时修改 tools/mcp_servers（下个 turn 生效：重写 config 后重启 app-server 并 resume） | R | |
| 3.9 | 故障注入测试：kill codex、kill worker、kill 沙箱容器、PG 短暂断连、gateway 5xx；**确定性混沌车道**（`pnpm test:chaos`：固定种子、虚拟时钟，枚举 claim/renew/settle/提升/checkpoint 各阶段/output 发布/revoke 边界，种子数 ≥ 200） | Q + R | |
| 3.10 | 验收：审批/中断/状态机/排序（ORD）/恢复（REC）相关 P0/P1 | Q | |
| 3.11 | op journal（spec §5.6.1）：model-gateway 记录模型请求的 op；恢复时扫描未完成项，上游支持幂等键的带 `op_id` 重试，否则发出 `op_outcome_unknown` | P | |

### M4 凭据、网络与文件（W7–W8，与 M3 部分并行）

| # | 任务 | 负责 | 说明 |
| --- | --- | --- | --- |
| 4.1 | `packages/vault`：信封加密、Vault/Credential API（environment_variable、static_bearer）、机密不回显、轮换 | P | |
| 4.2 | `apps/egress-proxy`：HTTP/CONNECT、TLS 终止（企业 CA）、白名单（unrestricted 黑名单 / limited 白名单）、占位符替换、审计、403 + 拒绝事件；**CredentialEgress**：prepare/attach/revoke 生命周期，出站 token 绑定 `(session, execution, generation, sandbox)`，按会话 vault_ids 缩小范围后再按 host 匹配，剥离竞争凭据头，查询出错时 fail closed，四类数据面分开处理，非 GET 凭据请求写 op journal（spec §10.4） | S | |
| 4.3 | MCP 反向代理入口：附加 static_bearer；Codex config 改写 | S + R | |
| 4.4 | 包管理器源：allow_package_managers 指向企业镜像源（Nexus），在 Environment 派生镜像构建阶段使用 | S | |
| 4.5 | Files API：multipart 上传（流式写入 MinIO，计算 sha256）、list（scope_id、before_id/after_id）、content 下载、delete | P | |
| 4.6 | Session Resources：创建/运行中挂载到 `/mnt/session/uploads`、卸载、路径规范化与重叠校验 | P + S | |
| 4.7 | **内容寻址 output manifest**：枚举、计算 sha256、上传（按字节比较做幂等）、generation CAS 发布、文件身份为 `(session, path, sha256)`、incomplete 标记（spec §5.5） | R | |
| 4.8 | 安全测试：沙箱内扫描 env、文件和进程参数，确认不存在真实 key；**SEC-01~10 一致性矩阵**（test-case-plan §5.17）：跨会话同 host、忽略代理变量后直连、旧 generation、IPv6/DNS/UDP/QUIC/非标准端口、重定向、CONNECT、代理宕机时 fail closed、日志无凭据 | Q + S | |

### M5 加固与 GA（W9–W10）

| # | 任务 | 负责 |
| --- | --- | --- |
| 5.1 | Idempotency-Key（所有 POST）；限流令牌桶（PG 或内存 + 一致性哈希）；429 响应头 | P |
| 5.2 | 可观测：pino 字段规范、Prometheus 指标（spec §16）、OTel 链路、Grafana 看板、告警规则 | S |
| 5.3 | 性能：冷启动优化（派生镜像预热、并行 probe）；SSE 1k 连接压测；单 worker 50 会话；PG 事件写入 TPS | Q + R |
| 5.4 | 审计日志、RLS 二道防线、管理员 debug 接口 | P |
| 5.5 | 运维文档：部署（compose + gVisor 安装）、备份恢复（PG/MinIO）、Codex 升级手册、故障排查手册 | S |
| 5.6 | 全量验收回归（P0 100%，P1 ≥95%），包括 **T-C 官方 Anthropic SDK 黑盒车道**；混沌车道全绿；live smoke 连续 3 晚通过；安全评审 | Q |
| 5.7 | API 文档站（由 OpenAPI 生成）+ TS SDK（openapi-typescript 生成，或兼容 Anthropic SDK 的 baseURL 用法说明） | P |

### M6 二期（W11–W14）

| 周 | 内容 |
| --- | --- |
| W11 | Memory Store（API + 挂载 `/mnt/memory/<slug>` + 版本） |
| W12 | Skills（zip 上传 + 版本 + 挂载到 Codex skills 目录）、Deployments（cron + runs） |
| W13 | Webhooks（outbox + Standard Webhooks 签名 + 重试）、warm pool |
| W14 | custom tools（Codex dynamicTools，experimental allowlist）PoC；K8s provider（agent-sandbox）PoC |

---

## 3. 工程规范

- **代码**：TypeScript strict；领域层（`packages/domain`）不依赖 IO；所有外部输入经过 Zod 校验；错误使用 `MasError(type, status, message, details)`，统一映射。
- **数据库**：迁移只能前向；大表（session_events）的变更需要评审；所有查询带 `workspace_id`。
- **测试**：每个 PR 必须通过单元测试和集成测试（Fake Codex）；涉及 driver 的 PR 必须通过 golden 回放；验收用例对本平台每日运行，对 BigModel 每周运行（检测上游行为漂移，同时保持方言兼容）。
- **发布**：镜像 cosign 签名；Changesets 生成变更日志；Codex 版本升级走独立 PR，并附带 golden 差异说明。

---

## 4. 验收清单（MVP Definition of Done）

- [ ] spec §2.1 范围内的端点全部实现，OpenAPI 文档自动生成
- [ ] `test-case-plan.md` 中 P0 用例 100% 通过、P1 ≥95%（方言差异已在文档中声明）
- [ ] Codex golden transcript 全部通过；故障注入矩阵通过
- [ ] 凭据泄露扫描为 0；出网绕过测试为 0；SEC-01~10 全部通过
- [ ] 确定性混沌车道（≥ 200 个种子）全绿；水位线恢复用例（REC）全部通过
- [ ] 冷启动 P50 < 5 秒、P95 < 15 秒；单 worker 50 并发会话稳定运行 1 小时
- [ ] 单机 compose 一键部署文档，在全新机器上 30 分钟内部署完成
- [ ] 备份恢复演练通过

---

## 5. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- |
| OpenSandbox execd 不支持长连接 stdio | 中 | 中 | stdio-bridge 或 DockerProvider 兜底（M0 决策） |
| Codex app-server 协议变化快（每周发版） | 高 | 中 | pin 版本、生成类型 + `--check`、golden 门禁、按会话固定 digest 并灰度（spec §8.4） |
| 企业模型不兼容 Responses API，或工具调用质量差 | 中 | 高 | gateway 转换层；M0 用 10 个任务评测；必要时限定使用 OpenAI/Azure |
| gVisor 性能开销（I/O 密集的构建任务） | 中 | 中 | 按 Environment 可选 Kata；对 workspace 卷使用 overlay 优化 |
| 内置工具与 Managed Agents 工具集语义不一致 | 高 | 低 | 声明方言差异；用审批粒度兜底；在验收用例中标注 |
| PG NOTIFY 扇出瓶颈 | 低 | 中 | EventBus 抽象，提前准备 Redis Streams 实现 |
| 沙箱快照体积大（node_modules） | 中 | 低 | zstd 压缩、排除缓存目录、按 Environment 设置配额 |
| 4 人团队范围过大 | 中 | 高 | 二期功能坚决后置；M3 与 M4 并行时 Q 优先保障验收 |
| v0.2 新增的可靠性机制（execution fencing、checkpoint CAS、水位线、CredentialEgress）增加 M2–M4 工作量 | 高 | 中 | 按 OpenMA 的 ADR 与测试用例直接对照实现，降低设计成本；混沌车道在 M3 第一周搭建好，后续每个机制都带着种子用例合入；工作量超出时，op journal（3.11）可以推迟到 M5 |
| Codex rollout 在 checkpoint 恢复后不可用 | 中 | 中 | M0 的 0.10 实测；不可用时 Level 1 只用于"同一沙箱暂停后恢复"，跨宿主一律走 Level 0 |

---

## 6. 与开源项目的关系

| 项目 | 关系 |
| --- | --- |
| `codex app-server` | 运行时依赖（pinned） |
| OpenSandbox | 运行时依赖（可替换） |
| gVisor | 宿主依赖 |
| mosoo / mosoo-agent-driver | **仅作参考**：设计 checklist（帧上限、背压、wire 顺序、resume 兜底、审批竞态）、测试场景；移植的代码片段保留 Apache-2.0 NOTICE |
| E2B Embed / agent-sandbox | 备选 SandboxProvider（二期 PoC） |
| **open-managed-agents（OpenMA）** | **首要设计参考**（ADR 0005/0006/0007、ORDERING_DESIGN、recovery 规则、混沌测试方法）+ **备选底座**（M0 的 0.9 PoC 决定是否 fork）；二期 `AcpDriver` 和 `/openai/v1` 兼容层可以参考其 Apache-2.0 代码，移植时保留 NOTICE |
