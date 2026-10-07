import AdmZip from "adm-zip";
import { beforeAll, describe, expect, test } from "vitest";
import { setupEnv, type TestEnv } from "./helpers.ts";

/**
 * multipart Idempotency-Key（偏差 #10 收尾 / M5 5.1 补遗）：
 * files / skills 上传带 Idempotency-Key：同 key 同内容回放首次响应，异内容 409。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function uploadFile(name: string, content: string | Buffer, idemKey?: string) {
  const fd = new FormData();
  fd.append("file", new Blob([content]), name);
  const res = await fetch(`${url}/v1/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: fd,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json };
}

function skillZip(text: string): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(text, "utf8"));
  return zip.toBuffer();
}

async function uploadSkill(bytes: Buffer, idemKey?: string) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes as unknown as BlobPart], { type: "application/zip" }), "skill.zip");
  const res = await fetch(`${url}/v1/skills`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: fd,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json };
}

describe("multipart 幂等（IDEM-M）", () => {
  test("IDEM-M-01 文件上传：同 key 同内容回放（不重复登记）；异内容 409", async () => {
    const k = `idem-file-${Date.now()}`;
    const r1 = await uploadFile("a.txt", "same bytes", k);
    expect(r1.status).toBe(200);
    const r2 = await uploadFile("a.txt", "same bytes", k);
    expect(r2.status).toBe(200);
    expect(r2.json.id).toBe(r1.json.id);

    const conflict = await uploadFile("a.txt", "different bytes", k);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.type).toBe("idempotency_conflict");

    // 不带 key：两个独立 File
    const n1 = await uploadFile("plain.txt", "x");
    const n2 = await uploadFile("plain.txt", "x");
    expect(n1.json.id).not.toBe(n2.json.id);
  });

  test("IDEM-M-02 skill 上传：同 key 同 zip 回放；异 zip 409", async () => {
    const k = `idem-skill-${Date.now()}`;
    const r1 = await uploadSkill(skillZip("# v1\nhello"), k);
    expect(r1.status).toBe(201);
    const r2 = await uploadSkill(skillZip("# v1\nhello"), k);
    expect(r2.status).toBe(201);
    expect(r2.json.id).toBe(r1.json.id);

    const conflict = await uploadSkill(skillZip("# different"), k);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.type).toBe("idempotency_conflict");
  });
});
