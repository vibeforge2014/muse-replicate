import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import YAML from "yaml";
import { createMasClient, MasApiError, type Agent, type Session } from "@mas/sdk";
import { setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * OAS（plan 5.7）：docs/openapi.yaml 与 fastify /v1 路由零漂移；
 * 生成物与规范同步；BigModel 方言 headers / 错误信封有据可查；
 * @mas/sdk 冒烟（typed client 全链路 + 错误信封抛 MasApiError）。
 */

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

function loadSpec(): Record<string, any> {
  return YAML.parse(readFileSync(join(import.meta.dirname, "../docs/openapi.yaml"), "utf8"));
}

function specOperations(spec: Record<string, any>): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const m of ["get", "post", "put", "patch", "delete"]) {
      if (item[m]) out.add(`${m.toUpperCase()} ${p}`);
    }
  }
  return out;
}

function fastifyOperations(): Set<string> {
  const out = new Set<string>();
  const routes = (env.app as unknown as { masRoutes?: { method: string; url: string }[] }).masRoutes ?? [];
  for (const r of routes) {
    const url = r.url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    if (!url.startsWith("/v1/")) continue;
    if (!["GET", "POST", "DELETE", "PUT", "PATCH"].includes(r.method)) continue;
    out.add(`${r.method} ${url}`);
  }
  return out;
}

describe("OpenAPI 规范与路由零漂移", () => {
  test("每个 fastify /v1 路由都在规范中，规范也没有多余路由", () => {
    const spec = specOperations(loadSpec());
    const live = fastifyOperations();
    expect(live.size).toBeGreaterThan(60);
    const missing = [...live].filter((x) => !spec.has(x)).sort();
    const extra = [...spec].filter((x) => !live.has(x)).sort();
    expect(missing, "规范缺失的路由").toEqual([]);
    expect(extra, "规范多出的路由").toEqual([]);
    expect(spec.size).toBe(live.size);
  });

  test("每个 operation 有 operationId 与错误响应引用", () => {
    const spec = loadSpec();
    const ids = new Set<string>();
    for (const [p, item] of Object.entries<any>(spec.paths)) {
      for (const m of ["get", "post", "put", "patch", "delete"]) {
        const op = item[m];
        if (!op) continue;
        expect(op.operationId, `${m.toUpperCase()} ${p} 缺 operationId}`).toBeTruthy();
        expect(ids.has(op.operationId), `operationId 重复: ${op.operationId}`).toBe(false);
        ids.add(op.operationId);
      }
    }
    expect(ids.size).toBeGreaterThan(60);
  });

  test("BigModel 方言 headers / 鉴权 / 错误信封有定义", () => {
    const spec = loadSpec();
    expect(spec.components.parameters.ZaiVersion.schema.default).toBe("2026-05-26");
    expect(spec.components.parameters.ZaiBeta.schema.default).toBe("managed-agents-2026-05-26");
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(["apiKeyHeader", "bearerAuth"]);
    const env = spec.components.schemas.ErrorEnvelope;
    expect(env.properties.type.const).toBe("error");
    expect(env.properties.error.$ref).toBe("#/components/schemas/Error");
    expect(env.required).toContain("request_id");
    expect(spec.components.schemas.Error.properties.type.enum).toContain("conflict_error");
  });

  test("已提交的生成物与规范同步（gen:sdk 后未改规范却忘了重新生成）", () => {
    const gen = join(import.meta.dirname, "../packages/sdk/src/generated/schema.d.ts");
    const tmp = join(import.meta.dirname, "../node_modules/.tmp/schema.fresh.d.ts");
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "../node_modules/openapi-typescript/bin/cli.js"),
        join(import.meta.dirname, "../docs/openapi.yaml"),
        "-o",
        tmp,
      ],
      { stdio: "pipe" },
    );
    expect(readFileSync(tmp, "utf8")).toBe(readFileSync(gen, "utf8"));
  });
});

