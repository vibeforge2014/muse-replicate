import { beforeAll, describe, expect, test } from "vitest";
import { chaosStore, fixedSeeds, runChaosSeed } from "./chaos-harness.ts";
import { makeAgentAndEnv, setupEnv, type TestEnv } from "./helpers.ts";

/**
 * 确定性混沌车道（spec §5.20 / §17.2 门禁）：
 * vitest 内跑固定种子子集（快）；全量 200 种子走 `pnpm test:chaos`。
 */

let env: TestEnv;
let ws: string;
let envId: string;
const agentSnapshot = { system: null, model: { id: "glm-5.3-flash" }, tools: [] };

beforeAll(async () => {
  env = await setupEnv();
  ws = (await env.db.db.selectFrom("workspaces").select(["id"]).limit(1).executeTakeFirst())!.id;
  const { envId: e } = await makeAgentAndEnv(env.url, env.key);
  envId = e;
});

describe("CHAOS 确定性混沌（真实实现 + 种子驱动）", () => {
  test.each(fixedSeeds(12))("seed %i：六不变量全程成立", async (seed) => {
    const result = await runChaosSeed(env.db.db, chaosStore(String(seed)), seed, {
      steps: 40,
      workspaceId: ws,
      agentSnapshot,
      environmentId: envId,
    });
    // 基本活性：真实动作确实发生（而不是空转）
    expect(result.steps).toBe(40);
    expect(result.canonicalWrites + result.rejectedStale).toBeGreaterThan(0);
  }, 60_000);

  test("同种子结果可复现（相同动作序列）", async () => {
    const a = await runChaosSeed(env.db.db, chaosStore("rep-a"), 424242, { steps: 30, workspaceId: ws, agentSnapshot, environmentId: envId });
    const b = await runChaosSeed(env.db.db, chaosStore("rep-b"), 424242, { steps: 30, workspaceId: ws, agentSnapshot, environmentId: envId });
    expect(a).toEqual(b);
  }, 60_000);
});
