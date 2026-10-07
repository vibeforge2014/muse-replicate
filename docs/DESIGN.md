# 设计与实现说明（DESIGN）

> 本文档是工程视角的落地记录：能力矩阵（对应 test-case-plan 的验收编号）、关键设计与 spec 章节的映射、
> 已知偏差（务实取舍）与路线状态。对外概览见 [README](../README.md)；完整规格见 [spec.md](../spec.md)、
> 执行计划见 [plan.md](../plan.md)、验收用例见 [test-case-plan.md](../test-case-plan.md)。

## 能力矩阵（验收编号对照）

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
| 鉴权 / 错误信封 / request-id / 限流 | ✅ | 方言检测（zai-* / anthropic-*），BigModel 409 → invalid_request_error（§11.1）；限流可切 PG 后端（`MAS_RATELIMIT_BACKEND=pg`，RL-PG-01~03） |
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
| SandboxProvider 抽象 | ✅ | capabilities 协商 + create/pause/resume/destroy 生命周期 + sandbox_orphans 登记/reconcile（§9.0/§9.3）；FakeSandboxProvider（开发/测试）与 DockerProvider（runsc + CapDrop ALL + no-new-privileges + internal 网络 + 资源限额，§9.1） |
| egress-proxy | ✅ | 出站授权 token（HMAC，绑定 fence，exp≤租约×2）、fence 4s 缓存校验、平台黑名单、limited/unrestricted 主机策略、凭据注入（剥离竞争头 + 占位符替换）、403 + x-mas-denied-host + `session.error{egress_denied}` 限频（§10.2/§10.4） |
| 幂等全量（M5） | ✅ | POST agents/environments/sessions/vaults/credentials/events 全部支持 Idempotency-Key（同 key 同 body 回放、异 body 409） |
| 指标与调试（M5） | ✅ | `GET /internal/metrics`（Prometheus 文本：请求计数/延迟/会话 gauge/SSE 连接/egress 拒绝）；`GET /internal/sessions/:id/debug`（内部事件 + runtime/checkpoint/output 全景）；`MAS_INTERNAL_TOKEN` 门禁 |
| 运维手册（M5） | ✅ | [docs/OPS.md](docs/OPS.md)：部署形态、备份恢复、runtime 升级、故障排查表、告警建议 |
| model-gateway（§10.3） | ✅ | Responses API 兼容 `POST /v1/responses`（流式 SSE 透传）；会话 token（`masmt_v1`，HMAC）鉴权后转发上游并注入真实 API key；从非流式/流式 `response.completed` 提取 usage 回写 `span.model_request_start/end{model_usage}` + 累计 `session.usage`；`mas_model_tokens_total{model,kind}` 指标 |
| 确定性混沌车道（M3 3.9） | ✅ | 种子化（mulberry32）3 owner 并发真实 db 函数（claim/renew/append/checkpoint/output/settle + 双收/租约强过期/陈旧 fence 写）；六不变量逐步断言；`pnpm test:chaos [N]` 发布门禁（spec §17.2），种子固定可复现 |
| Memory Store（M6 W11） | ✅ | 版本化键值树：store/memory/version 三表、precondition（content_sha256）更新、历史版本 redact、path_prefix/depth/view=full 列表（memory_prefix 元素）；会话挂载物化到 `/mnt/memory/<slug>`——read_only chmod 只读、read_write 轮末 diff 回写新版本（MEM-01~08 / SES-10） |
| Skills（M6 W12） | ✅ | multipart zip 上传 → 规范化（剥公共根、越界剔除、200 文件上限静默截断）→ 版本化存储与下载；目录名冲突 409 `skill_directory_conflict`；agent.skills 引用（归档版本保留引用，删除受 409 保护）；会话挂载物化到 `/workspace/skills/<dir>/`（只读）；bootstrap 播种 source=zai 内置（SKL-01~07） |
| Deployments（M6 W12） | ✅ | 5 字段 cron（自研引擎：≥5min 间隔、必须有未来触发点、时区固定 Asia/Shanghai）+ manual-only；agent 版本创建时固定；手动 run 202 → 调度器建会话投首轮 → 跟随 session 收尾；pause 不拦手动 run、归档幂等且拒 run；环境归档 → run 失败带 error；归档 agent 联动归档其 deployments；runs 过滤（deployment_id/has_error/trigger_type/created_at，limit 50）（DEP-01~09） |
| Webhooks（M6 W13） | ✅ | 订阅会话事件 → outbox（webhook_deliveries）→ Standard Webhooks 签名投递（webhook-id/timestamp/signature v1 HMAC-SHA256）；非 2xx 指数退避重试（2^n 秒，6 次后 failed）；events 订阅过滤；secret（whsec_）仅创建时回显；投递状态 API 可观察 |
| Fake Codex runtime | ✅ | JSON-RPC over stdio 的脚本化假 app-server（plan 1.9），支撑全部集成测试；`out <text>` 模拟沙箱产出、`tool <n> <j>` 模拟自定义工具调用 |
| Custom tools（二期 PoC） | ✅ | agent.tools 声明 `{type:"custom", name, input_schema}`（normalizeAgentTools 保留）→ runtime 调用产生 `agent.custom_tool_use` + idle(requires_action) → 业务方回 `user.custom_tool_result`（§7.3 例外：api 即时定序，响应即带 processed_at）→ worker kind=custom_tool_result 经 `item/customToolOutput` 续轮；requires_action 中断时未决 custom tool 作废（CT-01~05） |
| multipart 幂等（偏差 #10 收尾） | ✅ | files / skills / skills-versions 上传接入 Idempotency-Key：路由解析 multipart 后以显式指纹（文件名+内容 sha256+字段 / 规范化文件集哈希）参与同 key 同 body 判定（IDEM-M-01/02） |
| OpenAPI 3.1 规范 + TS SDK（plan 5.7） | ✅ | [docs/openapi.yaml](docs/openapi.yaml)：74 条 /v1 路由（与 fastify 注册表零漂移，双向断言）、BigModel 方言 headers（zai-version/zai-beta）、Bearer/x-api-key 双鉴权、统一错误信封；`pnpm gen:sdk` 生成类型 + `@mas/sdk` MasClient（错误信封→MasApiError、幂等键、multipart、SSE/二进制下载） |
| Warm pool（M6 W13 最小实现） | ✅ | `WarmPoolProvider` 装饰器：预建 N 个空沙箱，create 快路径迟绑定（`attach`）+ 池空直落冷创建 + 串行后台补池（防过填/风暴）；worker `MAS_WARM_POOL_MIN` 开关；Fake provider 的 attach = §9.2 目录重物化（真实 provider 需挂会话卷，K8s CRD 二期） |

