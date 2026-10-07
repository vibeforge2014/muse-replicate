#!/usr/bin/env npx tsx
/**
 * 负载验收 harness（spec §17.1「性能」行 / §17.2 发布条件）：
 * - cold：冷会话（新 session + 首轮）create→idle 全程 P50 < 5s / P95 < 15s；
 * - ttft：POST events → SSE 首个 agent.message 帧的延迟分布；
 * - sse：单会话 SSE 扇出（K 连接都收到完整帧序列，报告首帧延迟分布）；
 * - conc：单 worker N 并发会话，完成时进程 RSS < 2 GB（spec §17.2）。
 *
 * 用法：
 *   pnpm perf                        # 本地栈（复用测试 harness：api+worker 同进程）
 *   pnpm perf -- --scenarios ttft,sse --sse-conns 100
 *   pnpm perf -- --base http://192.168.1.123:30080 --key mas_sk_...
 *
 * 说明：
 * - 本地模式 RSS 为整进程近似（api+worker+harness 同进程；spec 阈值 2GB 以 worker
 *   为主导，api 无每会话常驻内存）。集群模式给 --rss-cmd（输出字节数的 shell 命令），
 *   如 `ssh root@host "k3s kubectl -n mas exec deployment/mas-worker -- node -e
 *   'console.log(process.memoryUsage().rss)'"`。
 * - SSE 每连接占 1 条 PG LISTEN 连接；本地默认 PG max_connections=100，--sse-conns
 *   上限请按目标库连接数余量调整（spec 的 1k 连接目标对应已调优 PG 或 Redis Streams 二期）。
 * - TTFT 以 fake driver 为负载（测的是 api→PG→worker→SSE 管线开销，不含模型时延）。
 */
process.env.DATABASE_URL ??= "postgres://mas@localhost:5433/mas_test";
process.env.MAS_LOG ??= "0";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const scenarios = flag("scenarios", "cold,ttft,sse,conc").split(",").map((s) => s.trim()).filter(Boolean);
const coldN = Number(flag("cold-n", "20"));
const ttftN = Number(flag("ttft-n", "50"));
const sseConns = Number(flag("sse-conns", "60"));
const concN = Number(flag("conc-n", "50"));
const baseOverride = flag("base", "");
const keyOverride = flag("key", "");
const rssCmd = flag("rss-cmd", "");
// MVP 无 idle-pause/会话删除→沙箱回收接线（见 DESIGN「未实现」）：k8s 沙箱 Pod 会随
// 会话累积，撞节点 pod 上限（110/节点）后一切 Pending。压测前后用 --clean-cmd 清场：
// ssh root@node "k3s kubectl -n mas delete pod -l mas-sandbox=true --wait=false"
const preClean = flag("pre-clean", "");
const postClean = flag("post-clean", preClean);

if (!baseOverride) {
  // 本地模式：压测流量放开限流（与测试套件同款参数）；集群模式按目标真实限流跑
  process.env.MAS_RATELIMIT_BURST ??= "1000";
  process.env.MAS_RATELIMIT_PER_MIN ??= "60000";
}

// spec §17.2 发布条件
const THRESHOLDS = { coldP50: 5_000, coldP95: 15_000, rss: 2 * 1024 ** 3 };

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
function stats(samples: number[]): { p50: number; p95: number; max: number; n: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] ?? NaN, n: s.length };
}
const ms = (v: number) => `${(v / 1000).toFixed(2)}s`;

interface Target {
  url: string;
  key: string;
  /** 集群模式：跑外部命令取 worker RSS 字节；本地模式直接读本进程。 */
  rss(): Promise<number>;
  close(): Promise<void>;
}

async function localTarget(): Promise<Target> {
  const { setupEnv, makeAgentAndEnv } = await import("../tests/helpers.ts");
  const env = await setupEnv();
  return {
    url: env.url,
    key: env.key,
    // 同进程近似：harness 本身开销固定，主导项是 50 会话的 worker 状态
    async rss() {
      return process.memoryUsage().rss;
    },
    async close() {
      /* setupEnv 缓存整个进程生命周期；harness 退出即结束 */
    },
  };
}

async function remoteTarget(): Promise<Target> {
  const url = baseOverride.replace(/\/$/, "");
  const { execFile } = await import("node:child_process");
  return {
    url,
    key: keyOverride,
    async rss() {
      if (!rssCmd) throw new Error("集群模式测 RSS 需要 --rss-cmd（见文件头说明）");
      return new Promise<number>((resolve, reject) => {
        execFile("/bin/sh", ["-c", rssCmd], (err, stdout) => {
          if (err) reject(err);
          else resolve(Number(stdout.trim()));
        });
      });
    },
    async close() {},
  };
}

