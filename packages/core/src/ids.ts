import { ulid } from "ulid";

export type IdPrefix =
  | "agent"
  | "env"
  | "sesn"
  | "sevt"
  | "file"
  | "sesrsc"
  | "vlt"
  | "vcrd"
  | "req"
  | "exe"
  | "mstr"
  | "mem"
  | "memv"
  | "skl"
  | "skv"
  | "dply"
  | "dprn"
  | "whk"
  | "whd";

const PREFIXES: IdPrefix[] = [
  "agent",
  "env",
  "sesn",
  "sevt",
  "file",
  "sesrsc",
  "vlt",
  "vcrd",
  "req",
  "exe",
  "mstr",
  "mem",
  "memv",
  "skl",
  "skv",
  "dply",
  "dprn",
  "whk",
  "whd",
];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** 校验 ID 是否带约定前缀（C-05）。 */
export function hasIdPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}

export function assertIdPrefix(id: string, prefix: IdPrefix, field = "id"): void {
  if (!hasIdPrefix(id, prefix)) {
    throw new Error(`invalid ${field}: expected ${prefix}_ prefix`);
  }
}

/** 从不透明 ID 中识别资源类型（用于 404 统一处理）。 */
export function idResourceType(id: string): IdPrefix | null {
  return PREFIXES.find((p) => hasIdPrefix(id, p)) ?? null;
}

/** mas_sk_<id>_<secret> 形式的 API key。 */
export function newApiKeySecret(keyId: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let secret = "";
  for (let i = 0; i < 40; i++) secret += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `mas_sk_${keyId}_${secret}`;
}
