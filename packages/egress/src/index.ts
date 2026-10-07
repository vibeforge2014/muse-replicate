import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

/**
 * 凭据出站（spec §10.2/§10.4）：
 * - 出站授权 token：HMAC 签名，绑定 (workspace, session, execution, generation,
 *   sandbox)，exp ≤ 租约×2；token 本身不含任何凭据；
 * - 主机策略：平台黑名单（元数据服务 / RFC1918）→ 拒绝；凭据声明 host → 注入；
 *   env networking limited → allowed_hosts（支持 `*.` 通配）；unrestricted → 仅 80/443；
 * - 占位符：沙箱 env 里只有 `mas_ph_<random>`，代理命中凭据时替换为真实值。
 */

function egressSecret(): string {
  return process.env.MAS_EGRESS_SECRET ?? "mas-dev-egress-secret";
}

export interface EgressScope {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  generation: number;
  sandboxId: string;
  /** 秒；≤ 租约×2（§10.4）。 */
  ttlSeconds?: number;
}

export interface EgressBinding {
  bindingId: string;
  token: string;
  scopeHash: string;
  expiresAt: string;
}

/** 签发出站授权 token（prepare；不含任何凭据）。 */
export function issueEgressToken(scope: EgressScope): EgressBinding {
  const ttl = Math.min(scope.ttlSeconds ?? 60, 600);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const jti = randomBytes(8).toString("hex");
  const body = {
    ws: scope.workspaceId,
    sesn: scope.sessionId,
    exe: scope.executionId,
    gen: scope.generation,
    sbx: scope.sandboxId,
    exp,
    jti,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", egressSecret()).update(payload).digest("base64url");
  return {
    bindingId: jti,
    token: `maseg_v1.${payload}.${sig}`,
    scopeHash: scopeHash(scope),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export interface VerifiedEgressToken {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  generation: number;
  sandboxId: string;
  jti: string;
}

export type EgressTokenError = "malformed" | "bad_signature" | "expired";

/** 校验 token 签名与有效期；不查 fence（那是每请求的 DB 校验）。 */
export function verifyEgressToken(token: string): { ok: true; claims: VerifiedEgressToken } | { ok: false; error: EgressTokenError } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "maseg_v1") return { ok: false, error: "malformed" };
  const [, payload, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", egressSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return { ok: false, error: "expired" };
  return {
    ok: true,
    claims: {
      workspaceId: String(claims.ws),
      sessionId: String(claims.sesn),
      executionId: String(claims.exe),
      generation: Number(claims.gen),
      sandboxId: String(claims.sbx),
      jti: String(claims.jti),
    },
  };
}

export function scopeHash(scope: EgressScope): string {
  return createHash("sha256")
    .update(`${scope.workspaceId}|${scope.sessionId}|${scope.executionId}|${scope.generation}|${scope.sandboxId}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// 主机策略（§10.2）
// ---------------------------------------------------------------------------

/** 平台黑名单：云元数据服务 + RFC1918 内网（沙箱内本不应访问）。 */
const BLACKLISTED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);
const RFC1918 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];

export function isBlacklistedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (BLACKLISTED_HOSTS.has(h)) return true;
  return RFC1918.some((re) => re.test(h));
}

/** `*.example.com` 通配匹配（§10.2）。 */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return false;
}

export type EgressDecision =
  | { action: "allow" }
  | { action: "deny"; reason: "blacklisted" | "not_allowed_host" | "non_standard_port" | "no_policy" };

/** env networking 策略判定（凭据 host 命中在先，此处只做公共出网）。 */
export function evaluateEgressPolicy(
  host: string,
  port: number,
  envNetworking: { type: "unrestricted" | "limited"; allowed_hosts?: string[] } | undefined,
): EgressDecision {
  if (isBlacklistedHost(host)) return { action: "deny", reason: "blacklisted" };
  if (envNetworking?.type === "limited") {
    const ok = (envNetworking.allowed_hosts ?? []).some((p) => hostMatches(p, host));
    return ok ? { action: "allow" } : { action: "deny", reason: "not_allowed_host" };
  }
  if (envNetworking?.type === "unrestricted" || envNetworking === undefined) {
    // 平台默认（无 env 声明）同样按 unrestricted 处理：只放行 80/443（SBX-07）
    if (port === 80 || port === 443) return { action: "allow" };
    return { action: "deny", reason: "non_standard_port" };
  }
  return { action: "deny", reason: "no_policy" };
}

// ---------------------------------------------------------------------------
// 占位符（§10.1）
// ---------------------------------------------------------------------------

export const PLACEHOLDER_PREFIX = "mas_ph_";

export function newPlaceholder(): string {
  return `${PLACEHOLDER_PREFIX}${randomBytes(12).toString("hex")}`;
}

export function isPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX);
}
export * from "./tls.js";