async function api(
  url: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 集群模式下按真实限流跑：429 按 retry_after 退避重试（write 桶 burst=20/10rps）。 */
async function apiWithRetry(
  url: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
  attempts = 8,
): Promise<{ status: number; json: any }> {
  for (let i = 0; ; i++) {
    const r = await api(url, key, method, path, body);
    if (r.status !== 429 || i >= attempts - 1) return r;
    const wait = (Number(r.json?.error?.details?.retry_after ?? 1) + 0.2) * 1000;
    await new Promise((res) => setTimeout(res, wait));
  }
}

async function setupFixtures(t: Target): Promise<{ agentId: string; envId: string }> {
  const agent = await api(t.url, t.key, "POST", "/v1/agents", {
    name: `perf-${Date.now().toString(36)}`,
    model: { id: "glm-5.3-flash", effort: "low" },
  });
  const env = await api(t.url, t.key, "POST", "/v1/environments", {
    name: `perf-env-${Date.now().toString(36)}`,
    config: { type: "cloud" },
  });
  if (!agent.json?.id || !env.json?.id) throw new Error(`fixtures failed: ${JSON.stringify(agent.json)} ${JSON.stringify(env.json)}`);
  return { agentId: agent.json.id, envId: env.json.id };
}

async function newSession(t: Target, fx: { agentId: string; envId: string }): Promise<string> {
  const r = await apiWithRetry(t.url, t.key, "POST", "/v1/sessions", { agent: fx.agentId, environment_id: fx.envId });
  if (!r.json?.id) throw new Error(`create session: ${JSON.stringify(r.json)}`);
  return r.json.id as string;
}

async function sendMessage(t: Target, sid: string, text = "hi"): Promise<void> {
  const r = await apiWithRetry(t.url, t.key, "POST", `/v1/sessions/${sid}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  if (r.status !== 200) throw new Error(`send: ${JSON.stringify(r.json)}`);
}

async function waitIdle(t: Target, sid: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  let interval = 300;
  for (;;) {
    const r = await api(t.url, t.key, "GET", `/v1/sessions/${sid}`);
    // 必须等到 stop_reason：新会话初始就是 idle(null)，直接判 idle 会把排队时间测没
    if (r.status === 200 && r.json.status === "idle" && ["end_turn", "requires_action"].includes(r.json.stop_reason?.type)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitIdle timeout sid=${sid} last=${JSON.stringify(r.json).slice(0, 200)}`);
    // 429 退避：50 轮询 × 300ms 会吃满 read 桶（burst100/50rps），按 retry_after 放慢
    if (r.status === 429) interval = Math.min(2_000, Math.max(interval, (Number(r.json?.error?.details?.retry_after ?? 1) + 0.5) * 1000));
    else interval = 300;
    await new Promise((r2) => setTimeout(r2, interval));
  }
}

/** 打开一条 SSE；onFrame 返回 true 时自动关闭。 */
function openStream(
  t: Target,
  sid: string,
  onFrame: (frame: { id: string; event: string; data: any }) => boolean,
): { done: Promise<{ frames: number; closed: boolean }>; abort: () => void } {
  const ctrl = new AbortController();
  let frames = 0;
  const done = (async () => {
    try {
      const res = await fetch(`${t.url}/v1/sessions/${sid}/events/stream`, {
        headers: { authorization: `Bearer ${t.key}`, accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (dataLine === undefined) continue;
          frames += 1;
          const hit = onFrame({
            id: frame.split("\n").find((l) => l.startsWith("id:"))?.slice(3).trim() ?? "",
            event: frame.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "",
            data: JSON.parse(dataLine),
          });
          if (hit) {
            ctrl.abort();
            return { frames, closed: true };
          }
        }
      }
    } catch {
      /* abort 或连接关闭 */
    }
    return { frames, closed: false };
  })();
  return { done, abort: () => ctrl.abort() };
}

const results: string[] = [];
function report(name: string, s: { p50: number; p95: number; max: number; n: number }, thresholds?: { p50?: number; p95?: number }) {
  const verdict =
    thresholds === undefined
      ? ""
      : `  ${thresholds.p50 !== undefined && s.p50 < thresholds.p50 ? "✓" : "✗"}P50<${ms(thresholds.p50)} ${thresholds.p95 !== undefined && s.p95 < thresholds.p95 ? "✓" : "✗"}P95<${ms(thresholds.p95)}`;
  const line = `${name}: n=${s.n} P50=${ms(s.p50)} P95=${ms(s.p95)} max=${ms(s.max)}${verdict}`;
  console.log(line);
  results.push(line);
}

async function shell(cmd: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    execFile("/bin/sh", ["-c", cmd], (err, stdout, stderr) => {
      if (err) console.warn(`[clean] ${err.message}; ${String(stderr).slice(0, 120)}`);
      else console.log(`[clean] ${String(stdout).trim().slice(0, 120)}`);
      resolve();
    });
  });
}

