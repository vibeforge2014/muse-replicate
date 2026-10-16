#!/usr/bin/env npx tsx
/**
 * 地市填报 → 归集演示（multiagent lanes，spec §5.6 二期）：
 * 11 个浙江地市各占一条 lane 并发填报（内容带地市前缀），单会话单沙箱单 runtime 进程、
 * 每市一个 thread；填报完成后按地市前缀归集 agent 回执，校验 11 市无一遗漏、事件按 seq 归一。
 *
 * 用法：API_KEY=mas_sk_... BASE=http://127.0.0.1:8080 npx tsx scripts/filing-demo.ts
 * （fake driver 下回执即回显；真实 codex driver 下回执为各市 agent 的应答）
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const KEY = process.env.API_KEY;
if (!KEY) {
  console.error("set API_KEY");
  process.exit(1);
}

/** 浙江11地市：lane_id 用拼音（API 校验 ^[a-z0-9][a-z0-9_-]{0,63}$），填报内容带中文前缀。 */
const CITIES: { lane: string; name: string }[] = [
  { lane: "hangzhou", name: "杭州" },
  { lane: "ningbo", name: "宁波" },
  { lane: "wenzhou", name: "温州" },
  { lane: "jiaxing", name: "嘉兴" },
  { lane: "huzhou", name: "湖州" },
  { lane: "shaoxing", name: "绍兴" },
  { lane: "jinhua", name: "金华" },
  { lane: "quzhou", name: "衢州" },
  { lane: "zhoushan", name: "舟山" },
  { lane: "taizhou", name: "台州" },
  { lane: "lishui", name: "丽水" },
];

/** 随意但可复现的填报内容（种子随机）。 */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
const rnd = seeded(20261016);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const num = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
function filingOf(name: string): string {
  const items = [
    `视联网新增接入 ${num(60, 480)} 路`,
    `制造业行为管理项目新签 ${num(1, 9)} 个`,
    `当期平台营收 ${num(120, 1900)} 万元`,
    `在建 AI 试点 ${num(1, 5)} 个，验收 ${num(0, 2)} 个`,
    `重点客户回访 ${num(4, 28)} 家`,
  ];
  return `${name}｜${pick(items)}；${pick(items)}`;
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

// 1) agent / env / session
const agent = await call("POST", "/v1/agents", {
  name: `dishi-filing-${Date.now()}`,
  model: { id: "glm-5.3-flash", effort: "low" },
  system: "你是地市填报归集助手：收到带地市前缀的填报后原样回执确认。",
  tools: [{ type: "agent_toolset_20260601", default_config: { permission_policy: { type: "always_allow" } } }],
});
if (agent.status >= 300) throw new Error(`create agent: ${agent.status} ${JSON.stringify(agent.json)}`);
const env = await call("POST", "/v1/environments", { name: `dishi-env-${Date.now()}`, config: { type: "cloud" } });
const session = await call("POST", "/v1/sessions", { agent: agent.json.id, environment_id: env.json.id });
if (session.status >= 300) throw new Error(`create session: ${session.status} ${JSON.stringify(session.json)}`);
const sid = session.json.id as string;
console.log(`会话 ${sid}（${CITIES.length} 条 lane 并发填报）`);

// 2) 各地市并发填报（lane_id=地市拼音；内容带中文地市前缀）
const t0 = Date.now();
const filed = await Promise.all(
  CITIES.map(async (c) => {
    const text = `echo: ${filingOf(c.name)}`;
    const r = await call("POST", `/v1/sessions/${sid}/events`, {
      lane_id: c.lane,
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
    return { city: c.name, lane: c.lane, ok: r.status === 200, text: text.slice(5) };
  }),
);
for (const f of filed.filter((x) => !x.ok)) console.error(`  ✗ ${f.city} 填报失败`);
if (filed.some((x) => !x.ok)) process.exit(1);

// 3) 等全部回执（每市一条 agent.message）+ 会话 idle
let events: any[] = [];
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const r = await call("GET", `/v1/sessions/${sid}/events?limit=100`);
  events = r.json.data ?? [];
  const acks = events.filter((e) => e.type === "agent.message").length;
  const sess = await call("GET", `/v1/sessions/${sid}`);
  process.stdout.write(`\r  等待归集：${acks}/${CITIES.length} 市回执，会话 ${sess.json.status}   `);
  if (acks >= CITIES.length && sess.json.status === "idle") break;
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n  全部回执耗时 ${elapsed}s`);

// 4) 归集：按地市前缀分组校验（API 响应按服务端 seq 顺序返回，seq 字段本身按设计剔除）
const flat = events.map((e, i) => ({
  i,
  type: e.type as string,
  text: (e.content ?? []).map((b: any) => b.text ?? "").join(""),
}));
const acks = flat.filter((e) => e.type === "agent.message");
console.log("\n归集结果（服务端定序顺序）：");
console.log("  #   | 地市回执");
console.log("  ----+--------------------------------------------------");
const byCity = new Map<string, string[]>();
for (const a of acks) {
  const city = CITIES.find((c) => a.text.startsWith(c.name));
  console.log(`  ${String(a.i).padStart(3)} | ${a.text}`);
  if (city) byCity.set(city.name, [...(byCity.get(city.name) ?? []), a.text]);
}
const missing = CITIES.filter((c) => !byCity.has(c.name));
console.log("\n校验：");
console.log(`  回执 ${acks.length} 条，覆盖地市 ${byCity.size}/${CITIES.length}`);
console.log(missing.length === 0 ? "  ✓ 11 地市全部归集，无遗漏" : `  ✗ 缺失：${missing.map((m) => m.name).join("、")}`);
// 定序不变量：每市恰一条填报（user.message），且其回执（agent.message）出现在填报之后
let orderOk = true;
for (const c of CITIES) {
  const filings = flat.filter((e) => e.type === "user.message" && e.text.includes(`：${c.name}｜`) === false && e.text.startsWith(`echo: ${c.name}｜`));
  const ackIdx = flat.findIndex((e) => e.type === "agent.message" && e.text.startsWith(c.name));
  if (filings.length !== 1 || ackIdx < 0 || ackIdx < filings[0]!.i) orderOk = false;
}
console.log(orderOk ? "  ✓ 定序不变量：每市填报恰一次、回执在其后" : "  ✗ 定序异常");
process.exit(missing.length === 0 && orderOk ? 0 : 1);
