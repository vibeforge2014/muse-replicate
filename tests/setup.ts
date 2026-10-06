import { afterAll } from "vitest";
process.env.MAS_RATELIMIT_BURST = "10000"; // 测试放宽限流
process.env.MAS_LOG = "0";
const { setupEnv } = await import("./helpers.ts");

// 单例环境：所有测试文件共享一个 app + PG（fileParallelism=false）
await setupEnv();

afterAll(async () => {
  const env = await setupEnv();
  // 不关闭：vitest 进程退出时自然释放；关闭会破坏其他文件的缓存引用
  void env;
});
