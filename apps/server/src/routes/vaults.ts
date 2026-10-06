import type { FastifyInstance } from "fastify";
import type { Selectable } from "kysely";
import {
  decodeCursor,
  encodeCursor,
  errConflict,
  errInvalid,
  errNotFound,
  maskSecret,
  newId,
  openSecret,
  sealSecret,
} from "@mas/core";
import type { CredentialRow, VaultRow } from "@mas/db";
import type { RouteCtx } from "./agents.js";

/**
 * Vaults / Credentials（spec §10.1、§11.4）：
 * 机密字段信封加密存储，API 永不回显（只返回 `***` + 末 4 位）。
 * 轮换按 credential id：同 type 只带机密；带身份键或改 type 都拒绝。
 */

const iso = (d: Date | undefined | null) =>
  d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const CREDENTIAL_TYPES = ["environment_variable", "static_bearer", "bearer"] as const;
type CredentialType = (typeof CREDENTIAL_TYPES)[number];

interface NetworkingJson {
  type: "unrestricted" | "limited";
  allowed_hosts?: string[];
}

function vaultJson(v: Selectable<VaultRow>) {
  return {
    id: v.id,
    type: "vault",
    display_name: v.display_name,
    metadata: v.metadata,
    archived_at: v.archived_at ? iso(v.archived_at) : null,
    created_at: iso(v.created_at),
    updated_at: iso(v.updated_at),
  };
}

function credentialJson(c: Selectable<CredentialRow>) {
  const masked = `***${c.last_four}`;
  const auth: Record<string, unknown> = { type: c.type };
  if (c.type === "environment_variable") {
    auth.secret_name = c.identity_key;
    auth.secret_value = masked;
    auth.networking = c.networking;
    if (c.injection) auth.injection = c.injection;
  } else {
    auth.mcp_server_url = c.identity_key;
    auth.token = masked;
  }
  return {
    id: c.id,
    type: "credential",
    vault_id: c.vault_id,
    auth,
    archived_at: c.archived_at ? iso(c.archived_at) : null,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}

/** 校验并抽取 credential 输入；返回统一形态。 */
function parseCredentialAuth(body: unknown): {
  type: CredentialType;
  identityKey: string;
  secret: string;
  networking: NetworkingJson | null;
  injection: Record<string, unknown> | null;
} {
  if (typeof body !== "object" || body === null) throw errInvalid("body must be {auth: {...}}");
  const auth = (body as { auth?: unknown }).auth;
  if (typeof auth !== "object" || auth === null) throw errInvalid("body must be {auth: {...}}");
  const a = auth as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== "string" || !CREDENTIAL_TYPES.includes(type as CredentialType)) {
    throw errInvalid(`auth.type must be one of ${CREDENTIAL_TYPES.join(", ")}`);
  }
  const credType = type as CredentialType;
  if (credType === "environment_variable") {
    const secretName = typeof a.secret_name === "string" ? a.secret_name.trim() : "";
    if (!secretName) throw errInvalid("environment_variable requires secret_name");
    const secretValue = typeof a.secret_value === "string" ? a.secret_value : "";
    if (!secretValue) throw errInvalid("environment_variable requires secret_value");
    const networking = a.networking as NetworkingJson | undefined;
    if (!networking || (networking.type !== "unrestricted" && networking.type !== "limited")) {
      throw errInvalid("environment_variable requires networking {type: unrestricted|limited}");
    }
    if (networking.type === "limited") {
      const hosts = networking.allowed_hosts;
      if (!Array.isArray(hosts) || hosts.length < 1) {
        throw errInvalid("limited networking requires allowed_hosts");
      }
      if (hosts.length > 16) throw errInvalid("allowed_hosts exceeds 16 entries");
      for (const h of hosts) {
        if (typeof h !== "string" || !h.trim()) throw errInvalid("allowed_hosts entries must be non-empty strings");
      }
    }
    let injection: Record<string, unknown> | null = null;
    if (a.injection !== undefined) {
      if (typeof a.injection !== "object" || a.injection === null) {
        throw errInvalid("injection must be an object");
      }
      injection = a.injection as Record<string, unknown>;
    }
    return { type: credType, identityKey: secretName, secret: secretValue, networking, injection };
  }
  // static_bearer / bearer
  const url = typeof a.mcp_server_url === "string" ? a.mcp_server_url.trim() : "";
  if (!url) throw errInvalid(`${credType} requires mcp_server_url`);
  const token = typeof a.token === "string" ? a.token : "";
  if (!token) throw errInvalid(`${credType} requires token`);
  return { type: credType, identityKey: url, secret: token, networking: null, injection: null };
}

