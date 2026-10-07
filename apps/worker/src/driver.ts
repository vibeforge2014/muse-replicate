import { CodexDriver, FakeCodexDriver, type AgentRuntimeDriver } from "@mas/runtime";
import {
  DockerProvider,
  FakeSandboxProvider,
  K8sSandboxProvider,
  type SandboxProvider,
} from "@mas/sandbox";

/**
 * 按 MAS_RUNTIME_DRIVER 选择 runtime driver：
 *  - "codex"（默认 fake）：真实 codex app-server（MAS_CODEX_BIN/MAS_CODEX_AUTH_FILE），
 *    消耗登录账号额度，经用户显式开启；
 *  - "fake"：脚本驱动的假 runtime（默认，测试用）。
 */
export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): AgentRuntimeDriver {
  if (env.MAS_RUNTIME_DRIVER === "codex") {
    return new CodexDriver({
      bin: env.MAS_CODEX_BIN,
      authFile: env.MAS_CODEX_AUTH_FILE,
    });
  }
  return new FakeCodexDriver();
}

/**
 * 按 MAS_SANDBOX_PROVIDER 选择沙箱 provider：
 *  - "k8s"：集群内沙箱 Pod（K8sSandboxProvider，runsc RuntimeClass + PVC 工作区）；
 *  - "docker"：宿主 docker（DockerProvider，MAS_DOCKER_PROVIDER_IMAGE）；
 *  - 默认 fake：本机目录（开发/测试）。
 */
export function sandboxProviderFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
  if (env.MAS_SANDBOX_PROVIDER === "k8s") return new K8sSandboxProvider();
  if (env.MAS_SANDBOX_PROVIDER === "docker") {
    return new DockerProvider(env.MAS_DOCKER_PROVIDER_IMAGE ?? "busybox:latest");
  }
  return new FakeSandboxProvider((env.MAS_SANDBOX_ISOLATION as "gvisor" | "microvm" | "runc") ?? "gvisor");
}
