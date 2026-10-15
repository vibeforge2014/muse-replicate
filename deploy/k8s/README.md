# k3s 部署（单节点）

与 `deploy/compose/` 等价的 Kubernetes 形态（spec §18.1 单机拓扑）。
适合已有 k3s/K8s 的环境；docker-compose 仍是零依赖路径。

## 多节点注意（local-path 卷的节点局部性）

local-path PV 绑死在首个调度的节点上。多节点集群里 MAS 的共享卷（files/snapshots/
sandboxes/egress-ca）必须同节点，否则沙箱 Pod 挂不到 worker 写入的会话目录。两种做法：

1. **把 MAS 工作负载钉到同一节点**（本仓库实测形态，单机够用）：

```bash
for d in mas-server mas-worker mas-egress prometheus; do
  kubectl -n mas patch deploy $d --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/nodeSelector","value":{"kubernetes.io/hostname":"<节点名>"}}]'
done
```

2. 换网络存储 StorageClass（NFS/Ceph），manifest 无需改动。

镜像若不走仓库而是 `save | import`，import 得打进**每个**可能调度 MAS/沙箱 Pod 的节点
（沙箱 Pod 挂 sandboxes PVC，会被卷亲和自然约束到同一节点）。另外集群上跑着其他业务时，
本目录所有对象都在 `mas` 命名空间内，apply/删除不影响其他业务。

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
| 40-worker.yaml | Deployment（MAS_WARM_POOL_MIN 可开），S3 env 与 server 一致；`MAS_SANDBOX_PROVIDER=k8s` + TMPDIR 指到 mas-sandboxes PVC；`MAS_EGRESS_URL` 指向 mas-egress（§10.4 生命周期自动开启）；`MAS_RUNTIME_SANDBOX=inside` + `MAS_K8S_SANDBOX_IMAGE=mas-sandbox:latest`（driver 进沙箱，需先导入沙箱镜像，见下） |
| 45-egress.yaml | egress-proxy Deployment + Service(8081) + mas-egress-ca PVC（CA 落盘，重启不换根）；单副本（revoke denylist 在内存，权威吊销是逐请求 fence 检查） |
| 50-observability.yaml | Prometheus（抓取 mas-server/mas-egress + 告警规则 ConfigMap）+ Grafana（双看板自动供给，31300） |
| 55-minio.yaml | MinIO StatefulSet（20Gi local-path）+ Service（集群内 9000；NodePort 30900/30901 供外部测试/Console） |
| 56-sandbox-rbac.yaml | mas-sandboxes PVC + mas-worker ServiceAccount/Role（沙箱 Pod 管理 + pods/exec（inside 模式 driver 通道）+ NetworkPolicy 下发） |

## 沙箱（K8sSandboxProvider）

worker `MAS_SANDBOX_PROVIDER=k8s` 时沙箱 = 集群内 Pod（`packages/sandbox/src/k8s-provider.ts`）：

- **runsc（gVisor）**：节点侧两步（一次性，root）：
  1. 安装 gVisor（runsc + containerd-shim-runsc-v1 + gvisor-bin/ sidecar 目录，均放 `/usr/local/bin`）；
  2. k3s containerd 注册 runtime——在 `/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl` 末尾追加
     （**containerd 2.x 插件名是 `io.containerd.cri.v1.runtime`**，老文档的 `io.containerd.grpc.v1.cri` 不生效）：

     ```toml
     [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
       runtime_type = "io.containerd.runsc.v1"
       [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc.options]
         BinaryName = "/usr/local/bin/runsc"
         SystemdCgroup = true
     ```

     然后 `systemctl restart k3s` 并 `kubectl apply -f -` 创建 RuntimeClass `{apiVersion: node.k8s.io/v1, kind: RuntimeClass, metadata: {name: runsc}, handler: runsc}`。
     注意：**不要**用 `io.containerd.runc.v2` + BinaryName=runsc 的方式——能启动但 StopPodSandbox 会挂死
     （runsc 不实现 runc shim 的停止语义，实测 Debian 13 / containerd 2.x / runsc release-20260928）。
  3. 验证：`kubectl run` 一个 `runtimeClassName: runsc` 的 busybox Pod，`kubectl exec ... -- cat /proc/version`
     应输出 `4.19.0-gvisor`（删除应在数秒内完成）。