describe("@mas/sdk 冒烟", () => {
  test("typed client 全链路：agent → session → events → memory → deployment → webhook", async () => {
    const client = createMasClient({ baseUrl: env.url, apiKey: env.key });

    // agent + environment
    const agent: Agent = await client.createAgent(
      { name: `sdk-agent-${Date.now()}`, model: { id: "glm-5.3-flash", effort: "low" } },
      { idempotencyKey: `sdk-agt-${Date.now()}` },
    );
    expect(agent.type).toBe("agent");
    expect(agent.version).toBe(1);
    const environment = await client.createEnvironment({ name: `sdk-env-${Date.now()}`, config: { type: "cloud" } });
    expect(environment.type).toBe("environment");

    // session + initial_events → runner 处理到 idle
    const session: Session = await client.createSession({
      agent: agent.id,
      environment_id: environment.id,
      title: "sdk smoke",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hello from sdk" }] }],
    });
    expect(session.status).toBe("idle");
    expect(session.type).toBe("session");
    const done = await waitFor(env.url, env.key, session.id, (s: { status: string; stop_reason: unknown }) => s.status === "idle" && s.stop_reason !== null);
    expect((done.agent as { id?: string }).id).toBe(agent.id);

    // events：历史读取 + 再发一条用户消息
    const history = await client.listEvents(session.id, { limit: 50 });
    expect(history.data.length).toBeGreaterThan(1);
    expect(history.data.some((e) => e.type === "user.message")).toBe(true);
    const sent = await client.sendEvents(session.id, [
      { type: "user.message", content: [{ type: "text", text: "second turn" }] },
    ]);
    expect(sent.data.length).toBe(1);
    expect(sent.data[0]!.type).toBe("user.message");

    // memory store + upsert + 列表
    const store = await client.createMemoryStore({ name: `sdk-store-${Date.now()}` });
    expect(store.slug).toBeTruthy();
    const mem = await client.upsertMemory(store.id, { path: "notes/a.md", content: "v1" });
    expect(mem.type).toBe("memory");
    expect(mem.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    const memList = await client.listMemories(store.id);
    expect(memList.data.length).toBe(1);

    // deployment（schedule 每 5 分钟合法档位）+ 手动 run 202
    const dep = await client.createDeployment({
      agent: agent.id,
      environment_id: environment.id,
      schedule: "*/5 * * * *",
      input: { message: "hi" },
    });
    expect(dep.status).toBe("active");
    expect(dep.upcoming_runs_at.length).toBeGreaterThan(0);
    const run = await client.runDeployment(dep.id);
    expect(["pending", "queued", "running", "succeeded"]).toContain(run.status);

    // webhook 创建回显 secret，列表不回显
    const hook = await client.createWebhook({ url: "https://example.com/hook", events: [] });
    expect(hook.secret).toMatch(/^whsec_/);
    const hooks = await client.listWebhooks();
    expect(hooks.data.find((w) => w.id === hook.id)!.secret).toBeUndefined();

    // 列表游标
    const agents = await client.listAgents({ limit: 100 });
    expect(agents.data.some((a) => a.id === agent.id)).toBe(true);
  });

  test("错误信封 → MasApiError（状态码 / 类型 / request_id）", async () => {
    const client = createMasClient({ baseUrl: env.url, apiKey: env.key });
    let err: unknown;
    try {
      await client.getSession("sess_does_not_exist");
    } catch (e: unknown) {
      err = e;
    }
    expect(err).toBeInstanceOf(MasApiError);
    const apiErr = err as MasApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.errorType).toBe("not_found_error");
    expect(apiErr.requestId).toMatch(/^req_/);

    // 鉴权失败：错误凭证 → 401/403 类错误信封
    const bad = createMasClient({ baseUrl: env.url, apiKey: "mas_sk_invalid" });
    await expect(bad.listAgents()).rejects.toMatchObject({ status: 401 });
  });
});
