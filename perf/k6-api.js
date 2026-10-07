// k6 场景（spec §17.1「性能」行的 k6 半边；自研 harness 见 perf/harness.ts）：
//   k6 run -e BASE=http://192.168.1.123:30080 -e KEY=mas_sk_... perf/k6-api.js
// 覆盖 API 面：会话建立 + 首轮消息 + 轮询到 idle；SSE/沙箱冷启的细粒度分布在 harness 里。
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE || "http://127.0.0.1:8080";
const KEY = __ENV.KEY || "";

const params = () => ({ headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" } });

export const options = {
  scenarios: {
    turns: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "1m", target: 10 },
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{url:*/v1/sessions}": ["p(95)<5000"], // 冷启动预算（spec §17.2 P50<5s）
  },
};

export function setup() {
  const agent = http.post(`${BASE}/v1/agents`, JSON.stringify({ name: `k6-${Date.now()}`, model: { id: "glm-5.3-flash" } }), params()).json();
  const env = http.post(`${BASE}/v1/environments`, JSON.stringify({ name: `k6-env-${Date.now()}`, config: { type: "cloud" } }), params()).json();
  return { agentId: agent.id, envId: env.id };
}

export default function (data) {
  const s = http.post(`${BASE}/v1/sessions`, JSON.stringify({ agent: data.agentId, environment_id: data.envId }), params()).json();
  check(s, { "session created": (r) => !!r.id });

  const r = http.post(
    `${BASE}/v1/sessions/${s.id}/events`,
    JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] }),
    params(),
  );
  check(r, { "message accepted": (res) => res.status === 200 || res.status === 429 });

  // 429 时按 retry_after 避让（集群真实限流：write 桶 burst=20/10rps）
  if (r.status === 429) {
    sleep(Number(r.json("error.details.retry_after")) || 1);
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const cur = http.get(`${BASE}/v1/sessions/${s.id}`, params()).json();
    if (cur.status === "idle" && cur.stop_reason) break;
    sleep(0.5);
  }
  sleep(0.2);
}
