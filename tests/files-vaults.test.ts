import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { fakeCodexHome } from "@mas/db";
import { call, createSession, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * FILE（5.10）/ RES / VLT（5.11）验收 + 会话 vault_ids 校验（spec §10.1）+ SES-28。
 * VLT-05~08 依赖 egress-proxy / mcp_oauth 基础设施，按计划随 M4 后续补。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

async function uploadFile(name: string, content: string | Buffer, mime?: string) {
  const fd = new FormData();
  const blob = mime ? new Blob([content], { type: mime }) : new Blob([content]);
  fd.append("file", blob, name);
  const res = await fetch(`${url}/v1/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: fd,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function downloadContent(id: string): Promise<{ status: number; bytes: Buffer; mime: string | null }> {
  const res = await fetch(`${url}/v1/files/${id}/content`, { headers: { authorization: `Bearer ${key}` } });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, mime: res.headers.get("content-type") };
}

describe("FILE 文件 API", () => {
  test("FILE-01 multipart 上传小文件；无 MIME 时 application/octet-stream", async () => {
    const r = await uploadFile("hello.txt", "hello world");
    expect(r.status).toBe(200);
    expect(r.json.filename).toBe("hello.txt");
    expect(r.json.size).toBe(11);
    expect(r.json.mime).toBe("application/octet-stream");
    expect(r.json.id).toMatch(/^file_/);

    const r2 = await uploadFile("typed.json", '{"a":1}', "application/json");
    expect(r2.status).toBe(200);
    expect(r2.json.mime).toBe("application/json");
  });

  test("FILE-02 非法文件名 → 400", async () => {
    for (const bad of [".", "..", 'a<b', 'a>"c', "a|b", "a?b", "a*b", "a:b", "a\x01b", "x".repeat(256)]) {
      const r = await uploadFile(bad, "x");
      expect(r.status).toBe(400);
    }
  });

  test("FILE-03 下载内容 sha256 一致", async () => {
    const content = Buffer.from("sha-check-内容-42");
    const up = await uploadFile("sha.bin", content);
    expect(up.status).toBe(200);
    const dl = await downloadContent(up.json.id);
    expect(dl.status).toBe(200);
    expect(dl.bytes.equals(content)).toBe(true);
    const sha = createHash("sha256").update(content).digest("hex");
    expect(up.json.sha256).toBe(sha);
  });

  test("FILE-04 before_id/after_id 翻页；同传 400", async () => {
    const both = await call(url, key, "GET", "/v1/files?before_id=file_a&after_id=file_b");
    expect(both.status).toBe(400);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await uploadFile(`page-${i}.txt`, `p${i}`);
      ids.push(r.json.id);
    }
    const l1 = await call(url, key, "GET", "/v1/files?limit=2");
    expect(l1.status).toBe(200);
    expect(l1.json.data.length).toBe(2);
    expect(l1.json.next_page).toBeTruthy();
    // after_id 翻页
    const l2 = await call(url, key, "GET", `/v1/files?limit=2&after_id=${l1.json.data[1].id}`);
    expect(l2.json.data.every((f: any) => f.id > l1.json.data[1].id)).toBe(true);
    // before_id 反向
    const l3 = await call(url, key, "GET", `/v1/files?limit=2&before_id=${ids[2]}`);
    expect(l3.json.data.every((f: any) => f.id < ids[2])).toBe(true);
  });

  test("FILE-05 删除后 GET 404", async () => {
    const up = await uploadFile("todelete.txt", "bye");
    const del = await call(url, key, "DELETE", `/v1/files/${up.json.id}`);
    expect(del.status).toBe(200);
    expect((await call(url, key, "GET", `/v1/files/${up.json.id}`)).status).toBe(404);
    expect((await downloadContent(up.json.id)).status).toBe(404);
  });
});

describe("RES 会话资源挂载", () => {
  test("RES-01 创建会话时挂载 file → 沙箱 uploads 可读（worker 物化）", async () => {
    const up = await uploadFile("input.txt", "mounted-content-42");
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId, [
      { type: "user.message", content: [{ type: "text", text: "hi" }] },
    ]);
    // createSession helper 不带 resources，直接再补一次完整创建
    const sid2 = (
      await call(url, key, "POST", "/v1/sessions", {
        agent: agentId,
        environment_id: envId,
        resources: [{ type: "file", file_id: up.json.id, mount_path: "data/input.txt" }],
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
      })
    ).json.id;
    void sid;
    await waitFor(url, key, sid2, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
    const mounted = join(fakeCodexHome(sid2), "uploads", "data", "input.txt");
    expect(existsSync(mounted)).toBe(true);
    expect(readFileSync(mounted, "utf8")).toBe("mounted-content-42");
  });

  test("RES-02 运行中追加挂载 → 下一轮能读到", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = await createSession(url, key, agentId, envId, [
      { type: "user.message", content: [{ type: "text", text: "first" }] },
    ]);
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
    const up = await uploadFile("later.txt", "later-content");
    const add = await call(url, key, "POST", `/v1/sessions/${sid}/resources`, {
      type: "file",
      file_id: up.json.id,
      mount_path: "later.txt",
    });
    expect(add.status).toBe(200);
    const r2 = await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "second" }] }],
    });
    expect(r2.status).toBe(200);
    // 等第二轮完成（第二条 agent.message 出现）
    const start = Date.now();
    for (;;) {
      const es = (await call(url, key, "GET", `/v1/sessions/${sid}/events`)).json.data;
      if (es.filter((e: any) => e.type === "agent.message").length >= 2) break;
      if (Date.now() - start > 15_000) throw new Error("second turn not completed");
      await new Promise((r3) => setTimeout(r3, 150));
    }
    expect(readFileSync(join(fakeCodexHome(sid), "uploads", "later.txt"), "utf8")).toBe("later-content");
  });

  test("RES-06 DELETE 卸载后下一轮读不到", async () => {
    const up = await uploadFile("gone.txt", "will-unmount");
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sidR = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "file", file_id: up.json.id, mount_path: "gone.txt" }],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "one" }] }],
    });
    const sid = sidR.json.id;
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");
    expect(existsSync(join(fakeCodexHome(sid), "uploads", "gone.txt"))).toBe(true);
    const rid = (await call(url, key, "GET", `/v1/sessions/${sid}/resources`)).json.data[0].id;
    expect((await call(url, key, "DELETE", `/v1/sessions/${sid}/resources/${rid}`)).status).toBe(200);
    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "two" }] }],
    });
    // 等第二轮实际执行（第二条 agent.message 出现；卸载发生在轮前物化）
    const start = Date.now();
    for (;;) {
      const es = (await call(url, key, "GET", `/v1/sessions/${sid}/events`)).json.data;
      if (es.filter((e: any) => e.type === "agent.message").length >= 2) break;
      if (Date.now() - start > 15_000) throw new Error("second turn not completed");
      await new Promise((r2) => setTimeout(r2, 150));
    }
    expect(existsSync(join(fakeCodexHome(sid), "uploads", "gone.txt"))).toBe(false);
  });

  test("SES-28 删除会话后挂载的 File 仍存在", async () => {
    const up = await uploadFile("persist.txt", "keep-me");
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const sid = (
      await call(url, key, "POST", "/v1/sessions", {
        agent: agentId,
        environment_id: envId,
        resources: [{ type: "file", file_id: up.json.id, mount_path: "persist.txt" }],
      })
    ).json.id;
    expect((await call(url, key, "DELETE", `/v1/sessions/${sid}`)).status).toBe(200);
    expect((await call(url, key, "GET", `/v1/files/${up.json.id}`)).status).toBe(200);
  });
});

describe("VLT Vaults / Credentials", () => {
  test("VLT-01 创建 Vault（display_name 1–255）", async () => {
    const ok = await call(url, key, "POST", "/v1/vaults", { display_name: "ci-vault" });
    expect(ok.status).toBe(200);
    expect(ok.json.id).toMatch(/^vlt_/);
    expect(ok.json.type).toBe("vault");
    for (const bad of ["", " ".repeat(256)]) {
      expect((await call(url, key, "POST", "/v1/vaults", { display_name: bad })).status).toBe(400);
    }
  });

  test("VLT-02 三种 Credential 创建；任何响应不回显机密", async () => {
    const v = await call(url, key, "POST", "/v1/vaults", { display_name: `v-${Date.now()}` });
    const vid = v.json.id;

    const sb = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/sse", token: "sk-static-abcdef1234" },
    });
    expect(sb.status).toBe(200);
    expect(sb.json.auth.token).toBe("***1234");
    expect(JSON.stringify(sb.json)).not.toContain("sk-static-abcdef1234");

    const br = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: { type: "bearer", mcp_server_url: "https://mcp2.example.com/sse", token: "sk-bearer-xyzw9999" },
    });
    expect(br.status).toBe(200);
    expect(br.json.auth.token).toBe("***9999");
    expect(JSON.stringify(br.json)).not.toContain("sk-bearer-xyzw9999");

    const ev = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: {
        type: "environment_variable",
        secret_name: "EXAMPLE_API_KEY",
        secret_value: "super-secret-value-77",
        networking: { type: "limited", allowed_hosts: ["api.example.com"] },
      },
    });
    expect(ev.status).toBe(200);
    expect(ev.json.auth.secret_value).toBe("***e-77"); // `***` + 末 4 位
    expect(JSON.stringify(ev.json)).not.toContain("super-secret-value-77");

    // 明文不落库：密文列是信封 JSON
    const row = await env.db.db
      .selectFrom("credentials")
      .select(["secret_ciphertext"])
      .where("vault_id", "=", vid)
      .execute();
    expect(row.every((r) => !r.secret_ciphertext.includes("super-secret-value-77"))).toBe(true);
    expect(row.every((r) => r.secret_ciphertext.includes("wdek"))).toBe(true);
  });

  test("VLT-03 environment_variable 缺 networking / allowed_hosts 超 16 → 400", async () => {
    const v = await call(url, key, "POST", "/v1/vaults", { display_name: `v3-${Date.now()}` });
    const vid = v.json.id;
    const noNet = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: { type: "environment_variable", secret_name: "K", secret_value: "v" },
    });
    expect(noNet.status).toBe(400);
    const tooMany = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: {
        type: "environment_variable",
        secret_name: "K2",
        secret_value: "v",
        networking: { type: "limited", allowed_hosts: Array.from({ length: 17 }, (_, i) => `h${i}.example.com`) },
      },
    });
    expect(tooMany.status).toBe(400);
  });

  test("VLT-04 轮换：同 type 只带机密成功；带身份键/改 type → 400", async () => {
    const v = await call(url, key, "POST", "/v1/vaults", { display_name: `v4-${Date.now()}` });
    const vid = v.json.id;
    const c = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/sse", token: "sk-old-token-0000" },
    });
    const cid = c.json.id;

    const rot = await call(url, key, "POST", `/v1/vaults/${vid}/credentials/${cid}`, {
      auth: { type: "static_bearer", token: "sk-new-token-9999" },
    });
    expect(rot.status).toBe(200);
    expect(rot.json.auth.token).toBe("***9999");

    const withIdentity = await call(url, key, "POST", `/v1/vaults/${vid}/credentials/${cid}`, {
      auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/sse", token: "sk-x-1111" },
    });
    expect(withIdentity.status).toBe(400);

    const changeType = await call(url, key, "POST", `/v1/vaults/${vid}/credentials/${cid}`, {
      auth: { type: "environment_variable", secret_value: "v" },
    });
    expect(changeType.status).toBe(400);
  });

  test("VLT-09 归档/删除 Vault 与 Credential；list include_archived", async () => {
    const v = await call(url, key, "POST", "/v1/vaults", { display_name: `v9-${Date.now()}` });
    const vid = v.json.id;
    const c = await call(url, key, "POST", `/v1/vaults/${vid}/credentials`, {
      auth: {
        type: "environment_variable",
        secret_name: "K9",
        secret_value: "v9",
        networking: { type: "unrestricted" },
      },
    });
    const cid = c.json.id;

    expect((await call(url, key, "POST", `/v1/vaults/${vid}/credentials/${cid}/archive`)).status).toBe(200);
    expect((await call(url, key, "POST", `/v1/vaults/${vid}/credentials/${cid}/archive`)).status).toBe(409);
    const creds = await call(url, key, "GET", `/v1/vaults/${vid}/credentials`);
    expect(creds.json.data.length).toBe(0);
    const withArchived = await call(url, key, "GET", `/v1/vaults/${vid}/credentials?include_archived=true`);
    expect(withArchived.json.data.length).toBe(1);

    expect((await call(url, key, "POST", `/v1/vaults/${vid}/archive`)).status).toBe(200);
    expect((await call(url, key, "POST", `/v1/vaults/${vid}/archive`)).status).toBe(409);
    const vaults = await call(url, key, "GET", "/v1/vaults");
    expect(vaults.json.data.every((x: any) => x.id !== vid)).toBe(true);
    const vaultsAll = await call(url, key, "GET", "/v1/vaults?include_archived=true");
    expect(vaultsAll.json.data.some((x: any) => x.id === vid)).toBe(true);

    expect((await call(url, key, "DELETE", `/v1/vaults/${vid}`)).status).toBe(200);
    expect((await call(url, key, "GET", `/v1/vaults/${vid}`)).status).toBe(404);
  });

  test("会话挂载 vault_ids：合法 200；不存在 404；已归档 409（spec §10.1）", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const v = await call(url, key, "POST", "/v1/vaults", { display_name: `vs-${Date.now()}` });
    const ok = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      vault_ids: [v.json.id],
    });
    expect(ok.status).toBe(200);
    expect(ok.json.vault_ids).toEqual([v.json.id]);

    const missing = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      vault_ids: ["vlt_doesnotexist"],
    });
    expect(missing.status).toBe(404);

    await call(url, key, "POST", `/v1/vaults/${v.json.id}/archive`);
    const archived = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      vault_ids: [v.json.id],
    });
    expect(archived.status).toBe(409);
  });
});