未实现（按 plan 后续里程碑）：egress 的 HTTPS/TLS 终止与 worker 侧 prepare/attach/revoke 全生命周期接线（真实沙箱宿主接入时落）、OpenSandbox provider、OTel 链路 / Grafana 看板 / k6 性能压测（M5 5.2/5.3 的重型件，需专门基础设施）、K8s agent-sandbox CRD（provider 侧）/ multiagent lanes / outcomes（M6 后续与二期）。当前 runtime 用 `FakeCodexDriver`（本机子进程）替代沙箱内的 `codex app-server`，`AgentRuntimeDriver` 接口与 spec §8.1 一致，可替换。

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
- **沙箱 provider**（§9）：`SandboxProvider` 是 worker 与沙箱实现的唯一边界——`capabilities()` 供 §9.0 fail closed 协商（Fake 声明式，Docker 探测 runsc runtime 后如实上报）；`create()` 落 §9.2 目录约定（DockerProvider 挂载 `/session/.codex`、`/mnt/session/outputs`、只读 uploads）；强杀失败记 `sandbox_orphans`（不含 fence token，reaper 只能销毁不能发布状态）。
- **egress-proxy**（§10.2/§10.4）：沙箱 `http_proxy` 指向本服务，`proxy-authorization` 携带出站 token（HMAC 签名，claims 绑定 workspace/session/execution/generation/sandbox，签发走 `POST /internal/bindings` + 管理密钥）。每请求：token 验签/时效 → fence 时效（generation 数值比较，4s 缓存）→ 黑名单（元数据服务/RFC1918）→ 凭据命中（先按会话 `vault_ids` 缩小候选再按 host 匹配，剥离 `authorization`/`x-api-key` 后注入真实值，占位符 `mas_ph_*` 永不出代理）→ env networking（limited 按 allowed_hosts 通配、unrestricted 仅 80/443）；拒绝带 `x-mas-denied-host`，`session.error{egress_denied}` 同 host 每分钟至多一条。
- **水位线恢复**（§14.2.1）：接管方 acquire runtime 时判定 —— `active_workspace_checkpoint.completed_execution_watermark === sessions.last_completed_execution_id` 且 `codex_version_digest` 一致 → **Level 1**（restoreCheckpoint 还原文件 + `thread/resume` 原生续聊）；否则（checkpoint 缺失/落后/损坏）→ **Level 0** 语义恢复：从事件日志重放 `user.message`/`agent.message` 文本（绝不重放工具输入），写内部事件 `runtime.recovered{mode, reason}`；checkpoint 校验失败额外写 `session.error{checkpoint_corrupt}`。
- **model-gateway**（§10.3）：`POST /v1/responses`（Responses API 兼容，流式 SSE 透传）。会话侧只持 `masmt_v1` 短期 token（claims：ws/sesn/exp/jti，`POST /internal/tokens` 凭管理密钥签发）；网关验签后剥离会话凭证、注入上游真实 API key 转发；从响应（非流式 JSON 或流式 `response.completed` 帧）提取 usage，以 API 身份回写 `span.model_request_start/end{model_usage, is_error}` 与累计 `session.usage`（物化 `sessions.usage`）；`GET /internal/metrics` 暴露 `mas_model_tokens_total{model,kind}`。
- **OpenAPI 规范即契约**（plan 5.7）：手写 docs/openapi.yaml + `app.addHook("onRoute")` 登记路由表，tests/openapi.test.ts 双向断言零漂移（fastify 有而规范无 = 失败；规范有而 fastify 无 = 失败）；生成物 schema.d.ts 与规范的同步性同样有测试守护（改规范忘 gen:sdk 即红）。
- **Warm pool 迟绑定**（§9.3 二期）：预热沙箱以占位 spec（sessionId=warmup、临时宿主目录）预建；acquire 时 `attach(sandboxId, realSpec)` 绑定会话目录——Fake provider 下即目录约定重物化，真实 provider（Docker/OpenSandbox/K8s）应挂会话卷；补池走串行 promise 链（构造预热/出池补池/prewarm 同队列），杜绝并发过填。
- **确定性混沌车道**（§5.20 / M3 3.9）：mulberry32 种子化随机驱动 3 个 owner 并发执行真实 db 函数（claim/renew/append/checkpoint/output/settle），动作含重复收集（幂等）、租约强过期（重写 `lease_expires_at` 模拟时钟推进）、陈旧 fence 写入（必须被 409 拒绝）；每步后断言六不变量：陈旧 fence 写拒、seq 连续、active checkpoint 可校验、输出无重复、接管语义、settle 后可恢复。`pnpm test:chaos [N=200]` 为发布门禁（§17.2），种子固定可复现。
- **Memory Store**（plan M6 W11 / §19）：store（name→slug，workspace 内唯一）→ memory（`(store, path)` 唯一）→ memory_versions（每次写入追加，`head_version` 指针）。precondition 更新按 head `content_sha256`（不一致 409），条件删除同理；redact 只允许历史版本（head 409），redact 后 path/content/sha 置 null；list 支持 `path_prefix`/`depth`（深层折叠为 `memory_prefix` 元素）/`view=full`（limit ≤20）。会话以资源形态挂载（上限 8 个）：worker 每轮把 head 版本物化到 `<home>/mnt/memory/<slug>`（read_only 挂载 chmod 555/444，agent 写入 EACCES；read_write 挂载轮末 diff 回写新版本，并发以 precondition 乐观锁让位）。
- **Skills**（plan M6 W12 / §19）：上传 zip → `normalizeSkillZip`（剔绝对路径/`..` 段、剥公共根目录、path 排序后 200 文件截断、根必须有 SKILL.md）→ 重打包内容寻址存储 `skills/{id}/v{n}.zip`。`(workspace, directory)` 唯一（409 `skill_directory_conflict`）；`agent.skills` 引用随版本快照固化，删除 skill 前查全部 `agent_versions.config->skills`（历史版本保留引用即拒绝）；会话资源挂载（可 pin 版本）由 worker 物化到 `<home>/workspace/skills/<dir>/` 并 chmod 只读；bootstrap 幂等播种 `source=zai` 内置。
- **Deployments**（plan M6 W12）：自研 5 字段 cron（分钟步进求值，Asia/Shanghai 固定 UTC+8）：可解析 + 存在未来触发点 + 连续触发间隔 ≥5min 才接受。创建时 `agent_version` 固定为当前 head；`upcoming_runs_at` 按 cron 实时计算（paused/archived 为空）。调度 tick 三步：schedule 到点补 run（以 `last_scheduled_at` 为锚，每次至多一个）→ pending run 校验 env/agent 后建会话并 `admitEvents` 投首轮（`input.message`）→ running run 跟随 session（`stop_reason` 非空才算收尾，避免把未认领的新会话误判完成）。归档 agent 联动归档其 deployments。
- **Webhooks**（plan M6 W13 / §19）：事件写入路径（`appendEvent`/`appendApiEvent`，事务外尽力而为）按订阅过滤入 outbox；分发器 POST `{id, type, timestamp, data}` 并带 Standard Webhooks 头——`webhook-signature: v1,base64(HMAC-SHA256(base64decode(whsec_...), "${id}.${ts}.${body}"))`；非 2xx/网络错误按 2^attempts 秒退避重试，6 次后 failed；secret 仅创建响应回显一次。

