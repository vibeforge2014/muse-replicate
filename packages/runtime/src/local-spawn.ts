import { spawn } from "node:child_process";
import type { StdioProcess, StdioSpawn, StdioSpawnOptions } from "./types.js";

/**
 * 本地 StdioSpawn：包一层 node child_process，行为与旧 spawn 用法一致
 * （env 并入 worker 进程环境，stdio 管道 + stderr 继承）。
 */
export const localStdioSpawn: StdioSpawn = (opts: StdioSpawnOptions): StdioProcess => {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(opts.env)) {
    if (v !== undefined) env[k] = v;
    else delete env[k];
  }
  const proc = spawn(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "inherit"],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env,
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    kill() {
      if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
      else if (proc.exitCode === null) proc.kill("SIGKILL");
    },
    get exited() {
      return proc.exitCode !== null || proc.killed;
    },
    onExit(cb) {
      proc.on("exit", (code) => cb(code));
    },
  };
};
