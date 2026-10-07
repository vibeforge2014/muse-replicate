# 运维手册（MVP）

对应 plan.md M5 5.5。目标读者：部署与值班同学。

## 1. 部署形态

| 组件 | 进程 | 端口（默认） | 说明 |
| --- | --- | --- | --- |
| api | `pnpm dev:server` / compose `api` | 8080 | Fastify，全部 `/v1/*` |
| worker | `pnpm dev:worker` / compose `worker` | – | SessionRunner drain 循环（NOTIFY + 1s 轮询兜底） |
| egress-proxy | `pnpm --filter @mas/egress-proxy start` | 8081（`MAS_EGRESS_PORT`） | 沙箱出网强制点 |
| model-gateway | `pnpm --filter @mas/model-gateway start` | 8082（`MAS_GATEWAY_PORT`） | Responses API 网关：会话 token 鉴权 + 上游 key 注入 + 计量落账（§10.3） |

> api 进程内含两个常驻调度器（单实例假设）：Deployments 调度（`MAS_DEPLOYMENT_TICK_MS`，默认 1s）与 Webhook outbox 分发（`MAS_WEBHOOK_TICK_MS`，默认 1s）。多实例部署需选主或拆独立 scheduler。
| PostgreSQL | compose `postgres` | 5432 | 事件日志 / 队列 / 元数据 |
| 对象存储 | 本地目录（`/tmp/mas-snapshots`、`/tmp/mas-files`） | – | checkpoint 归档与 File 内容；接 MinIO 时换 `SnapshotStore` 的 S3 实现 |

docker compose：`docker compose -f deploy/compose/docker-compose.yml up --build`（宿主端口冲突时 `MAS_PORT=18090` 前缀）。

**k3s/K8s 形态**（`deploy/k8s/`，单节点清单）：`k3s kubectl apply -f deploy/k8s/`。API NodePort 30080、Grafana 31300；server/worker 共享 `mas-files`/`mas-snapshots` PVC（local-path RWO 单节点内多 Pod 可挂）；无镜像仓库时 `docker save mas-server:latest | k3s ctr images import -`；国内网络在 `/etc/rancher/k3s/registries.yaml` 给 docker.io 配加速器。已在 Debian 13 + k3s v1.36 实测（smoke PASS、Prometheus 抓取 up、Grafana 看板自动供给）。注意两点实测坑：k8s 无 depends_on——server/worker 带 initContainer TCP 等 PG；`/internal/metrics` 含 PG 聚合查询，readiness 探针超时需 ≥5s（慢盘宿主）。

部署后验收（对运行实例走一轮真实会话回路 + 指标端点检查）：

```bash
BASE_URL=http://127.0.0.1:18090 MAS_API_KEY=<bootstrap 打印的 key> ./scripts/smoke.sh
```

可观测栈（可选）：`docker compose -f deploy/observability/docker-compose.observability.yml up -d` —— Prometheus 抓取 `mas-server:8080/internal/metrics`（QPS/延迟/会话状态/SSE 连接/出站拒绝），Grafana（`GRAFANA_PORT`，默认 13000，admin/admin 首登改密）自动供给 MAS Overview 看板。已在 Synology DSM（docker 24，无 runsc，runc 降级）实测：指标抓取 up、看板出数。

### 真实宿主实测记录

- **Debian 13（trixie）/ 内核 6.12.111 / 60C Xeon / 59G**（专用机，k3s-node1）：**gVisor 路径已验证**——docker-ce 29.8.2 + runsc 20260928 注册为 runtime，DockerProvider 全生命周期 4/4（capabilities 如实上报 gvisor，容器真实运行于 runsc）。全量测试 + 混沌以非 root 用户通过。
  - 部署形态：compose 主栈（postgres/server/worker，宿主 8080）+ Prometheus/Grafana（13000）+ 测试 PG（127.0.0.1:5433）。
  - runsc 2026+ 为 sidecar 布局：除 `runsc` 外必须安装 tarball 内 `gvisor-bin/`（gvisor_sentry 等）到 `/usr/local/bin/gvisor-bin/`，否则容器启动报 `sidecar "gvisor_sentry" not usable`。
  - 国内网络：daemon.json 配华为云镜像加速；**docker-ce 29 默认的 containerd-snapshotter 拉取路径会让 referrers API 绕过加速器直连 dockerhub 超时**，需 `"features": {"containerd-snapshotter": false}` 回经典 overlay2 路径；git 走局域网 clash 代理（`git config --global http.https://github.com.proxy`）。
  - **测试/worker 不要以 root 运行**：root 绕过 read_only 挂载的 chmod（偏差 #12），且 gVisor directfs 下宿主目录 DAC 对容器 root 同样生效（bind mount 目录需正常 umask 755，勿用 mkdtemp 0700）。
  - 并发启动（server+worker 同时起）曾撞 CREATE TYPE 唯一键：runMigrations 已加 advisory lock 串行化（tests/migrations-concurrent.test.ts 回归）。
