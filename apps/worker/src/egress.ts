/**
 * worker 侧 egress 生命周期（spec §10.4）：
 * prepare（签发短期出站 token）→ attach（env + CA 写入沙箱）→ revoke（收尾撤销）。
 * 由 MAS_EGRESS_URL 开启（缺省=关闭，沙箱不配代理）。
 */

export interface EgressWire {
  url: string;
  adminSecret: string;
}

export function egressWireFromEnv(env: NodeJS.ProcessEnv = process.env): EgressWire | null {
  const url = env.MAS_EGRESS_URL?.trim();
  if (!url) return null;
  return {
    url: url.replace(/\/$/, ""),
    adminSecret: env.MAS_EGRESS_ADMIN ?? env.MAS_EGRESS_SECRET ?? "mas-dev-egress-secret",
  };
}

export interface PreparedBinding {
  bindingId: string;
  token: string;
  expiresAt: string;
}

export interface EgressScopeInput {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  generation: number;
  /** create 前尚无最终 sandboxId：以会话维度占位（代理不校验来源身份，fence 才是权威）。 */
  sandboxId: string;
  ttlSeconds?: number;
}

/** prepare：POST /internal/bindings（管理密钥保护）。 */
export async function prepareEgressBinding(wire: EgressWire, scope: EgressScopeInput): Promise<PreparedBinding> {
  const res = await fetch(`${wire.url}/internal/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-egress-admin": wire.adminSecret },
    body: JSON.stringify(scope),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`egress prepare failed: ${res.status}`);
  const body = (await res.json()) as PreparedBinding;
  return body;
}

/** revoke：显式撤销（execution 失败/worker 收尾；幂等，失败静默——exp+fence 是主控）。 */
export async function revokeEgressBinding(wire: EgressWire, bindingId: string): Promise<void> {
  try {
    await fetch(`${wire.url}/internal/bindings/${encodeURIComponent(bindingId)}/revoke`, {
      method: "POST",
      headers: { "x-egress-admin": wire.adminSecret },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // 最佳努力：token exp 与每请求 fence 校验兜底（§10.4）
  }
}

const caCache = new Map<string, { pem: string; at: number }>();

/** 沙箱预置的企业 CA（5 分钟缓存；随 attach 写入会话 home）。 */
export async function fetchEgressCa(wire: EgressWire): Promise<string> {
  const hit = caCache.get(wire.url);
  if (hit && Date.now() - hit.at < 300_000) return hit.pem;
  const res = await fetch(`${wire.url}/internal/ca`, {
    headers: { "x-egress-admin": wire.adminSecret },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`egress CA fetch failed: ${res.status}`);
  const { cert } = (await res.json()) as { cert: string };
  caCache.set(wire.url, { pem: cert, at: Date.now() });
  return cert;
}