## 与规格的已知偏差（务实取舍）

1. runtime 为 FakeCodexDriver（本机子进程 + `/tmp` rollout），非沙箱内 `codex app-server`；协议形态一致（initialize/thread/start/turn/start/item/*/turn/completed），替换真实 driver 不动 worker。
2. api 在 `requires_action` 等状态下可能从快照读 stop_reason 而非事件推导（物化视图已同步维护）。
3. ~~限流为单进程内存令牌桶；多实例部署需换 PG/Redis（spec §13.4 预留）~~ 已收尾：`MAS_RATELIMIT_BACKEND=pg` 切换为 `rate_limit_buckets` 行锁令牌桶（事务内 FOR UPDATE 串行化、elapsed 由 DB 时钟计算——多实例时钟偏移免疫、DB 故障 fail-open）；默认仍为 memory（单实例零开销）。
4. checkpoint 归档格式为 `json.gz/v1`（文件集 gzip JSON）而非 spec 的 tar.gz；对象存储为本地 `FsSnapshotStore` 而非 S3（`SnapshotStore` 接口已抽象，替换实现即可）。
5. File 内容与 output 对象存本地 FS（`MAS_FILES_DIR`，默认 `/tmp/mas-files`）而非 MinIO；Key 布局与 spec 一致（`files/{org}/{file_id}`、`outputs/{session}/{sha256}`），换 S3 实现即可。
6. egress-proxy MVP 只处理 HTTP 绝对 URI 形态（无 CONNECT/TLS 终止）；真实部署需镜像预置企业 CA、代理按 SNI 签发证书（§10.1）。worker 侧 prepare/attach/revoke 生命周期接线随真实沙箱宿主落地。
7. DockerProvider 通过 docker CLI 驱动（非 dockerode）。**gVisor 路径已在真实宿主验证**（Debian 13 / 内核 6.12 / docker-ce 29.8.2 + runsc 20260928，容器真实运行于 runsc，全生命周期 4/4）；runc 降级路径亦已实测（Synology DSM，无 runsc 宿主：create 走默认 runtime、capabilities 如实上报 `runc`，§9.0 不虚报）。runsc 2026+ 为 sidecar 布局（gvisor-bin/ 目录需一并安装）；gVisor directfs 下宿主目录 DAC 对容器 root 生效（bind mount 目录需正常 umask）；DSM 宿主可能静默丢弃 pids-limit（未挂 pids cgroup 控制器），属内核能力差异。
8. 沙箱能力协商目前 FakeSandboxProvider 为声明式（`MAS_SANDBOX_ISOLATION`/构造参数），DockerProvider 已按 runsc 探测如实上报。
9. agent 事件 `span.model_request_*`/`session.usage` 经 model-gateway 落账（§10.3：网关在响应完成时以 API 身份回写 span 与累计 usage，并物化 `sessions.usage`）；FakeCodexDriver 不调用模型，计量验收用例直接驱动 gateway。指标端点为单进程聚合，多实例部署需加 Prometheus 联邦或 pushgateway。
10. ~~文件上传（multipart）暂未接 Idempotency-Key~~ 已收尾：路由解析 multipart 后用显式指纹（文件名+内容 sha256+表单字段）代替原始流哈希，同 key 同内容回放、异内容 409（IDEM-M）。
11. 混沌车道中的“租约过期”通过重写 `lease_expires_at` 模拟（SQL 时钟无法虚拟化），其余动作全部走真实 db 函数。
12. Memory Store 内容存 PG（单条 ≤100 KiB，符合验收上限），未拆对象存储；read_write 挂载的回写是轮末 diff——worker 在 agent 写入与回写之间崩溃会丢该轮记忆写入（真实部署用沙箱内 watcher 实时上报）；agent 删除文件不产生版本 tombstone。read_only 的强只读靠 chmod（555/444），root 进程可绕过（真沙箱内由 gvisor/rootfs 保证）。
13. Deployments 的 cron 时区按平台方言硬编码 Asia/Shanghai（UTC+8 无夏令时，直接偏移求值）；deployment/webhook 两个调度器为 api 进程内 setInterval（单实例假设），多实例部署需加选主或拆独立 scheduler 进程；schedule 到点的补跑以 `last_scheduled_at` 为锚每次一个 tick 至多补一个 run（暂停期不累积风暴）。
14. Webhook secret（whsec_）以明文存 PG（签名需要原值；生产建议 KMS 信封加密后存）；投递为单进程串行（每 tick ≤10 条）；outbox 不做死信告警之外的清理。

## 后续路线（按 plan.md）

M3 已完成（checkpoint/水位线恢复 + REC-01~07）→ M4 已完成（Vault/Files/Resources + 输出清单 + REC-08/09/10；SandboxProvider + DockerProvider + egress-proxy）→ M5 已完成可落地件（幂等全量、指标/调试端点、运维手册 docs/OPS.md）→ model-gateway（§10.3，流式计量落账）+ 确定性混沌车道（M3 3.9，`pnpm test:chaos 200` 门禁）已完成（测试 139/139 绿）→ M6 W11-W13 已完成：Memory Store、Skills、Deployments、Webhooks → plan 5.7 已完成：OpenAPI 3.1 规范 + @mas/sdk（74 路由零漂移）、warm pool 最小实现（FakeSandboxProvider 预热池 + attach 迟绑定，MAS_WARM_POOL_MIN 开关）→ custom tools 端到端（CT-01~05）+ multipart 幂等收尾（偏差 #10 关闭）→ PG 限流后端（偏差 #3 关闭，RL-PG-01~03，159 测试全绿）→ 剩余：egress TLS 终止与 worker 生命周期接线、OpenSandbox provider、OTel/k6（需专门基础设施）、K8s CRD provider / multiagent lanes / outcomes。
