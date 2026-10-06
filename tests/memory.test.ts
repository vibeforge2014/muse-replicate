import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * MEM（5.12）验收 + SES-10（memory_store 资源上限）+ 挂载语义（MEM-08）。
 * MEM-03 的 413 形态按 G 车道用 400 断言（单一 JSON 信封）。
 */

let env: TestEnv;
let url: string;
let key: string;

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** 轮询 memory 列表直到条件满足（轮末回写发生在 idle 事件之后，异步完成）。 */
async function waitForMemories(
  storeId: string,
  predicate: (data: any[]) => boolean,
  timeoutMs = 10_000,
): Promise<any[]> {
  const start = Date.now();
  for (;;) {
    const r = await call(url, key, "GET", `/v1/memory-stores/${storeId}/memories?view=full`);
    if (r.status === 200 && predicate(r.json.data)) return r.json.data;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForMemories timeout; last=${JSON.stringify(r.json.data).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function createStore(name: string, description?: string) {
  return call(url, key, "POST", "/v1/memory-stores", { name, ...(description !== undefined ? { description } : {}) });
}

async function putMemory(storeId: string, path: string, content: string, preconditionSha?: string) {
  return call(url, key, "POST", `/v1/memory-stores/${storeId}/memories`, {
    path,
    content,
    ...(preconditionSha !== undefined
      ? { precondition: { type: "content_sha256", content_sha256: preconditionSha } }
      : {}),
  });
}

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

describe("MEM-01 Store 创建与校验", () => {
  test("合法创建 → 201，含 id/slug；非法 name/description → 400", async () => {
    const ok = await createStore("Team Knowledge", "shared notes");
    expect(ok.status).toBe(201);
    expect(ok.json.id).toMatch(/^mstr_/);
    expect(ok.json.type).toBe("memory_store");
    expect(ok.json.slug).toBe("team-knowledge");
    expect(ok.json.description).toBe("shared notes");

    expect((await createStore("")).status).toBe(400);
    expect((await createStore("x".repeat(256))).status).toBe(400);
    expect((await createStore("ok", "y".repeat(1025))).status).toBe(400);
  });

  test("同名 store → slug 去重后仍可创建；列表与 get", async () => {
    const a = await createStore("dup-name");
    const b = await createStore("dup-name");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json.slug).not.toBe(b.json.slug);
    expect(b.json.slug.startsWith("dup-name")).toBe(true);

    const list = await call(url, key, "GET", "/v1/memory-stores");
    expect(list.status).toBe(200);
    expect(list.json.data.some((s: any) => s.id === a.json.id)).toBe(true);
    const one = await call(url, key, "GET", `/v1/memory-stores/${a.json.id}`);
    expect(one.status).toBe(200);
    expect((await call(url, key, "GET", "/v1/memory-stores/mstr_nope")).status).toBe(404);
  });

  test("仍被会话挂载时删除 → 409；无挂载可删除", async () => {
    const store = await createStore("del-me");
    expect(store.status).toBe(201);
    const del = await call(url, key, "DELETE", `/v1/memory-stores/${store.json.id}`);
    expect(del.status).toBe(200);

    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const store2 = await createStore("mounted");
    const session = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: store2.json.id }],
    });
    expect(session.status).toBe(200);
    const del2 = await call(url, key, "DELETE", `/v1/memory-stores/${store2.json.id}`);
    expect(del2.status).toBe(409);
    await call(url, key, "DELETE", `/v1/sessions/${session.json.id}`);
    expect((await call(url, key, "DELETE", `/v1/memory-stores/${store2.json.id}`)).status).toBe(200);
  });
});

describe("MEM-02/03 memory 写入校验", () => {
  test("非法 path → 400；合法多段 path → 201", async () => {
    const store = await createStore("paths");
    const bad = ["/", "/abs", "rel/", "a//b", "a/./b", "a/../b", "a/\x01b", "x".repeat(1025), ".", ".."];
    for (const p of bad) {
      const r = await putMemory(store.json.id, p, "x");
      expect(r.status, `path=${JSON.stringify(p)}`).toBe(400);
    }
    const good = await putMemory(store.json.id, "docs/handbook/intro.md", "# hi");
    expect(good.status).toBe(201);
    expect(good.json.version).toBe(1);
    expect(good.json.path).toBe("docs/handbook/intro.md");
  });

  test("content 超 100 KiB → 400", async () => {
    const store = await createStore("big");
    const r = await putMemory(store.json.id, "big.bin", "x".repeat(100 * 1024 + 1));
    expect(r.status).toBe(400);
    const ok = await putMemory(store.json.id, "big.bin", "x".repeat(100 * 1024));
    expect(ok.status).toBe(201);
  });
});

