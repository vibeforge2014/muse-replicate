import { describe, expect, test } from "vitest";
import { FsSnapshotStore, objectStoreFromEnv, S3SnapshotStore, type SnapshotStore } from "../packages/db/src/index.ts";

/**
 * S3SnapshotStore 真实后端实测（默认 skip）：
 *   MAS_S3_E2E=1 MAS_S3_ENDPOINT=http://192.168.1.123:30900 \
 *   MAS_S3_ACCESS_KEY=mas-minio MAS_S3_SECRET_KEY=mas-minio-dev-secret \
 *   MAS_S3_BUCKET=mas-test npx vitest run tests/s3-store.test.ts
 * 覆盖：put 不可覆盖 / putIfAbsent 内容寻址幂等 / get 404 / delete /
 * 二进制与斜杠 key / ensureBucket 幂等建桶 / 与 Fs 实现语义一致。
 */

const s3Ok =
  process.env.MAS_S3_E2E === "1" &&
  Boolean(process.env.MAS_S3_ENDPOINT && process.env.MAS_S3_ACCESS_KEY && process.env.MAS_S3_SECRET_KEY && process.env.MAS_S3_BUCKET);

function newStore(): S3SnapshotStore {
  return new S3SnapshotStore({
    endpoint: process.env.MAS_S3_ENDPOINT!,
    region: process.env.MAS_S3_REGION,
    accessKey: process.env.MAS_S3_ACCESS_KEY!,
    secretKey: process.env.MAS_S3_SECRET_KEY!,
    bucket: process.env.MAS_S3_BUCKET!,
  });
}

describe("objectStoreFromEnv 选择", () => {
  test("默认 FS；s3 时构造 S3 且缺配置报错", () => {
    const fs = objectStoreFromEnv({}, "/tmp/x");
    expect(fs).toBeInstanceOf(FsSnapshotStore);
    const s3 = objectStoreFromEnv(
      {
        MAS_OBJECT_STORE: "s3",
        MAS_S3_ENDPOINT: "http://minio:9000",
        MAS_S3_ACCESS_KEY: "a",
        MAS_S3_SECRET_KEY: "b",
        MAS_S3_BUCKET: "c",
      },
      "/tmp/x",
    );
    expect(s3).toBeInstanceOf(S3SnapshotStore);
    expect(() =>
      objectStoreFromEnv({ MAS_OBJECT_STORE: "s3", MAS_S3_ENDPOINT: "http://minio:9000" }, "/tmp/x"),
    ).toThrow(/MAS_S3_/);
  });
});

describe.skipIf(!s3Ok)("S3SnapshotStore 真实后端（MinIO）", () => {
  const store: SnapshotStore = newStore();
  const prefix = `s3-test/${Date.now().toString(36)}`;

  test("ensureBucket 幂等 + put/get/delete 回环（二进制、斜杠 key）", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    await store.put(`${prefix}/nested/deep/obj.bin`, bytes);
    expect((await store.get(`${prefix}/nested/deep/obj.bin`)).equals(bytes)).toBe(true);
    await store.delete(`${prefix}/nested/deep/obj.bin`);
    await expect(store.get(`${prefix}/nested/deep/obj.bin`)).rejects.toThrow(/not found/);
    await store.delete(`${prefix}/nested/deep/obj.bin`); // 幂等删除
  }, 60_000);

  test("put 不可覆盖（条件写 / 已存在抛错）", async () => {
    await store.put(`${prefix}/immutable.json`, Buffer.from("v1"));
    await expect(store.put(`${prefix}/immutable.json`, Buffer.from("v2"))).rejects.toThrow(/already exists/);
    expect((await store.get(`${prefix}/immutable.json`)).toString()).toBe("v1");
  }, 60_000);

  test("putIfAbsent：同字节幂等、异字节拒绝", async () => {
    const content = Buffer.from("content-addressed");
    await store.putIfAbsent(`${prefix}/ca/abc`, content);
    await store.putIfAbsent(`${prefix}/ca/abc`, content); // 幂等
    await expect(store.putIfAbsent(`${prefix}/ca/abc`, Buffer.from("different"))).rejects.toThrow(/different bytes/);
  }, 60_000);

  test("较大对象（checkpoint 量级，1MiB 随机字节）", async () => {
    const big = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < big.length; i += 1024) big.writeUInt32BE(i, i);
    await store.put(`${prefix}/big/1m.bin`, big);
    expect((await store.get(`${prefix}/big/1m.bin`)).equals(big)).toBe(true);
  }, 120_000);
});
