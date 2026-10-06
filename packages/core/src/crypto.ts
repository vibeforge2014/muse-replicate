import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 机密信封加密（spec §10.1）：数据密钥 AES-256-GCM，主密钥来自环境变量
 * （KMS 抽象的 MVP 形态）。存的是 JSON envelope，API 层永不回显明文。
 */

function masterKey(): Buffer {
  const raw = process.env.MAS_MASTER_KEY;
  if (raw && /^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  // 开发默认主密钥；生产部署必须设置 MAS_MASTER_KEY
  return createHash("sha256").update("mas-dev-master-key").digest();
}

interface Envelope {
  v: 1;
  /** 被 主密钥 AES-256-GCM 包裹的数据密钥（含 authTag）。 */
  wdek: string;
  wiv: string;
  /** 数据密钥加密机密的参数。 */
  iv: string;
  ct: string;
}

export function sealSecret(plaintext: string): string {
  const dek = randomBytes(32);
  const wiv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", masterKey(), wiv);
  const wdek = Buffer.concat([wrap.update(dek), wrap.final(), wrap.getAuthTag()]);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final(), c.getAuthTag()]);
  const env: Envelope = {
    v: 1,
    wdek: wdek.toString("base64"),
    wiv: wiv.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(env);
}

export function openSecret(envelope: string): string {
  const env = JSON.parse(envelope) as Envelope;
  if (env.v !== 1) throw new Error("unknown secret envelope version");
  const unwrap = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(env.wiv, "base64"));
  const wdekBuf = Buffer.from(env.wdek, "base64");
  unwrap.setAuthTag(wdekBuf.subarray(wdekBuf.length - 16));
  const dek = Buffer.concat([unwrap.update(wdekBuf.subarray(0, wdekBuf.length - 16)), unwrap.final()]);
  const d = createDecipheriv("aes-256-gcm", dek, Buffer.from(env.iv, "base64"));
  const ctBuf = Buffer.from(env.ct, "base64");
  d.setAuthTag(ctBuf.subarray(ctBuf.length - 16));
  return Buffer.concat([d.update(ctBuf.subarray(0, ctBuf.length - 16)), d.final()]).toString("utf8");
}

/** 掩码展示：`***` + 末 4 位（API 永不回显机密，spec §10.1）。 */
export function maskSecret(plaintext: string): string {
  return `***${plaintext.slice(-4)}`;
}