describe("MEM-04 precondition 更新", () => {
  test("sha 匹配成功、不匹配 409；不存在 + precondition 409", async () => {
    const store = await createStore("pre");
    const v1 = await putMemory(store.json.id, "p.md", "one");
    expect(v1.status).toBe(201);
    const sha1 = v1.json.content_sha256;

    const ok = await putMemory(store.json.id, "p.md", "two", sha1);
    expect(ok.status).toBe(200);
    expect(ok.json.version).toBe(2);
    expect(ok.json.content_sha256).toBe(sha("two"));

    // 旧 sha 已过时 → 409
    const stale = await putMemory(store.json.id, "p.md", "three", sha1);
    expect(stale.status).toBe(409);

    // 不存在的 memory 无法满足 precondition
    const none = await putMemory(store.json.id, "ghost.md", "x", sha("x"));
    expect(none.status).toBe(409);

    // 无 precondition 直接覆盖 → v3
    const v3 = await putMemory(store.json.id, "p.md", "three");
    expect(v3.json.version).toBe(3);
  });

  test("同内容重复写入幂等（不产生空版本）", async () => {
    const store = await createStore("idem");
    const a = await putMemory(store.json.id, "same.md", "stable");
    const b = await putMemory(store.json.id, "same.md", "stable");
    expect(b.json.version).toBe(a.json.version);
  });
});

describe("MEM-05 条件删除", () => {
  test("expected_content_sha256 不匹配 → 拒绝；匹配 → 删除", async () => {
    const store = await createStore("del");
    const v = await putMemory(store.json.id, "gone.md", "bye");
    expect(v.status).toBe(201);
    const wrong = await call(
      url, key, "DELETE",
      `/v1/memory-stores/${store.json.id}/memories/${v.json.id}?expected_content_sha256=${sha("other")}`,
    );
    expect(wrong.status).toBe(409);
    expect((await call(url, key, "GET", `/v1/memory-stores/${store.json.id}/memories/${v.json.id}`)).status).toBe(200);

    const right = await call(
      url, key, "DELETE",
      `/v1/memory-stores/${store.json.id}/memories/${v.json.id}?expected_content_sha256=${v.json.content_sha256}`,
    );
    expect(right.status).toBe(200);
    expect((await call(url, key, "GET", `/v1/memory-stores/${store.json.id}/memories/${v.json.id}`)).status).toBe(404);
  });
});

describe("MEM-06 list 过滤", () => {
  test("path_prefix / depth / view=full limit 上限 / memory_prefix 元素", async () => {
    const store = await createStore("list-store");
    const sid = store.json.id;
    await putMemory(sid, "a/b/c.md", "c1");
    await putMemory(sid, "a/d.md", "d1");
    await putMemory(sid, "e.md", "e1");

    const all = await call(url, key, "GET", `/v1/memory-stores/${sid}/memories`);
    expect(all.status).toBe(200);
    expect(all.json.data.map((m: any) => m.path)).toEqual(["a/b/c.md", "a/d.md", "e.md"]);
    expect(all.json.data.every((m: any) => m.type === "memory" && m.content === undefined)).toBe(true);

    const pref = await call(url, key, "GET", `/v1/memory-stores/${sid}/memories?path_prefix=a`);
    expect(pref.json.data.map((m: any) => m.path)).toEqual(["a/b/c.md", "a/d.md"]);

    // depth=1：a 下的深层路径折叠成 memory_prefix
    const d1 = await call(url, key, "GET", `/v1/memory-stores/${sid}/memories?depth=1`);
    const types = d1.json.data.reduce((acc: Record<string, string[]>, m: any) => {
      (acc[m.type] ??= []).push(m.path);
      return acc;
    }, {});
    expect(types.memory).toEqual(["e.md"]);
    expect(types.memory_prefix).toEqual(["a"]);

    // view=full 带 content；limit > 20 → 400
    const full = await call(url, key, "GET", `/v1/memory-stores/${sid}/memories?view=full`);
    expect(full.json.data.find((m: any) => m.path === "e.md").content).toBe("e1");
    expect((await call(url, key, "GET", `/v1/memory-stores/${sid}/memories?view=full&limit=21`)).status).toBe(400);
    expect((await call(url, key, "GET", `/v1/memory-stores/${sid}/memories?limit=101`)).status).toBe(400);
  });
});