async function main() {
  const t = baseOverride ? await remoteTarget() : await localTarget();
  console.log(`target=${t.url} scenarios=[${scenarios.join(",")}] cold-n=${coldN} ttft-n=${ttftN} sse-conns=${sseConns} conc-n=${concN}`);
  if (preClean) await shell(preClean);
  const fx = await setupFixtures(t);

  if (scenarios.includes("cold")) {
    // 冷会话：create + 首轮 message → idle（走沙箱创建 + checkpoint base 全路径）
    const samples: number[] = [];
    for (let i = 0; i < coldN; i++) {
      const t0 = Date.now();
      const sid = await newSession(t, fx);
      await sendMessage(t, sid);
      await waitIdle(t, sid);
      samples.push(Date.now() - t0);
    }
    report("cold（新会话 create→idle）", stats(samples), { p50: THRESHOLDS.coldP50, p95: THRESHOLDS.coldP95 });
  }

  if (scenarios.includes("ttft")) {
    // TTFT：SSE 先就位 → POST events → 首个 agent.message 帧
    const samples: number[] = [];
    for (let i = 0; i < ttftN; i++) {
      const sid = await newSession(t, fx);
      const hit = { at: 0 };
      const first = openStream(t, sid, (f) => {
        if (f.data?.type === "agent.message") {
          hit.at = Date.now();
          return true;
        }
        return false;
      });
      await new Promise((r) => setTimeout(r, 150)); // 流就位
      const sentAt = Date.now();
      await sendMessage(t, sid);
      await first.done;
      first.abort();
      if (!hit.at) throw new Error(`ttft: no agent.message frame (sid=${sid})`);
      samples.push(hit.at - sentAt);
    }
    report("ttft（POST→首帧）", stats(samples));
  }

  if (scenarios.includes("sse")) {
    // SSE 扇出：单会话 K 连接 → 一条消息 → 人人都收到 agent.message
    const sid = await newSession(t, fx);
    const postAt = { v: 0 };
    const hits = Array.from({ length: sseConns }, () => ({ at: 0 }));
    const conns = hits.map((h) =>
      openStream(t, sid, (f) => {
        if (f.data?.type === "agent.message" && postAt.v) {
          h.at = Date.now();
          return true;
        }
        return false;
      }),
    );
    await new Promise((r) => setTimeout(r, 500)); // 连接就位
    postAt.v = Date.now();
    await sendMessage(t, sid);
    await Promise.all(conns.map((c) => c.done));
    const lat = hits.filter((h) => h.at).map((h) => h.at - postAt.v);
    const gotIt = lat.length;
    console.log(`sse 扇出: ${gotIt}/${sseConns} 连接收到 agent.message`);
    report("sse（广播→首帧）", stats(lat));
    results.push(`sse 扇出完整率: ${gotIt}/${sseConns}`);
    if (gotIt !== sseConns) process.exitCode = 1;
  }

  if (scenarios.includes("conc")) {
    // 单 worker N 并发会话：每会话独立 send→idle，同时完成；结束时 RSS 门禁
    const sids = await Promise.all(Array.from({ length: concN }, () => newSession(t, fx)));
    const t0 = Date.now();
    await Promise.all(
      sids.map(async (sid) => {
        await sendMessage(t, sid);
        await waitIdle(t, sid, 120_000);
      }),
    );
    const wall = Date.now() - t0;
    const rss = await t.rss();
    const ok = rss < THRESHOLDS.rss;
    console.log(
      `conc: ${concN} 并发会话 wall=${ms(wall)} 吞吐=${(concN / (wall / 1000)).toFixed(1)}/s RSS=${(rss / 1024 ** 2).toFixed(0)}MiB ${ok ? "✓" : "✗"}RSS<2GiB`,
    );
    results.push(`conc RSS=${(rss / 1024 ** 2).toFixed(0)}MiB ${ok ? "PASS" : "FAIL"}`);
    if (!ok) process.exitCode = 1;
  }

  console.log("\n==== 汇总（spec §17.2 门禁：cold P50<5s/P95<15s、50 并发 RSS<2GiB） ====");
  for (const r of results) console.log(r);
  if (postClean) await shell(postClean);
  await t.close();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
