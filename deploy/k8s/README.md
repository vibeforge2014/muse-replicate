# k3s 部署（单节点）

与 `deploy/compose/` 等价的 Kubernetes 形态（spec §18.1 单机拓扑）。
适合已有 k3s/K8s 的环境；docker-compose 仍是零依赖路径。

## 前置

- k3s（或任意单节点 K8s ≥1.30，默认 StorageClass 支持 PVC——k3s 自带 local-path）
- 国内网络：`/etc/rancher/k3s/registries.yaml` 给 docker.io 配加速器
- 镜像：本仓库根 `Dockerfile` 构建后导入 k3s containerd（无镜像仓库时）：

```bash
docker build -t mas-server:latest .   # 同一镜像跑 server 与 worker（command 覆盖）
docker save mas-server:latest | sudo k3s ctr images import -
```

- MinIO 镜像（加速器常缺 `minio/minio`）：可在有网机器 `docker pull` 后同样 `save | import`；
  镜像架构与节点不一致时 `apt install qemu-user-static binfmt-support` 后内核 binfmt 会透明转译
  （本单节点 amd64 + arm64 镜像实测可跑，仅性能损耗）

## 部署

```bash
k3s kubectl apply -f deploy/k8s/
k3s kubectl -n mas logs deploy/mas-server | grep "API key"   # bootstrap 密钥只显示一次
BASE_URL=http://<node-ip>:30080 MAS_API_KEY=<key> ./scripts/smoke.sh
```

- API：NodePort 30080；Grafana：NodePort 31300（admin/admin，首登改密）；MinIO：API 30900 / Console 30901
- Prometheus 抓取 `mas-server:8080/internal/metrics`（mas 命名空间内 Service）
- **对象存储走 MinIO**（`55-minio.yaml`）：server/worker 以 `MAS_OBJECT_STORE=s3` 直连
  `minio.mas.svc.cluster.local:9000`，bucket `mas-objects`（首访问自动建）。checkpoint（`snapshots/`）、
  File/技能内容（`files/`、`skills/`）、输出（`outputs/`）全部对象化，Pod 重建不丢；
  `20-shared-pvc.yaml` 的 PVC 保留为 `MAS_OBJECT_STORE` 未设时的 FS 回退路径
- server 为单副本（进程内 Deployments/Webhook 调度器为单实例假设，OPS §1）；worker 可水平扩副本（SKIP LOCKED claim 天然安全）

## 组件

| 文件 | 内容 |
| --- | --- |
| 00-namespace.yaml | mas 命名空间 |
| 10-postgres.yaml | StatefulSet + 10Gi PVC + Service（mas_dev，trust——生产改 secret + TLS） |
| 20-shared-pvc.yaml | mas-files / mas-snapshots 共享卷（FS 存储模式的回退路径） |
| 30-server.yaml | Deployment（就绪探针 /internal/metrics）+ Service(30080)，S3 env 指向 MinIO |
| 40-worker.yaml | Deployment（MAS_WARM_POOL_MIN 可开），S3 env 与 server 一致 |
| 50-observability.yaml | Prometheus（抓取配置在 ConfigMap）+ Grafana（看板自动供给，31300） |
| 55-minio.yaml | MinIO StatefulSet（20Gi local-path）+ Service（集群内 9000；NodePort 30900/30901 供外部测试/Console） |