describe("MEM-07 版本与 redact", () => {
  test("每次写入产生版本；head redact 409；历史版本 redact 后字段置 null", async () => {
    const store = await createStore("versions");
    const sid = store.json.id;
    const v1 = await putMemory(sid, "v.md", "one");
    await putMemory(sid, "v.md", "two");
    await putMemory(sid, "v.md", "three");

    const versions = await call(url, key, "GET", `/v1/memory-stores/${sid}/memories/${v1.json.id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.json.data.map((v: any) => v.version)).toEqual([3, 2, 1]);

    const rows = versions.json.data;
    const head = rows.find((v: any) => v.version === 3);
    const oldest = rows.find((v: any) => v.version === 1);
    // head 不可 redact
    const headRedact = await call(url, key, "POST", `/v1/memory-stores/${sid}/memories/${v1.json.id}/versions/${head.id}/redact`);
    expect(headRedact.status).toBe(409);
    // 历史版本 redact：path/content/sha → null，带 redacted_at
    const redacted = await call(url, key, "POST", `/v1/memory-stores/${sid}/memories/${v1.json.id}/versions/${oldest.id}/redact`);
    expect(redacted.status).toBe(200);
    expect(redacted.json.path).toBeNull();
    expect(redacted.json.content_sha256).toBeNull();
    expect(redacted.json.redacted_at).toBeTruthy();
    // 重复 redact 幂等
    expect((await call(url, key, "POST", `/v1/memory-stores/${sid}/memories/${v1.json.id}/versions/${oldest.id}/redact`)).status).toBe(200);
    // head 内容不受影响
    const mem = await call(url, key, "GET", `/v1/memory-stores/${sid}/memories/${v1.json.id}`);
    expect(mem.json.content).toBe("three");
  });
});

describe("SES-10 会话资源上限", () => {
  test("9 个 memory_store → 400；重复挂载同一 store → 400", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      ids.push((await createStore(`cap-${i}`)).json.id);
    }
    const r = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: ids.map((id) => ({ type: "memory_store", memory_store_id: id })),
    });
    expect(r.status).toBe(400);

    const dup = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [
        { type: "memory_store", memory_store_id: ids[0] },
        { type: "memory_store", memory_store_id: ids[0] },
      ],
    });
    expect(dup.status).toBe(400);

    const ok = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: ids.slice(0, 8).map((id) => ({ type: "memory_store", memory_store_id: id })),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.resources.length).toBe(8);
    expect(ok.json.resources[0].mount_path).toBe("/mnt/memory/cap-0");
    await call(url, key, "DELETE", `/v1/sessions/${ok.json.id}`);
  });
});

describe("MEM-08 挂载语义（read_only / read_write）", () => {
  test("read_only：agent 写入失败，无新版本", async () => {
    const store = await createStore("ro-mount");
    const seed = await putMemory(store.json.id, "seed.md", "seed-v1");
    expect(seed.status).toBe(201);

    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: store.json.id, read_only: true }],
    });
    expect(session.status).toBe(200);
    const sid = session.json.id;

    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: `memwrite memory/${store.json.slug}/agent.md nope` }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");

    // agent 汇报写入失败
    const events = await call(url, key, "GET", `/v1/sessions/${sid}/events`);
    const last = events.json.data.filter((e: any) => e.type === "agent.message").at(-1);
    expect(String(last?.content?.[0]?.text ?? "")).toContain("memwrite failed");

    // API 侧没有新 memory、seed 仍是 v1
    const list = await call(url, key, "GET", `/v1/memory-stores/${store.json.id}/memories`);
    expect(list.json.data.map((m: any) => m.path)).toEqual(["seed.md"]);
    expect(list.json.data[0].head_version).toBe(1);
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
  });

  test("read_write：agent 写入后 API 可见新版本；次轮更新再升一版", async () => {
    const store = await createStore("rw-mount");
    const seed = await putMemory(store.json.id, "seed.md", "seed-v1");
    expect(seed.status).toBe(201);

    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "memory_store", memory_store_id: store.json.id, read_only: false }],
    });
    const sid = session.json.id;

    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: `memwrite memory/${store.json.slug}/agent.md agent-note-1` }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");

    let list = await waitForMemories(store.json.id, (data) => data.some((m: any) => m.path === "agent.md" && m.content === "agent-note-1"));
    const agentMem = list.find((m: any) => m.path === "agent.md");
    expect(agentMem, JSON.stringify(list)).toBeTruthy();
    expect(agentMem.head_version).toBe(1);
    const seedMem = list.find((m: any) => m.path === "seed.md");
    expect(seedMem.head_version).toBe(1);

    // 第二轮：物化自 head（agent.md=agent-note-1），agent 改写 → v2
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: `memwrite memory/${store.json.slug}/agent.md agent-note-2` }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");

    list = await waitForMemories(store.json.id, (data) => {
      const m = data.find((d: any) => d.path === "agent.md");
      return m?.head_version === 2 && m?.content === "agent-note-2";
    });
    const agentMem2 = list.find((m: any) => m.path === "agent.md");
    expect(agentMem2.head_version).toBe(2);
    expect(agentMem2.content).toBe("agent-note-2");

    const versions = await call(url, key, "GET", `/v1/memory-stores/${store.json.id}/memories/${agentMem.id}/versions?view=full`);
    expect(versions.json.data.map((v: any) => v.version)).toEqual([2, 1]);
    expect(versions.json.data.find((v: any) => v.version === 1).content).toBe("agent-note-1");
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
  });
});