- **多节点**：只有装了 runsc/镜像的节点能跑沙箱——给节点打标 `kubectl label node <n> mas-sandbox=true`，
  worker/测试设 `MAS_K8S_NODE_SELECTOR=mas-sandbox=true`（provider 把它作为 Pod nodeSelector；
  local-path PVC 本身也把 worker 与沙箱钉在 PV 所在节点）。
- **工作区共享**：worker `TMPDIR=/var/mas/sandboxes`（PVC 挂载点）→ 会话 home 落 PVC；
  沙箱 Pod 以 subPath 绑定同 PVC 的会话子目录（/session/.codex、/mnt/session/outputs）。
- **driver 进沙箱（inside 模式，spec §8.4）**：worker `MAS_RUNTIME_SANDBOX=inside` 后 runtime 进程
  （codex app-server / fake-codex.mjs）经 pods/exec WebSocket 跑在沙箱 Pod 内。前置条件：
  1. 构建+导入沙箱镜像：`docker build --target sandbox -t mas-sandbox:latest .`（含 codex CLI；架构须与节点一致），
     `docker save mas-sandbox:latest | gzip | ssh <node> "gunzip -c - | k3s ctr images import -"`；
  2. worker env `MAS_K8S_SANDBOX_IMAGE=mas-sandbox:latest`（缺省 busybox 无 node/app，inside 起不来）；
  3. 验证：`kubectl exec <sandbox-pod> -- cat /session/.codex/runtime-host.txt`，hostname==Pod 名即进程在容器内。
  host 模式（缺省）不受影响：driver 仍为 worker 本机子进程。
- **pause/resume**：K8s 无容器冻结原语 = 删/建 Pod（目录在 PVC 保留）；销毁失败抛错由 worker 记 sandbox_orphans。
- **egress**：provider 下发 `mas-sandbox-egress-deny` NetworkPolicy（默认拒绝带 `mas-sandbox=true` 标签的 Pod），
  上报 `advisory`（是否强制取决于 CNI，k3s 自带 policy 控制器时生效）——不虚报 enforced（§9.0）。

## 沙箱 CRD 模式（K8sCrdSandboxProvider，`MAS_SANDBOX_PROVIDER=k8s-crd`）

沙箱 = `Sandbox` CR（`agents.x-k8s.io/v1beta1`），由 [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
控制器调和（v1.0.6 实测）。Pod 模板/工作区/runsc/egress 与 k8s 模式完全一致（provider 继承复用），差异：

- **pause/resume = PATCH `spec.operatingMode: Suspended|Running`**（控制器终止/重建同名 backing Pod，
  状态保留在 CR——优于 k8s 模式的显式删建）；resume 遇 CR 已删（如误清理）用 `sessions.sandbox_spec` 重建；
- **destroy = DELETE CR + backing Pod 双确认**（Pod 残留即报错交 sandbox_orphans 反复重试）；
- RBAC：`56-sandbox-rbac.yaml` 已含 `agents.x-k8s.io/sandboxes` 的 create/get/list/delete/patch。

控制器安装（一次性）：

```bash
# 官方 manifest（agent-sandbox-system namespace + controller Deployment + CRD）
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.6/agent-sandbox.yaml
# registry.k8s.io 被墙的节点：在可达外网的机器上经 mirror 拉取再导入（arm64 示例）——
#   docker pull m.daocloud.io/registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.6
#   docker save ... | gzip | scp <node>:... && gunzip -c - | k3s ctr images import -
#   k3s ctr images tag m.daocloud.io/... registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.6
# 镜像只在某节点时，把控制器钉过去：
kubectl -n agent-sandbox-system patch deploy agent-sandbox-controller \
  -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"<node>"}}}}}'
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller
```

卸载：`kubectl delete -f <manifest>`（CRD 一并删除；已有 Sandbox CR 会被级联清理）。
