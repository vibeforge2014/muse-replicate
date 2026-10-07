import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * egress TLS 终止的证书面（spec §10.1：沙箱镜像预置企业 CA，代理按 SNI 签发证书）。
 * 零依赖手写 X.509（与 SigV4/OTLP 同风格）：ECDSA P-256 自建 CA + 每主机叶子证书，
 * SAN 校验用。CA 来自 MAS_EGRESS_CA_CERT/MAS_EGRESS_CA_KEY（PEM 文件），
 * 未提供则进程内生成（MAS_EGRESS_CA_DIR 设置时落盘复用）。
 */

// ---------------------------------------------------------------------------
// DER 基础件
// ---------------------------------------------------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  if (content.length < 0x80) {
    return Buffer.concat([Buffer.from([tag, content.length]), content]);
  }
  const bytes: number[] = [];
  let n = content.length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length]), Buffer.from(bytes), content]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function integer(n: number | bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let buf = Buffer.from(hex, "hex");
  if (buf[0]! & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return tlv(0x02, buf);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const body: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    let v = p;
    const stack: number[] = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...stack);
  }
  return tlv(0x06, Buffer.from(body));
}

function bitString(bits: number, unusedBits: number): Buffer {
  return tlv(0x03, Buffer.from([unusedBits, bits]));
}

function utf8(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, "utf8"));
}

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  return tlv(
    0x17,
    Buffer.from(
      `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
        `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`,
      "ascii",
    ),
  );
}

/** RDN：CN-only 的 Name。 */
function nameCN(cn: string): Buffer {
  return seq(set(seq(oid("2.5.4.3"), utf8(cn))));
}

/** Extension ::= SEQ{ OID, critical?, OCTET STRING(value-der) }。 */
function extension(oidDotted: string, critical: boolean, valueDer: Buffer): Buffer {
  return critical
    ? seq(oid(oidDotted), tlv(0x01, Buffer.from([0xff])), tlv(0x04, valueDer))
    : seq(oid(oidDotted), tlv(0x04, valueDer));
}

/** 上下文标签（构造式）：[0]=版本 EXPLICIT、[3]=extensions EXPLICIT。 */
const ctxExplicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);

const SIG_ALG_ECDSA_SHA256 = oid("1.2.840.10045.4.3.2"); // ecdsa-with-SHA256

// ---------------------------------------------------------------------------
// 证书签发
// ---------------------------------------------------------------------------

export interface EgressCA {
  caCertPem: string;
  caKey: KeyObject;
  /** CA 主题（叶子 issuer 复用）。 */
  issuerName: Buffer;
}

export interface MintedCert {
  certPem: string;
  keyPem: string;
  expiresAt: number;
}

const newKeyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").trim()}\n-----END CERTIFICATE-----\n`;

function buildCertificate(opts: {
  issuer: Buffer;
  subject: Buffer;
  spki: Buffer;
  serial: Buffer;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer;
  signKey: KeyObject;
}): Buffer {
  const tbs = seq(
    tlv(0xa0, integer(2)), // version v3（[0] EXPLICIT 直接包 INTEGER）
    tlv(0x02, opts.serial),
    seq(SIG_ALG_ECDSA_SHA256),
    opts.issuer,
    seq(utcTime(opts.notBefore), utcTime(opts.notAfter)),
    opts.subject,
    opts.spki,
    ctxExplicit(3, opts.extensions),
  );
  // node 对 EC 私钥的 crypto.sign 输出 DER 编码的 ECDSA-SigValue
  const signature = cryptoSign("sha256", tbs, opts.signKey);
  return seq(tbs, seq(SIG_ALG_ECDSA_SHA256), bitStringWrap(signature));
}

function bitStringWrap(sig: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), sig]));
}

/** 载入或生成企业 CA。 */
export function loadOrCreateEgressCA(env: NodeJS.ProcessEnv = process.env): EgressCA {
  const certFile = env.MAS_EGRESS_CA_CERT;
  const keyFile = env.MAS_EGRESS_CA_KEY;
  if (certFile && keyFile && existsSync(certFile) && existsSync(keyFile)) {
    return {
      caCertPem: readFileSync(certFile, "utf8"),
      caKey: createPrivateKey(readFileSync(keyFile, "utf8")),
      issuerName: nameCN("MAS Egress Root CA"),
    };
  }
  const { publicKey, privateKey } = newKeyPair();
  const now = new Date();
  const issuer = nameCN("MAS Egress Root CA");
  const der = buildCertificate({
    issuer,
    subject: issuer,
    spki: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    serial: randomSerial(),
    notBefore: now,
    notAfter: new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000),
    extensions: seq(
      extension("2.5.29.19", true, seq(tlv(0x01, Buffer.from([0xff])))), // basicConstraints CA:true
      extension("2.5.29.15", true, bitString(0x06, 2)), // keyUsage keyCertSign(bit5)|cRLSign(bit6)
    ),
    signKey: privateKey,
  });
  const caCertPem = pem(der);
  const caKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = env.MAS_EGRESS_CA_DIR;
  if (dir) {
    // 落盘复用（沙箱预置的 CA 与代理签发方必须一致）
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "egress-ca.crt"), caCertPem);
    writeFileSync(join(dir, "egress-ca.key"), caKeyPem, { mode: 0o600 });
  }
  return { caCertPem, caKey: privateKey, issuerName: issuer };
}

function randomSerial(): Buffer {
  // 正数、非零、含熵（首字节清最高位避免补零歧义）
  return Buffer.from([randomBytes(1)[0]! & 0x7f | 0x01, ...randomBytes(14)]);
}

function isIpV4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** SAN：SEQ{ [2] dNSName | [7] iPAddress }。 */
function sanFor(host: string): Buffer {
  if (isIpV4(host)) {
    const ip = Buffer.from(host.split(".").map(Number));
    return seq(tlv(0x87, ip));
  }
  return seq(tlv(0x82, Buffer.from(host, "ascii")));
}

const CERT_TTL_MS = 3600_000; // 叶子证书 1h（缓存维度）
const CERT_CACHE_MAX = 256;
const certCache = new Map<string, MintedCert>();

/** 按主机名签发叶子证书（缓存 1h；命中策略后才会调用）。 */
export function mintServerCert(ca: EgressCA, host: string): MintedCert {
  const key = host.toLowerCase();
  const hit = certCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit;
  const { publicKey, privateKey } = newKeyPair();
  const now = new Date();
  const notAfter = new Date(now.getTime() + CERT_TTL_MS);
  const der = buildCertificate({
    issuer: ca.issuerName,
    subject: nameCN(key),
    spki: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    serial: randomSerial(),
    notBefore: now,
    notAfter,
    extensions: seq(
      extension("2.5.29.19", true, seq()), // basicConstraints CA:false
      extension("2.5.29.15", true, bitString(0x80, 7)), // keyUsage digitalSignature
      extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage serverAuth
      extension("2.5.29.17", false, sanFor(key)), // subjectAltName
    ),
    signKey: ca.caKey,
  });
  const minted: MintedCert = {
    certPem: pem(der),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    expiresAt: notAfter.getTime(),
  };
  certCache.set(key, minted);
  if (certCache.size > CERT_CACHE_MAX) {
    const oldest = certCache.keys().next().value;
    if (oldest !== undefined) certCache.delete(oldest);
  }
  return minted;
}

/** 测试辅助：清空叶子证书缓存。 */
export function resetEgressCertCacheForTest(): void {
  certCache.clear();
}

/** 指纹（沙箱预置/核对用）。 */
export function caFingerprint(caCertPem: string): string {
  const b64 = caCertPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
}