- **Synology SA6400 / DSM 7.2.1 / docker 24.0.2 / 4C 7.4G**：全量测试 159/159 + 混沌 200/200（真实 Linux + 容器 PG）；compose 全栈（postgres+server+worker）+ Prometheus/Grafana 运行中；DockerProvider 生命周期 4/4（runc 降级路径）。
- 该内核**未开 user namespaces，gVisor 不可用**（`/proc/self/uid_map` 不存在，runsc 硬依赖）；另未挂 pids cgroup 控制器（`--pids-limit` 被 daemon 静默丢弃）。gVisor 验证需标准 Linux 内核宿主（已在上方 Debian 13 主机完成）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | – | PG 连接串 |
| `MAS_SNAPSHOT_DIR` | `/tmp/mas-snapshots` | checkpoint 归档根目录 |
| `MAS_FILES_DIR` | `/tmp/mas-files` | File 内容 / 输出对象根目录（api 与 worker 必须一致） |
| `MAS_MASTER_KEY` | 开发默认（**生产必设**，64 位 hex） | 机密信封加密主密钥 |
| `MAS_EGRESS_SECRET` | 开发默认（**生产必设**） | 出站 token 签发/验签密钥 |
| `MAS_GATEWAY_SECRET` | 开发默认（**生产必设**） | model-gateway 会话 token（`masmt_v1`）签发/验签密钥 |
| `MAS_UPSTREAM_BASE_URL` | `https://api.openai.com` | model-gateway 上游（Responses API 兼容） |
| `MAS_UPSTREAM_API_KEY` | – | model-gateway 注入上游的真实 API key（永不下发给会话侧） |
| `MAS_INTERNAL_TOKEN` | 未设置=开放 | `/internal/*`（metrics/debug）的门禁 |
| `MAS_SANDBOX_ISOLATION` | `gvisor` | Fake provider 声明的隔离等级（协商用） |
| `MAS_WARM_POOL_MIN` | `0`（关） | worker 预热池保温数量（spec §9.3）：>0 时沙箱 create 走快路径（预建空沙箱 attach 迟绑定），池空直落冷创建；关停时自动 drain 池内沙箱 |
| `MAS_RATELIMIT_BACKEND` | `memory` | 限流后端：`memory`=单进程令牌桶（零开销，单实例部署）；`pg`=`rate_limit_buckets` 行锁令牌桶（事务 + FOR UPDATE 串行化并发，elapsed 由 DB 时钟计算——多实例时钟偏移免疫，`MAS_RATELIMIT_BURST` 只在测试/本地放宽）；DB 故障时 **fail-open**（可用性优先，warn 日志可观察） |
| `MAS_RATELIMIT_BURST` / `MAS_RATELIMIT_PER_MIN` | – | 限流令牌桶（仅测试/本地放宽用；生产走 spec §11.1 默认值） |
| `MAS_RUNTIME_DRIVER` | `fake` | worker 的 runtime driver：`fake`=FakeCodexDriver（脚本化假 runtime，零额度消耗）；`codex`=真实 codex app-server（CodexDriver） |
| `MAS_CODEX_BIN` | `codex`（PATH） | 真实 driver 的 codex 可执行文件路径（如 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`） |
| `MAS_CODEX_AUTH_FILE` | `~/.codex/auth.json` | 每会话 CODEX_HOME 复制的登录凭据来源（存在才复制；机密绝不进 checkpoint 归档） |
| `HTTPS_PROXY` / `HTTP_PROXY` | – | codex 后端（chatgpt.com）可达性；受限网络下 worker 进程需可出站代理 |

## 2. 备份与恢复

- **PG**：`pg_dump`（逻辑备份即可；事件日志是唯一事实来源；Memory Store 内容也存 PG，一并覆盖）。恢复后 worker 自动从
  `session_executions` 恢复：过期租约被接管（REC-01 语义），checkpoint/output 指针来自
  `sessions.active_workspace_checkpoint` / `active_output_manifest`。
- **对象目录**：冷备 `MAS_SNAPSHOT_DIR` 与 `MAS_FILES_DIR`。checkpoint 归档带 sha256，
  恢复后损坏会被 `restoreCheckpoint` 校验出来并降级 Level 0（REC-05）。
- **主密钥**：`MAS_MASTER_KEY` 丢失 = 全部 credential 不可解。离线保管（KMS/Vault）。

## 3. Codex / runtime 升级

1. 新版本 digest 变化 → 存量会话恢复时自动走 Level 0 语义恢复，并写
   `session.error{type:"runtime_upgraded", retry_status:"retrying"}`（spec §8.7，REC-10 已验收）。
2. 回滚：把 worker 的 runtime 版本回退即可，水位线一致的会话继续 Level 1 原生恢复。
3. 真实 driver（`MAS_RUNTIME_DRIVER=codex`）：digest 取 `codex --version`（`codex@<ver>`），CLI 升级同样触发上述降级。
   真实 E2E 需显式开启（消耗登录账号额度）：
   `MAS_CODEX_E2E=1 MAS_CODEX_BIN=<codex> [MAS_CODEX_MODEL=gpt-6.1-sol] [HTTPS_PROXY=...] npx vitest run tests/codex-driver-e2e.test.ts`。

## 4. 常见故障排查

| 症状 | 排查 |
| --- | --- |
| 会话一直 running | `GET /internal/sessions/{id}/debug` 看 executions：`claimed/delivered` 且租约过期 → worker 存活？`attempt_count` 接近 `max_attempts`（5）说明毒任务，耗尽后自动 `idle(retries_exhausted)` |
| `session.error{checkpoint_corrupt}` | 对象存储里归档被改写/损坏；系统已降级语义恢复，可核对 `workspace_checkpoints.state=corrupt` |
| `session.error{egress_denied}` | 主机不在 allowed_hosts / 命中黑名单 / token 过期（execution 已换代）。按 `x-mas-denied-host` 对应处理 |
| `capability_unsatisfied` | 环境 `config.isolation` 高于 provider 实际等级——按 §9.0 这是 fail closed，不允许静默降级；要么升级宿主要么显式放宽环境 |
| SSE 无输出 | 先 `GET events` 确认事件已定序（有 seq）；SSE 默认只推实时 |
| 响应 409 `idempotency_conflict` | 同一 Idempotency-Key 配了不同 body |
| deployment run 一直 pending | api 进程调度器未起（`MAS_DEPLOYMENT_TICK_MS`）或环境被归档（看 run 的 `error.type=start_failed`） |
| webhook 投递 failed | `GET /v1/webhooks/{id}/deliveries` 看 `attempts`/`last_status_code`；6 次退避（2^n 秒）后转 failed，接收端需 2xx；secret 仅创建时可见，丢失需重建 webhook |

## 5. 指标与告警建议

`GET /internal/metrics`（Prometheus 文本）：

- `mas_api_requests_total{route,code}`：5xx 比例告警；
- `mas_api_latency_seconds_*`：P99 告警；
- `mas_sessions{status}`：`running` 长期堆积 → worker 容量/毒任务；
- `mas_egress_denied_total`：突增 → 沙箱内异常出网尝试。

model-gateway 另有 `GET /internal/metrics`：`mas_model_tokens_total{model,kind}`（input/output/cached 累计），按模型核对上游账单。

未在本 MVP 实现的观测项（OTel 链路、Grafana 看板、告警规则文件）见 README「后续路线」。
