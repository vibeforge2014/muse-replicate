/**
 * 最小 5 字段 cron 引擎（Deployments 用，plan M6 W12）。
 * 支持 `*`、步进（star-slash-n）、`a`、`a-b`、`a-b/n`、逗号列表；dow 0-7（0/7=周日）。
 * 时区按平台方言固定 Asia/Shanghai（UTC+8，无夏令时）—— DEP-02 只接受该时区。
 */

export const DEPLOYMENT_TZ = "Asia/Shanghai";
const TZ_OFFSET_MIN = 8 * 60;

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week
];

function parseField(raw: string, idx: number): Set<number> | null {
  const [min, max] = FIELD_RANGES[idx]!;
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "") return null;
    let body = part;
    let step = 1;
    if (part.includes("/")) {
      const [b, s] = part.split("/");
      body = b!;
      step = Number(s);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = Number(body);
      if (!Number.isInteger(lo)) return null;
      hi = step > 1 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && idx === 4 ? 0 : v);
  }
  if (out.size === 0) return null;
  return out;
}

export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i]!, i);
    if (!s || s.size === 0) return null;
    sets.push(s);
  }
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    doms: sets[2]!,
    months: sets[3]!,
    dows: sets[4]!,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function matches(cron: ParsedCron, ms: number): boolean {
  // 平台时区的墙钟（Asia/Shanghai = UTC+8）
  const d = new Date(ms + TZ_OFFSET_MIN * 60_000);
  const min = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const dom = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const dow = d.getUTCDay();
  if (!cron.minutes.has(min) || !cron.hours.has(hour) || !cron.months.has(month)) return false;
  // cron 语义：dom 与 dow 都受限时满足其一即可
  const domOk = cron.doms.has(dom);
  const dowOk = cron.dows.has(dow);
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return (!cron.domRestricted || domOk) && (!cron.dowRestricted || dowOk);
}

/** 下一个触发点（> from）；horizonMs 内无触发返回 null。 */
export function nextFireAfter(expr: string | ParsedCron, fromMs: number, horizonMs = 2 * 366 * 24 * 3600_000): number | null {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  if (!cron) return null;
  // 对齐到下一分钟边界
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = fromMs + horizonMs;
  while (t <= limit) {
    if (matches(cron, t)) return t;
    t += 60_000;
  }
  return null;
}

export function upcomingFires(expr: string, count = 5, fromMs = Date.now()): number[] {
  const out: number[] = [];
  let t = fromMs;
  for (let i = 0; i < count; i++) {
    const next = nextFireAfter(expr, t);
    if (next === null) break;
    out.push(next);
    t = next;
  }
  return out;
}

export interface CronValidation {
  ok: boolean;
  error?: string;
  /** DEP-02：未来触发点（用于 upcoming） */
  upcoming: number[];
}

/** DEP-02 校验：可解析、最小间隔 ≥5 分钟、存在未来触发点。 */
export function validateCronForDeployment(expr: string): CronValidation {
  const cron = parseCron(expr);
  if (!cron) return { ok: false, error: "invalid cron expression (5 fields: minute hour dom month dow)", upcoming: [] };
  const upcoming = upcomingFires(expr, 6);
  if (upcoming.length === 0) {
    return { ok: false, error: "cron expression has no future trigger point", upcoming: [] };
  }
  // 最小间隔：连续触发 ≥5 分钟（取前 6 个覆盖小时边界）
  for (let i = 1; i < upcoming.length; i++) {
    if (upcoming[i]! - upcoming[i - 1]! < 5 * 60_000) {
      return { ok: false, error: "cron interval must be at least 5 minutes", upcoming: [] };
    }
  }
  return { ok: true, upcoming: upcoming.slice(0, 5) };
}
