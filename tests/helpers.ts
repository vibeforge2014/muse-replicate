import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { bootstrap, createDb, runMigrations, sessionsWithWork, type DbHandle } from "@mas/db";
import { FakeCodexDriver } from "@mas/runtime";
import { SessionRunner } from "../apps/worker/src/session-runner.ts";
import { buildApp } from "../apps/server/src/app.ts";

process.env.DATABASE_URL ??= "postgres://mas@localhost:5433/mas_test";

export interface TestEnv {
  app: FastifyInstance;
  url: string;
  key: string;
  db: DbHandle;
  runner: SessionRunner;
  close(): Promise<void>;
}

let cached: TestEnv | null = null;

export async function setupEnv(): Promise<TestEnv> {
  if (cached) return cached;
  const db = createDb();
  // 干净的测试库
  const tables = [
    "session_internal_events",
    "idempotency_keys",
    "session_resources",
    "files",
    "session_executions",
    "session_events",
    "sessions",
    "agent_versions",
    "agents",
    "environments",
    "api_keys",
    "workspaces",
    "orgs",
    "__migrations",
  ];
  for (const t of tables) {
    await db.pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await runMigrations(db.pool);
  const boot = await bootstrap(db.db);
  const app = buildApp({ db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const runner = new SessionRunner(db.db, new FakeCodexDriver(), "worker_test");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("LISTEN session_exec");
  const inFlight = new Set<string>();
  const drain = async () => {
    const ids = await sessionsWithWork(db.db);
    for (const sessionId of ids) {
      if (inFlight.has(sessionId)) continue;
      inFlight.add(sessionId);
      void runner
        .processSession(sessionId)
        .catch(() => undefined)
        .finally(() => inFlight.delete(sessionId));
    }
  };
  client.on("notification", () => void drain());
  const timer = setInterval(() => void drain(), 1000);

  cached = {
    app,
    url,
    key: boot.apiKey,
    db,
    runner,
    async close() {
      clearInterval(timer);
      await client.end().catch(() => undefined);
      await app.close();
      await db.close();
      cached = null;
    },
  };
  return cached;
}

export interface Resp {
  status: number;
  json: any;
  headers: Record<string, string>;
}

export async function call(
  url: string,
  key: string | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, json, headers };
}

export async function waitFor(
  url: string,
  key: string,
  sessionId: string,
  predicate: (s: any) => boolean,
  timeoutMs = 15_000,
): Promise<any> {
  const start = Date.now();
  for (;;) {
    const r = await call(url, key, "GET", `/v1/sessions/${sessionId}`);
    if (r.status === 200 && predicate(r.json)) return r.json;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout; last=${JSON.stringify(r.json).slice(0, 300)}`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
}

export async function listEvents(url: string, key: string, sessionId: string): Promise<any[]> {
  const r = await call(url, key, "GET", `/v1/sessions/${sessionId}/events`);
  return r.json.data;
}

/** 收集 SSE 流直到条件满足或超时。 */
export async function collectStream(
  url: string,
  key: string,
  sessionId: string,
  until: (events: { id: string; event: string; data: any }[]) => boolean,
  opts: { timeoutMs?: number; lastEventId?: string } = {},
): Promise<{ id: string; event: string; data: any }[]> {
  const ctrl = new AbortController();
  const collected: { id: string; event: string; data: any }[] = [];
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: "text/event-stream" };
  if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${url}/v1/sessions/${sessionId}/events/stream`, {
      headers,
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split("\n");
        const id = lines.find((l) => l.startsWith("id:"))?.slice(3).trim() ?? "";
        const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "";
        const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
        if (dataLine !== undefined) {
          let data: any = null;
          try {
            data = JSON.parse(dataLine);
          } catch {
            data = dataLine;
          }
          collected.push({ id, event, data });
          if (until(collected)) {
            ctrl.abort();
            return collected;
          }
        }
      }
    }
  } catch {
    /* aborted 或流关闭 */
  } finally {
    clearTimeout(timeout);
  }
  return collected;
}

export async function makeAgentAndEnv(
  url: string,
  key: string,
  tools: unknown[] | "none" = "none",
): Promise<{ agentId: string; envId: string }> {
  const agent = await call(url, key, "POST", "/v1/agents", {
    name: `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    model: { id: "glm-5.3-flash", effort: "low" },
    ...(tools !== "none" ? { tools } : {}),
  });
  const env = await call(url, key, "POST", "/v1/environments", {
    name: `t-env-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    config: { type: "cloud" },
  });
  return { agentId: agent.json.id, envId: env.json.id };
}

export async function createSession(
  url: string,
  key: string,
  agentId: string,
  envId: string,
  initialEvents?: unknown[],
): Promise<string> {
  const r = await call(url, key, "POST", "/v1/sessions", {
    agent: agentId,
    environment_id: envId,
    ...(initialEvents ? { initial_events: initialEvents } : {}),
  });
  if (r.status !== 200) throw new Error(`createSession failed: ${JSON.stringify(r.json)}`);
  return r.json.id;
}

/** 有序子序列断言（test-case-plan §6）。 */
export function expectSubsequence(actual: string[], expected: (string | RegExp)[]): void {
  let i = 0;
  for (const a of actual) {
    const e = expected[i];
    if (e === undefined) break;
    const match = typeof e === "string" ? a === e : e.test(a);
    if (match) i++;
  }
  if (i < expected.length) {
    throw new Error(`subsequence not matched: consumed ${i}/${expected.length}; actual=[${actual.join(", ")}]`);
  }
}
