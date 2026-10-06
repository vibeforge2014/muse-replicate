import type { Kysely } from "kysely";
import { errConflict, errNotFound, type AgentRecord } from "@mas/core";
import { stableStringify } from "@mas/core";
import type { Database } from "../schema.js";

/** 从 agent_versions 行还原完整 Agent JSON。 */
export function versionRowToAgent(
  agentId: string,
  head: { archived_at: Date | null; created_at: Date; updated_at: Date; head_version: number },
  v: { version: number; config: Record<string, unknown>; created_at: Date },
): AgentRecord {
  const c = v.config as unknown as Omit<AgentRecord, "id" | "type" | "version" | "created_at" | "updated_at" | "archived_at">;
  return {
    id: agentId,
    type: "agent",
    version: v.version,
    created_at: v.created_at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    updated_at: v.version === head.head_version ? head.updated_at.toISOString().replace(/\.\d{3}Z$/, "Z") : v.created_at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    archived_at: head.archived_at ? head.archived_at.toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    ...c,
  };
}

export async function getAgent(
  db: Kysely<Database>,
  workspaceId: string,
  agentId: string,
  version?: number,
): Promise<AgentRecord> {
  const head = await db
    .selectFrom("agents")
    .selectAll()
    .where("id", "=", agentId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!head) throw errNotFound(`agent ${agentId} not found`);
  const wantVersion = version ?? head.head_version;
  const v = await db
    .selectFrom("agent_versions")
    .selectAll()
    .where("agent_id", "=", agentId)
    .where("version", "=", wantVersion)
    .executeTakeFirst();
  if (!v) throw errNotFound(`agent ${agentId} version ${wantVersion} not found`);
  return versionRowToAgent(agentId, head, v);
}

export async function createAgent(
  db: Kysely<Database>,
  workspaceId: string,
  agentId: string,
  config: Record<string, unknown>,
): Promise<AgentRecord> {
  return db.transaction().execute(async (tx) => {
    const now = new Date();
    await tx.insertInto("agents").values({ id: agentId, workspace_id: workspaceId, head_version: 1 }).execute();
    await tx
      .insertInto("agent_versions")
      .values({ agent_id: agentId, version: 1, config, created_at: now })
      .execute();
    return versionRowToAgent(agentId, { archived_at: null, created_at: now, updated_at: now, head_version: 1 }, { version: 1, config, created_at: now });
  });
}

export interface AgentUpdateOutcome {
  agent: AgentRecord;
  versionBumped: boolean;
}

/** 更新：乐观锁 + 无变化不升版本（AGT-16/17/18）。 */
export async function updateAgent(
  db: Kysely<Database>,
  workspaceId: string,
  agentId: string,
  nextConfig: Record<string, unknown>,
  ifVersion: number | undefined,
): Promise<AgentUpdateOutcome> {
  return db.transaction().execute(async (tx) => {
    const head = await tx
      .selectFrom("agents")
      .selectAll()
      .where("id", "=", agentId)
      .where("workspace_id", "=", workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!head) throw errNotFound(`agent ${agentId} not found`);
    if (head.archived_at) throw errConflict("agent is archived");
    if (ifVersion !== undefined && ifVersion !== head.head_version) {
      throw errConflict(`version mismatch: current version is ${head.head_version}`, {
        current_version: head.head_version,
      });
    }
    const current = await tx
      .selectFrom("agent_versions")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("version", "=", head.head_version)
      .executeTakeFirst();
    if (!current) throw errNotFound(`agent ${agentId} head version missing`);
    if (stableStringify(current.config) === stableStringify(nextConfig)) {
      const agent = versionRowToAgent(agentId, head, current);
      return { agent, versionBumped: false };
    }
    const nextVersion = head.head_version + 1;
    const now = new Date();
    await tx.insertInto("agent_versions").values({ agent_id: agentId, version: nextVersion, config: nextConfig }).execute();
    await tx.updateTable("agents").set({ head_version: nextVersion, updated_at: now }).where("id", "=", agentId).execute();
    return {
      agent: versionRowToAgent(
        agentId,
        { ...head, head_version: nextVersion, updated_at: now },
        { version: nextVersion, config: nextConfig, created_at: now },
      ),
      versionBumped: true,
    };
  });
}

export async function archiveAgent(db: Kysely<Database>, workspaceId: string, agentId: string): Promise<AgentRecord> {
  return db.transaction().execute(async (tx) => {
    const head = await tx
      .selectFrom("agents")
      .selectAll()
      .where("id", "=", agentId)
      .where("workspace_id", "=", workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!head) throw errNotFound(`agent ${agentId} not found`);
    if (!head.archived_at) {
      await tx.updateTable("agents").set({ archived_at: new Date(), updated_at: new Date() }).where("id", "=", agentId).execute();
    }
    return getAgent(tx as unknown as Kysely<Database>, workspaceId, agentId);
  });
}

export async function listAgentVersions(
  db: Kysely<Database>,
  workspaceId: string,
  agentId: string,
): Promise<AgentRecord[]> {
  const head = await db
    .selectFrom("agents")
    .selectAll()
    .where("id", "=", agentId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!head) throw errNotFound(`agent ${agentId} not found`);
  const rows = await db
    .selectFrom("agent_versions")
    .selectAll()
    .where("agent_id", "=", agentId)
    .orderBy("version asc")
    .execute();
  return rows.map((v) => versionRowToAgent(agentId, head, v));
}
