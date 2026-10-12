import { beforeAll, describe, expect, test } from "vitest";
import { objectStoreFromEnv, type Database } from "@mas/db";
import type { Kysely } from "kysely";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "@mas/sandbox";
import { gcExpiredFiles, gcIdempotencyKeys, reapOnce, type ReaperDeps } from "../apps/worker/src/reaper.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

/**
 * 文件 TTL（spec §8 files.expires_at）+ 幂等键 TTL（§8：24h）：
 * - 上传可选 expires_at（RFC3339）：未来 → 落库可见；过去/非法 → 400；
 * - 过期即视为不存在：GET/内容 404、列表过滤（GC 有 tick 延迟，读路径先挡）；
 * - reaper GC：过期行 + 内容对象同删；
 * - idempotency_keys 超 TTL 清理。
 */

let env: TestEnv;
let url: string;
let key: string;

/** 最小 spy provider（避免 import reaper.test.ts 连带执行其用例）。 */
class QuietProvider implements SandboxProvider {
  readonly kind = "fake";
  async capabilities() {
    return { isolation: "runc" as const, persistentWorkspace: true, egress: "unsupported" as const };
  }
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    return { sandboxId: "sbx_q", workspaceDir: spec.codexHome, outputsDir: spec.outputsDir, uploadsDir: spec.codexHome };
  }
  async pause() {}
  async resume() {}
  async destroy() {}
}

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function upload(name: string, content: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([content]), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${url}/v1/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: fd,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

describe("文件 TTL 读路径", () => {
  test("上传带未来 expires_at → 落库并回显", async () => {
    const exp = new Date(Date.now() + 3600_000).toISOString();
    const r = await upload("ttl-ok.txt", "data", { expires_at: exp });
    expect(r.status).toBe(200);
    // pg timestamptz 毫秒截断：等值断言放宽到 1s 内
    expect(Math.abs(Date.parse(r.json.expires_at) - Date.parse(exp))).toBeLessThan(1000);
    expect(r.json.id).toMatch(/^file_/);
  });

  test("过去 / 非法 expires_at → 400", async () => {
    const past = await upload("ttl-past.txt", "x", { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(past.status).toBe(400);
    const junk = await upload("ttl-junk.txt", "x", { expires_at: "not-a-date" });
    expect(junk.status).toBe(400);
  });

  test("无 expires_at → null（默认不过期）", async () => {
    const r = await upload("ttl-none.txt", "x");
    expect(r.status).toBe(200);
    expect(r.json.expires_at).toBeNull();
  });

  test("过期后 GET/内容 404、列表过滤（不等 GC tick）", async () => {
    const r = await upload("ttl-gone.txt", "bye");
    const id = r.json.id;
    // 直接倒填过期（GC 触发前的读路径验证）
    await env.db.db.updateTable("files").set({ expires_at: new Date(Date.now() - 60_000) }).where("id", "=", id).execute();
    const meta = await fetch(`${url}/v1/files/${id}`, { headers: { authorization: `Bearer ${key}` } });
    expect(meta.status).toBe(404);
    const content = await fetch(`${url}/v1/files/${id}/content`, { headers: { authorization: `Bearer ${key}` } });
    expect(content.status).toBe(404);
    const list = await (await fetch(`${url}/v1/files`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(list.data.some((f: any) => f.id === id)).toBe(false);
  });
});

describe("reaper GC", () => {
  test("gcExpiredFiles：过期行 + 内容对象同删；未过期保留", async () => {
    const expiring = await upload("gc-me.txt", "expire-body");
    const keep = await upload("gc-keep.txt", "keep-body");
    await env.db.db
      .updateTable("files")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", expiring.json.id)
      .execute();
    const store = objectStoreFromEnv(process.env, process.env.MAS_FILES_DIR ?? "/tmp/mas-files");
    const before = await env.db.db.selectFrom("files").select(["id", "object_key"]).where("id", "in", [expiring.json.id, keep.json.id]).execute();
    const expKey = before.find((r) => r.id === expiring.json.id)!.object_key;

    const n = await gcExpiredFiles(env.db.db, store);
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await env.db.db.selectFrom("files").select("id").where("id", "in", [expiring.json.id, keep.json.id]).execute();
    expect(after.map((r) => r.id)).toEqual([keep.json.id]);
    // 内容对象已删
    await expect(store.get(expKey)).rejects.toThrow();
  });

  test("reapOnce 汇总里包含 gc 计数（fileStore 注入时）", async () => {
    const r = await upload("gc-tick.txt", "x");
    await env.db.db.updateTable("files").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", r.json.id).execute();
    const deps: ReaperDeps = {
      db: env.db.db,
      provider: new QuietProvider(),
      fileStore: objectStoreFromEnv(process.env, process.env.MAS_FILES_DIR ?? "/tmp/mas-files"),
    };
    const res = await reapOnce(deps, { pauseAfterSec: 60, destroyAfterSec: 86_400 });
    expect(res.filesGc).toBeGreaterThanOrEqual(1);
    expect(res.idemGc).toBeGreaterThanOrEqual(0);
  });

  test("gcIdempotencyKeys：超 TTL 删除、新键保留", async () => {
    const ws = await env.db.db.selectFrom("workspaces").select("id").limit(1).executeTakeFirst();
    await env.db.db.insertInto("idempotency_keys").values({
      workspace_id: ws!.id,
      key: "idem_old_test",
      request_hash: "h1",
      response: null,
    }).execute();
    await env.db.db.insertInto("idempotency_keys").values({
      workspace_id: ws!.id,
      key: "idem_fresh_test",
      request_hash: "h2",
      response: null,
    }).execute();
    // 旧键倒填 created_at（>60s TTL）
    await env.db.db.updateTable("idempotency_keys").set({ created_at: new Date(Date.now() - 120_000) }).where("key", "=", "idem_old_test").execute();

    const n = await gcIdempotencyKeys(env.db.db, 60);
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await env.db.db.selectFrom("idempotency_keys").select("key").where("key", "in", ["idem_old_test", "idem_fresh_test"]).execute();
    expect(left.map((r) => r.key)).toEqual(["idem_fresh_test"]);
  });
});
