#!/usr/bin/env npx tsx
/**
 * 端到端冒烟：Agent → Environment → Session → POST events → 轮询 idle → GET events。
 * 用法：API_KEY=mas_sk_... BASE=http://127.0.0.1:8080 npx tsx scripts/smoke.ts
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const KEY = process.env.API_KEY;
if (!KEY) {
  console.error("set API_KEY");
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(method === "POST" ? { "zai-version": "2026-05-26", "zai-beta": "managed-agents-2026-05-26" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const agent = await call("POST", "/v1/agents", {
  name: `smoke-${Date.now()}`,
  model: { id: "glm-5.3-flash", effort: "low" },
  system: "you are a smoke test",
  tools: [{ type: "agent_toolset_20260601", default_config: { permission_policy: { type: "always_allow" } } }],
});
console.log("create agent:", agent.status, agent.json.id);
const env = await call("POST", "/v1/environments", {
  name: `smoke-env-${Date.now()}`,
  config: { type: "cloud" },
});
console.log("create env:", env.status, env.json.id);
const session = await call("POST", "/v1/sessions", {
  agent: agent.json.id,
  environment_id: env.json.id,
});
console.log("create session:", session.status, session.json.id, session.json.status);

const sent = await call("POST", `/v1/sessions/${session.json.id}/events`, {
  events: [{ type: "user.message", content: [{ type: "text", text: "echo hello-world" }] }],
});
console.log("send event:", sent.status, JSON.stringify(sent.json).slice(0, 160));

// 轮询 idle
let sess: any = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const r = await call("GET", `/v1/sessions/${session.json.id}`);
  sess = r.json;
  if (sess.status === "idle") break;
}
console.log("final status:", sess?.status, JSON.stringify(sess?.stop_reason));

const events = await call("GET", `/v1/sessions/${session.json.id}/events`);
console.log("history:");
for (const e of events.json.data) {
  const extra =
    e.type === "agent.message" ? " " + JSON.stringify(e.content)?.slice(0, 60) : "";
  console.log(`  ${e.type} processed_at=${e.processed_at}${extra}`);
}

// 清理
await call("DELETE", `/v1/sessions/${session.json.id}`);
await call("DELETE", `/v1/environments/${env.json.id}`);
console.log("smoke done");
process.exit(0);
