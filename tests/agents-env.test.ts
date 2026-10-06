import { beforeEach, describe, expect, it } from "vitest";
import { call, makeAgentAndEnv, setupEnv } from "./helpers.ts";

let url = "";
let key = "";
beforeEach(async () => {
  const env = await setupEnv();
  url = env.url;
  key = env.key;
});

describe("AUTH / GEN", () => {
  it("AUTH-01: no authorization → 401 authentication_error", async () => {
    const r = await call(url, null, "GET", "/v1/agents");
    expect(r.status).toBe(401);
    expect(r.json.error.type).toBe("authentication_error");
    expect(r.json.request_id).toMatch(/^req_/);
  });

  it("AUTH-02: invalid key → 401", async () => {
    const r = await call(url, "mas_sk_invalid", "GET", "/v1/agents");
    expect(r.status).toBe(401);
  });

  it("AUTH-07-style: unknown resource id → 404 not_found_error", async () => {
    const r = await call(url, key, "GET", "/v1/agents/agent_doesnotexist");
    expect(r.status).toBe(404);
    expect(r.json.error.type).toBe("not_found_error");
  });

  it("GEN-02: unknown field → 400", async () => {
    const r = await call(url, key, "POST", "/v1/agents", {
      name: "x",
      model: { id: "glm-5.3-flash" },
      foo: "bar",
    });
    expect(r.status).toBe(400);
    expect(r.json.error.type).toBe("invalid_request_error");
  });

  it("C-04/C-05: id 前缀与时间戳格式", async () => {
    const r = await call(url, key, "POST", "/v1/agents", { name: "pfx", model: { id: "m" } });
    expect(r.json.id).toMatch(/^agent_/);
    expect(r.json.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(r.headers["request-id"]).toMatch(/^req_/);
  });
});

describe("AGT", () => {
  it("AGT-01: minimal create → 201, version=1, tools=[]", async () => {
    const r = await call(url, key, "POST", "/v1/agents", { name: "min", model: { id: "glm-5.3-flash" } });
    expect(r.status).toBe(201);
    expect(r.json.version).toBe(1);
    expect(r.json.tools).toEqual([]);
    expect(r.json.archived_at).toBeNull();
  });

  it("AGT-05: empty/long name → 400", async () => {
    const a = await call(url, key, "POST", "/v1/agents", { name: "", model: { id: "m" } });
    expect(a.status).toBe(400);
    const b = await call(url, key, "POST", "/v1/agents", { name: "x".repeat(257), model: { id: "m" } });
    expect(b.status).toBe(400);
  });

  it("AGT-16/17: update bumps version; no-change update does not", async () => {
    const { agentId } = await makeAgentAndEnv(url, key);
    const u1 = await call(url, key, "POST", `/v1/agents/${agentId}`, { name: "renamed" });
    expect(u1.json.version).toBe(2);
    const u2 = await call(url, key, "POST", `/v1/agents/${agentId}`, { name: "renamed" });
    expect(u2.json.version).toBe(2);
  });

  it("AGT-18: optimistic lock mismatch → 409", async () => {
    const { agentId } = await makeAgentAndEnv(url, key);
    const r = await call(url, key, "POST", `/v1/agents/${agentId}`, {
      name: "v2",
      version: 1,
    });
    expect(r.status).toBe(200);
    const r2 = await call(url, key, "POST", `/v1/agents/${agentId}`, {
      name: "stale",
      version: 1,
    });
    expect(r2.status).toBe(409);
  });

  it("AGT-22: version list = full snapshots", async () => {
    const { agentId } = await makeAgentAndEnv(url, key);
    await call(url, key, "POST", `/v1/agents/${agentId}`, { name: "n2" });
    await call(url, key, "POST", `/v1/agents/${agentId}`, { name: "n3" });
    const r = await call(url, key, "GET", `/v1/agents/${agentId}/versions`);
    expect(r.json.data).toHaveLength(3);
    expect(r.json.data.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(r.json.data[2].name).toBe("n3");
  });

  it("AGT-23: archive idempotent → 200", async () => {
    const { agentId } = await makeAgentAndEnv(url, key);
    const a = await call(url, key, "POST", `/v1/agents/${agentId}/archive`);
    expect(a.status).toBe(200);
    expect(a.json.archived_at).not.toBeNull();
    const b = await call(url, key, "POST", `/v1/agents/${agentId}/archive`);
    expect(b.status).toBe(200);
  });

  it("AGT-25: archived agent cannot create session", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    await call(url, key, "POST", `/v1/agents/${agentId}/archive`);
    const r = await call(url, key, "POST", "/v1/sessions", { agent: agentId, environment_id: envId });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect([404, 400, 409]).toContain(r.status);
  });
});

describe("ENV", () => {
  it("ENV-01: minimal create → 200, normalized", async () => {
    const r = await call(url, key, "POST", "/v1/environments", {
      name: "e1",
      config: { type: "cloud" },
    });
    expect(r.status).toBe(200);
    expect(r.json.config.networking.type).toBe("unrestricted");
    for (const k of ["apt", "npm", "pip", "cargo", "gem", "go"]) {
      expect(r.json.config.packages[k]).toEqual([]);
    }
  });

  it("ENV-05: unrestricted + allowed_hosts → 400", async () => {
    const r = await call(url, key, "POST", "/v1/environments", {
      name: "e2",
      config: { type: "cloud", networking: { type: "unrestricted", allowed_hosts: ["a.com"] } as never },
    });
    expect(r.status).toBe(400);
  });

  it("ENV-03: allowed_hosts with scheme/port/path → 400", async () => {
    for (const bad of ["https://a.com", "a.com:443", "a.com/path"]) {
      const r = await call(url, key, "POST", "/v1/environments", {
        name: "e3",
        config: { type: "cloud", networking: { type: "limited", allowed_hosts: [bad] } },
      });
      expect(r.status, bad).toBe(400);
    }
  });

  it("ENV-06: packages + limited without allow_package_managers → 400", async () => {
    const r = await call(url, key, "POST", "/v1/environments", {
      name: "e4",
      config: {
        type: "cloud",
        packages: { pip: ["requests"] },
        networking: { type: "limited", allowed_hosts: ["pypi.org"] },
      },
    });
    expect(r.status).toBe(400);
  });

  it("ENV-09: update replaces config wholesale", async () => {
    const { envId } = await makeAgentAndEnv(url, key);
    const r = await call(url, key, "POST", `/v1/environments/${envId}`, {
      config: { type: "cloud", packages: { pip: ["a"] } },
    });
    expect(r.status).toBe(200);
    expect(r.json.config.packages.pip).toEqual(["a"]);
    const r2 = await call(url, key, "POST", `/v1/environments/${envId}`, {
      config: { type: "cloud" },
    });
    expect(r2.json.config.packages.pip).toEqual([]);
  });

  it("ENV-10: update archived → 400", async () => {
    const { envId } = await makeAgentAndEnv(url, key);
    await call(url, key, "POST", `/v1/environments/${envId}/archive`);
    const r = await call(url, key, "POST", `/v1/environments/${envId}`, { name: "x" });
    expect(r.status).toBe(400);
  });

  it("ENV-11: archived env cannot create session", async () => {
    const { agentId, envId } = await makeAgentAndEnv(url, key);
    await call(url, key, "POST", `/v1/environments/${envId}/archive`);
    const r = await call(url, key, "POST", "/v1/sessions", { agent: agentId, environment_id: envId });
    expect(r.status).toBe(400);
  });
});
