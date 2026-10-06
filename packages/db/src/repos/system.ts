import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../schema.js";
import { seedBuiltinSkills } from "../skills.js";
import { FsSnapshotStore } from "../checkpoint.js";

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface BootstrapResult {
  orgId: string;
  workspaceId: string;
  apiKey: string; // 只在创建时返回明文
}

/** 首次启动：创建默认 org/workspace，并发放一个 API key（幂等）；播种内置 skills（SKL-07）。 */
export async function bootstrap(
  db: Kysely<Database>,
  opts: { orgName?: string; workspaceName?: string } = {},
): Promise<BootstrapResult> {
  const result = await db.transaction().execute(async (tx) => {
    let org = await tx.selectFrom("orgs").select(["id"]).limit(1).executeTakeFirst();
    if (!org) {
      const orgId = `org_${randomBytes(10).toString("hex")}`;
      await tx.insertInto("orgs").values({ id: orgId, name: opts.orgName ?? "default" }).execute();
      org = { id: orgId };
    }
    let ws = await tx
      .selectFrom("workspaces")
      .select(["id"])
      .where("org_id", "=", org.id)
      .limit(1)
      .executeTakeFirst();
    if (!ws) {
      const wsId = `ws_${randomBytes(10).toString("hex")}`;
      await tx
        .insertInto("workspaces")
        .values({ id: wsId, org_id: org.id, name: opts.workspaceName ?? "default" })
        .execute();
      ws = { id: wsId };
    }
    const existingKey = await tx
      .selectFrom("api_keys")
      .select(["id"])
      .where("workspace_id", "=", ws.id)
      .where("revoked_at", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (existingKey) {
      return { orgId: org.id, workspaceId: ws.id, apiKey: "" };
    }
    const keyId = `key_${randomBytes(6).toString("hex")}`;
    const secret = `mas_sk_${keyId}_${randomBytes(30).toString("base64url")}`;
    await tx
      .insertInto("api_keys")
      .values({
        id: keyId,
        workspace_id: ws.id,
        hash: sha256hex(secret),
        prefix: secret.slice(0, 20),
      })
      .execute();
    return { orgId: org.id, workspaceId: ws.id, apiKey: secret };
  });
  await seedBuiltinSkills(db, new FsSnapshotStore(process.env.MAS_FILES_DIR ?? "/tmp/mas-files"));
  return result;
}

export interface AuthContext {
  workspaceId: string;
  keyId: string;
}

export async function authenticate(db: Kysely<Database>, secret: string): Promise<AuthContext | null> {
  const row = await db
    .selectFrom("api_keys")
    .select(["id", "workspace_id"])
    .where("hash", "=", sha256hex(secret))
    .where("revoked_at", "is", null)
    .limit(1)
    .executeTakeFirst();
  return row ? { workspaceId: row.workspace_id, keyId: row.id } : null;
}
