import { createHash, createHmac } from "node:crypto";
import { FsSnapshotStore, type SnapshotStore } from "./checkpoint.js";

/**
 * S3 兼容对象存储实现（MinIO / AWS S3，SigV4 手写签名，零依赖）。
 * 语义对齐 SnapshotStore：
 *  - put：条件写（If-None-Match: *，MinIO 2024-08+/AWS S3 均支持）→ 已存在抛错；
 *    服务端不支持条件写时退化为 HEAD 先检；
 *  - putIfAbsent：HEAD 命中时按 etag(md5)/逐字节比对——内容寻址 key 字节一致幂等成功；
 *  - get：404 抛错（与 Fs 实现的 ENOENT 对齐，调用方 catch）。
 * 单桶布局：key 沿用 Fs 版本的前缀（snapshots/ files/ outputs/ skills/）。
 */

export interface S3StoreOptions {
  endpoint: string; // 如 http://minio.mas.svc.cluster.local:9000（path-style）
  region?: string; // 默认 us-east-1（MinIO 忽略）
  accessKey: string;
  secretKey: string;
  bucket: string;
  /** 首次操作时确保桶存在（幂等 HEAD / PUT /）。 */
  autoCreateBucket?: boolean;
}

const xmlCode = (body: string): string => {
  const m = body.match(/<Code>([^<]+)<\/Code>/);
  return m?.[1] ?? "";
};

export class S3SnapshotStore implements SnapshotStore {
  private readonly url: URL;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly bucket: string;
  private bucketReady = false;

  constructor(opts: S3StoreOptions) {
    this.url = new URL(opts.endpoint.endsWith("/") ? opts.endpoint : `${opts.endpoint}/`);
    this.region = opts.region ?? "us-east-1";
    this.accessKey = opts.accessKey;
    this.secretKey = opts.secretKey;
    this.bucket = opts.bucket;
    this.bucketReady = opts.autoCreateBucket === false;
  }

  private encodeKey(key: string): string {
    return key.split("/").map(encodeURIComponent).join("/");
  }

  /** AWS SigV4 签名请求（path-style）。 */
  private async request(
    method: "HEAD" | "GET" | "PUT" | "DELETE",
    key: string | null,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const path = `/${this.bucket}${key === null ? "" : `/${this.encodeKey(key)}`}`;
    const host = this.url.host; // 含端口（非默认时参与签名，Host 头必须一致）
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretKey}`, dateStamp), this.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const res = await fetch(`${this.url.origin}${path}`, {
      method,
      headers: {
        ...Object.fromEntries(Object.entries(headers).filter(([h]) => h !== "host")),
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
      },
      body: body === undefined ? undefined : new Uint8Array(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body: buf };
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    const head = await this.request("HEAD", null);
    if (head.status === 404) {
      const put = await this.request("PUT", null);
      if (put.status !== 200) throw new Error(`create bucket ${this.bucket}: ${put.status} ${xmlCode(put.body.toString())}`);
    } else if (head.status >= 300) {
      throw new Error(`head bucket ${this.bucket}: ${head.status} ${xmlCode(head.body.toString())}`);
    }
    this.bucketReady = true;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await this.ensureBucket();
    // 条件写：已存在 → 412 PreconditionFailed（MinIO 2024-08+ / AWS S3）
    const cond = await this.request("PUT", key, bytes, { "if-none-match": "*" });
    if (cond.status === 412) throw new Error(`snapshot object already exists: ${key}`);
    if (cond.status >= 300) {
      if (cond.status === 501 || xmlCode(cond.body.toString()).toLowerCase().includes("condition")) {
        // 服务端不支持条件写：退化为 HEAD 先检（竞态窗口由不可变 key 命名兜底）
        const head = await this.request("HEAD", key);
        if (head.status === 200) throw new Error(`snapshot object already exists: ${key}`);
        const plain = await this.request("PUT", key, bytes);
        if (plain.status >= 300) throw new Error(`put ${key}: ${plain.status} ${xmlCode(plain.body.toString())}`);
        return;
      }
      throw new Error(`put ${key}: ${cond.status} ${xmlCode(cond.body.toString())}`);
    }
  }

  async putIfAbsent(key: string, bytes: Buffer): Promise<void> {
    await this.ensureBucket();
    const head = await this.request("HEAD", key);
    if (head.status === 404) {
      const r = await this.request("PUT", key, bytes);
      if (r.status >= 300) throw new Error(`put ${key}: ${r.status} ${xmlCode(r.body.toString())}`);
      return;
    }
    if (head.status >= 300) throw new Error(`head ${key}: ${head.status}`);
    // 已存在：内容寻址 key → 字节一致幂等成功，不一致拒绝
    const etag = (head.headers.get("etag") ?? "").replace(/"/g, "");
    if (/^[0-9a-f]{32}$/.test(etag)) {
      const md5 = createHash("md5").update(bytes).digest("hex");
      if (etag === md5) return;
      throw new Error(`snapshot object ${key} exists with different bytes`);
    }
    const existing = await this.get(key);
    if (!existing.equals(bytes)) throw new Error(`snapshot object ${key} exists with different bytes`);
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.request("GET", key);
    if (r.status === 404) throw new Error(`snapshot object not found: ${key}`);
    if (r.status >= 300) throw new Error(`get ${key}: ${r.status} ${xmlCode(r.body.toString())}`);
    return r.body;
  }

  async delete(key: string): Promise<void> {
    const r = await this.request("DELETE", key);
    if (r.status >= 300 && r.status !== 404) throw new Error(`delete ${key}: ${r.status}`);
  }
}

/** MAS_OBJECT_STORE=s3 时用 S3，否则本地 FS（key 布局一致，可无损切换）。 */
export function objectStoreFromEnv(
  env: NodeJS.ProcessEnv,
  fsRoot: string,
): SnapshotStore {
  if (env.MAS_OBJECT_STORE === "s3") {
    if (!env.MAS_S3_ENDPOINT || !env.MAS_S3_ACCESS_KEY || !env.MAS_S3_SECRET_KEY || !env.MAS_S3_BUCKET) {
      throw new Error("MAS_OBJECT_STORE=s3 需要 MAS_S3_ENDPOINT/MAS_S3_ACCESS_KEY/MAS_S3_SECRET_KEY/MAS_S3_BUCKET");
    }
    return new S3SnapshotStore({
      endpoint: env.MAS_S3_ENDPOINT,
      region: env.MAS_S3_REGION,
      accessKey: env.MAS_S3_ACCESS_KEY,
      secretKey: env.MAS_S3_SECRET_KEY,
      bucket: env.MAS_S3_BUCKET,
    });
  }
  return new FsSnapshotStore(fsRoot);
}
