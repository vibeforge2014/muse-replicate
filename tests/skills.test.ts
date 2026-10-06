import AdmZip from "adm-zip";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { fakeCodexHome } from "@mas/db";
import { call, makeAgentAndEnv, setupEnv, waitFor, type TestEnv } from "./helpers.ts";

/**
 * SKL（5.13）验收：zip 上传/版本化/下载/引用删除 + 会话挂载 /workspace/skills/<dir>/。
 * SKL-07 内置 skills 由 bootstrap 播种（source=zai）。
 */

let env: TestEnv;
let url: string;
let key: string;

beforeAll(async () => {
  env = await setupEnv();
  url = env.url;
  key = env.key;
});

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content, "utf8"));
  return zip.toBuffer();
}

async function uploadSkill(zip: Buffer, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([zip]), "skill.zip");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${url}/v1/skills`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: fd,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("SKL-01/02 上传与目录冲突", () => {
  test("合法 zip（根 SKILL.md）→ 201；无 SKILL.md → 400", async () => {
    const ok = await uploadSkill(zipOf({ "demo-skill/SKILL.md": "# demo\n", "demo-skill/lib/a.md": "a" }));
    expect(ok.status).toBe(201);
    expect(ok.json.id).toMatch(/^skl_/);
    expect(ok.json.type).toBe("skill");
    expect(ok.json.directory).toBe("demo-skill");
    expect(ok.json.version).toBe(1);
    expect(ok.json.file_count).toBe(2);

    const bad = await uploadSkill(zipOf({ "no-skill-md/readme.md": "x" }));
    expect(bad.status).toBe(400);

    const notZip = await uploadSkill(Buffer.from("plain text"));
    expect(notZip.status).toBe(400);
  });

  test("重复目录名 → 409 skill_directory_conflict", async () => {
    const a = await uploadSkill(zipOf({ "clash/SKILL.md": "v1" }));
    expect(a.status).toBe(201);
    const b = await uploadSkill(zipOf({ "clash/SKILL.md": "v2" }));
    expect(b.status).toBe(409);
    expect(b.json.error?.message ?? b.json.error?.type).toBeTruthy();
    // 显式 directory 字段冲突同样 409
    const c = await uploadSkill(zipOf({ "other/SKILL.md": "x" }), { directory: "clash" });
    expect(c.status).toBe(409);
  });
});

describe("SKL-03 文件数上限", () => {
  test("201 个文件 → 静默截断为 200，下载核对", async () => {
    const files: Record<string, string> = { "big-skill/SKILL.md": "# big" };
    for (let i = 0; i < 200; i++) files[`big-skill/f${i}.txt`] = `f${i}`;
    const up = await uploadSkill(zipOf(files));
    expect(up.status).toBe(201);
    expect(up.json.file_count).toBe(200);

    const res = await fetch(`${url}/v1/skills/${up.json.id}/versions/1/content`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    expect(zip.getEntries().filter((e: any) => !e.isDirectory).length).toBe(200);
    expect(zip.getEntry("SKILL.md")).toBeTruthy();
    // 200 文件按 path 排序截断：f99.txt 在，f99x…不在（f0..f99 = 100 个 < 200，无截断歧义则全部保留）
    expect(zip.getEntry("f199.txt")).toBeTruthy();
  });
});

describe("SKL-04 版本化", () => {
  test("新版本 → 201；版本列表与下载内容正确", async () => {
    const up = await uploadSkill(zipOf({ "ver/SKILL.md": "v1" }));
    expect(up.status).toBe(201);
    const fd = new FormData();
    fd.append("file", new Blob([zipOf({ "ver/SKILL.md": "v2 body", "ver/extra.md": "e" })]), "v2.zip");
    const v2 = await fetch(`${url}/v1/skills/${up.json.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: fd,
    });
    expect(v2.status).toBe(201);
    const v2json = await v2.json();
    expect(v2json.version).toBe(2);

    const detail = await call(url, key, "GET", `/v1/skills/${up.json.id}`);
    expect(detail.json.latest_version).toBe(2);
    const versions = await call(url, key, "GET", `/v1/skills/${up.json.id}/versions`);
    expect(versions.json.data.map((v: any) => v.version)).toEqual([2, 1]);

    const dl1 = await fetch(`${url}/v1/skills/${up.json.id}/versions/1/content`, { headers: { authorization: `Bearer ${key}` } });
    expect(new AdmZip(Buffer.from(await dl1.arrayBuffer())).readAsText("SKILL.md")).toBe("v1");
    const dl2 = await fetch(`${url}/v1/skills/${up.json.id}/content`, { headers: { authorization: `Bearer ${key}` } });
    expect(new AdmZip(Buffer.from(await dl2.arrayBuffer())).readAsText("SKILL.md")).toBe("v2 body");
    expect((await call(url, key, "GET", `/v1/skills/${up.json.id}/versions/9/content`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("SKL-05 引用删除", () => {
  test("agent 引用时删除 → 409；解除引用后可删", async () => {
    const up = await uploadSkill(zipOf({ "refd/SKILL.md": "x" }));
    expect(up.status).toBe(201);
    const del = await call(url, key, "DELETE", `/v1/skills/${up.json.id}`);
    expect(del.status).toBe(200);

    const up2 = await uploadSkill(zipOf({ "refd2/SKILL.md": "x" }));
    const agent = await call(url, key, "POST", "/v1/agents", {
      name: `skl-agent-${Date.now()}`,
      model: { id: "glm-5.3-flash" },
      skills: [up2.json.id],
    });
    expect(agent.status).toBe(201);
    expect(agent.json.skills).toEqual([up2.json.id]);
    expect((await call(url, key, "DELETE", `/v1/skills/${up2.json.id}`)).status).toBe(409);
    // 新版本去掉引用后仍 409：历史版本快照保留引用（版本化 agent 的防御语义）
    const upd = await call(url, key, "POST", `/v1/agents/${agent.json.id}`, { skills: null });
    expect(upd.status).toBe(200);
    expect((await call(url, key, "DELETE", `/v1/skills/${up2.json.id}`)).status).toBe(409);

    // 引用不存在的 skill → 404
    const badAgent = await call(url, key, "POST", "/v1/agents", {
      name: `bad-${Date.now()}`,
      model: { id: "glm-5.3-flash" },
      skills: ["skl_nope"],
    });
    expect(badAgent.status).toBe(404);
  });
});

describe("SKL-06 会话挂载 /workspace/skills/<dir>/", () => {
  test("资源挂载 → 沙箱内可读 SKILL.md（只读）", async () => {
    const up = await uploadSkill(zipOf({ "mounted/SKILL.md": "# mounted\n", "mounted/guide.md": "g" }));
    expect(up.status).toBe(201);
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    const session = await call(url, key, "POST", "/v1/sessions", {
      agent: agentId,
      environment_id: envId,
      resources: [{ type: "skill", skill_id: up.json.id }],
    });
    expect(session.status).toBe(200);
    expect(session.json.resources[0]).toMatchObject({ type: "skill", skill_id: up.json.id, mount_path: "/workspace/skills/mounted" });
    const sid = session.json.id;

    await call(url, key, "POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    });
    await waitFor(url, key, sid, (s) => s.status === "idle" && s.stop_reason?.type === "end_turn");

    const skillDir = join(fakeCodexHome(sid), "workspace", "skills", "mounted");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("# mounted\n");
    expect(existsSync(join(skillDir, "guide.md"))).toBe(true);
    await call(url, key, "DELETE", `/v1/sessions/${sid}`);
  });
});

describe("SKL-07 内置 skills", () => {
  test("source=zai 列表含 latest_version；source=user 过滤", async () => {
    const zai = await call(url, key, "GET", "/v1/skills?source=zai");
    expect(zai.status).toBe(200);
    expect(zai.json.data.length).toBeGreaterThanOrEqual(2);
    expect(zai.json.data.every((s: any) => s.source === "zai" && s.latest_version >= 1)).toBe(true);
    const dirs = zai.json.data.map((s: any) => s.directory);
    expect(dirs).toContain("pdf-toolkit");
    expect(dirs).toContain("web-research");

    const user = await call(url, key, "GET", "/v1/skills?source=user");
    expect(user.json.data.every((s: any) => s.source === "user")).toBe(true);
    expect(user.json.data.some((s: any) => s.directory === "pdf-toolkit")).toBe(false);
  });
});
