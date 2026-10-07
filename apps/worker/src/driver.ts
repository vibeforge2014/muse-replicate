import { CodexDriver, FakeCodexDriver, type AgentRuntimeDriver } from "@mas/runtime";

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