async function getVaultRow(ctx: RouteCtx, ws: string, id: string): Promise<Selectable<VaultRow>> {
  const row = await ctx.db
    .selectFrom("vaults")
    .selectAll()
    .where("id", "=", id)
    .where("workspace_id", "=", ws)
    .executeTakeFirst();
  if (!row) throw errNotFound(`vault ${id} not found`);
  return row;
}

export function registerVaultRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  // ---- Vault CRUD ----
  app.post("/v1/vaults", async (req) => {
    const ws = req.mas.auth!.workspaceId;
    const body = req.body as { display_name?: unknown; metadata?: unknown };
    const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
    if (displayName.length < 1 || displayName.length > 255) {
      throw errInvalid("display_name must be 1-255 characters");
    }
    const metadata =
      body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, string>)
        : {};
    const id = newId("vlt");
    await ctx.db
      .insertInto("vaults")
      .values({ id, workspace_id: ws, display_name: displayName, metadata })
      .execute();
    const row = await getVaultRow(ctx, ws, id);
    return vaultJson(row);
  });

  app.get("/v1/vaults", async (req) => {
    const ws = req.mas.auth!.workspaceId;
    const query = req.query as Record<string, string>;
    const includeArchived = query.include_archived === "true";
    const cursor = decodeCursor(query.page);
    const limit = Math.min(Number(query.limit ?? 100) || 100, 100);
    const rows = await ctx.db
      .selectFrom("vaults")
      .selectAll()
      .where("workspace_id", "=", ws)
      .$if(!includeArchived, (q) => q.where("archived_at", "is", null))
      .$if(!!cursor, (q) => q.where("id", ">", cursor!.k))
      .orderBy("id", "asc")
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const nextPage =
      rows.length > limit ? encodeCursor({ k: page[page.length - 1]!.id, d: "asc" }) : null;
    return { data: page.map(vaultJson), next_page: nextPage };
  });

  app.get("/v1/vaults/:id", async (req) => {
    const { id } = req.params as { id: string };
    return vaultJson(await getVaultRow(ctx, req.mas.auth!.workspaceId, id));
  });

  app.post("/v1/vaults/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    const row = await getVaultRow(ctx, ws, id);
    if (row.archived_at) throw errConflict("vault is archived");
    await ctx.db.updateTable("vaults").set({ archived_at: new Date(), updated_at: new Date() }).where("id", "=", id).execute();
    return vaultJson(await getVaultRow(ctx, ws, id));
  });

  app.delete("/v1/vaults/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    await getVaultRow(ctx, ws, id);
    await ctx.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("credentials").where("vault_id", "=", id).execute();
      await tx.deleteFrom("vaults").where("id", "=", id).execute();
    });
    return { id, type: "vault_deleted" };
  });

  // ---- Credentials ----
  app.post("/v1/vaults/:id/credentials", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    const vault = await getVaultRow(ctx, ws, id);
    if (vault.archived_at) throw errConflict("vault is archived");
    const parsed = parseCredentialAuth(req.body);
    const existing = await ctx.db
      .selectFrom("credentials")
      .select(["id"])
      .where("vault_id", "=", id)
      .where("type", "=", parsed.type)
      .where("identity_key", "=", parsed.identityKey)
      .executeTakeFirst();
    if (existing) throw errConflict("credential with same type and identity already exists");
    const cid = newId("vcrd");
    await ctx.db
      .insertInto("credentials")
      .values({
        id: cid,
        vault_id: id,
        workspace_id: ws,
        type: parsed.type,
        identity_key: parsed.identityKey,
        secret_ciphertext: sealSecret(parsed.secret),
        networking: (parsed.networking ?? {}) as Record<string, unknown>,
        injection: parsed.injection,
        last_four: parsed.secret.slice(-4),
      })
      .execute();
    const row = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("id", "=", cid)
      .executeTakeFirst();
    return credentialJson(row!);
  });

  app.get("/v1/vaults/:id/credentials", async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.mas.auth!.workspaceId;
    await getVaultRow(ctx, ws, id);
    const query = req.query as Record<string, string | string[]>;
    const includeArchived = query.include_archived === "true";
    const rows = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("vault_id", "=", id)
      .$if(!includeArchived, (q) => q.where("archived_at", "is", null))
      .orderBy("id", "asc")
      .limit(1000)
      .execute();
    return { data: rows.map(credentialJson), next_page: null };
  });

  app.get("/v1/vaults/:id/credentials/:cid", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const ws = req.mas.auth!.workspaceId;
    await getVaultRow(ctx, ws, id);
    const row = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("id", "=", cid)
      .where("vault_id", "=", id)
      .executeTakeFirst();
    if (!row) throw errNotFound(`credential ${cid} not found`);
    return credentialJson(row);
  });

  // 轮换：同 type 只带新机密；身份键出现或 type 变化都拒绝（VLT-04）
  app.post("/v1/vaults/:id/credentials/:cid", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const ws = req.mas.auth!.workspaceId;
    await getVaultRow(ctx, ws, id);
    const row = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("id", "=", cid)
      .where("vault_id", "=", id)
      .executeTakeFirst();
    if (!row) throw errNotFound(`credential ${cid} not found`);
    if (row.archived_at) throw errConflict("credential is archived");
    const body = req.body as { auth?: Record<string, unknown> } | null;
    const auth = body?.auth;
    if (!auth || typeof auth !== "object") throw errInvalid("body must be {auth: {...}}");
    if (auth.type !== undefined && auth.type !== row.type) {
      throw errInvalid("credential type cannot change on rotation");
    }
    for (const k of ["secret_name", "mcp_server_url", "networking", "injection"]) {
      if (auth[k] !== undefined) throw errInvalid(`identity/config field ${k} cannot be passed on rotation`);
    }
    const secret = row.type === "environment_variable" ? auth.secret_value : auth.token;
    if (typeof secret !== "string" || !secret) {
      throw errInvalid(row.type === "environment_variable" ? "rotation requires secret_value" : "rotation requires token");
    }
    void openSecret(row.secret_ciphertext); // 旧值仍可解密（完整性探测）
    await ctx.db
      .updateTable("credentials")
      .set({ secret_ciphertext: sealSecret(secret), last_four: secret.slice(-4), updated_at: new Date() })
      .where("id", "=", cid)
      .execute();
    const updated = await ctx.db.selectFrom("credentials").selectAll().where("id", "=", cid).executeTakeFirst();
    return credentialJson(updated!);
  });

  app.post("/v1/vaults/:id/credentials/:cid/archive", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const ws = req.mas.auth!.workspaceId;
    await getVaultRow(ctx, ws, id);
    const row = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("id", "=", cid)
      .where("vault_id", "=", id)
      .executeTakeFirst();
    if (!row) throw errNotFound(`credential ${cid} not found`);
    if (row.archived_at) throw errConflict("credential is archived");
    await ctx.db
      .updateTable("credentials")
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where("id", "=", cid)
      .execute();
    const updated = await ctx.db.selectFrom("credentials").selectAll().where("id", "=", cid).executeTakeFirst();
    return credentialJson(updated!);
  });

  app.delete("/v1/vaults/:id/credentials/:cid", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const ws = req.mas.auth!.workspaceId;
    await getVaultRow(ctx, ws, id);
    const row = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("id", "=", cid)
      .where("vault_id", "=", id)
      .executeTakeFirst();
    if (!row) throw errNotFound(`credential ${cid} not found`);
    await ctx.db.deleteFrom("credentials").where("id", "=", cid).execute();
    return { id: cid, type: "credential_deleted" };
  });
}

// 供其他模块复用（掩码语义一致性测试）
export { maskSecret };
