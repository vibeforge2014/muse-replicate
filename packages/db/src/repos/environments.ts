import type { Insertable, Kysely, Selectable } from "kysely";
import { errInvalid, errConflict, errNotFound } from "@mas/core";
import type { Database, EnvironmentRow } from "../schema.js";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function environmentRowToJson(r: Selectable<EnvironmentRow>) {
  return {
    id: r.id,
    type: "environment" as const,
    name: r.name,
    description: r.description,
    config: r.config,
    metadata: r.metadata,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    archived_at: r.archived_at ? iso(r.archived_at) : null,
  };
}

export async function getEnvironmentRow(
  db: Kysely<Database>,
  workspaceId: string,
  envId: string,
): Promise<Selectable<EnvironmentRow>> {
  const row = await db
    .selectFrom("environments")
    .selectAll()
    .where("id", "=", envId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw errNotFound(`environment ${envId} not found`);
  return row;
}

export async function createEnvironment(
  db: Kysely<Database>,
  values: Insertable<EnvironmentRow>,
) {
  const row = await db.insertInto("environments").values(values).returningAll().executeTakeFirst();
  return environmentRowToJson(row!);
}

export async function updateEnvironmentRow(
  db: Kysely<Database>,
  workspaceId: string,
  envId: string,
  patch: { name?: string; description?: string | null; config?: Record<string, unknown>; metadata?: Record<string, string> },
) {
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", envId)
      .where("workspace_id", "=", workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errNotFound(`environment ${envId} not found`);
    if (row.archived_at) throw errInvalid("environment is archived");
    const updated = await tx
      .updateTable("environments")
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.config !== undefined ? { config: patch.config } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", envId)
      .returningAll()
      .executeTakeFirst();
    return environmentRowToJson(updated!);
  });
}

export async function archiveEnvironment(db: Kysely<Database>, workspaceId: string, envId: string) {
  const row = await db
    .updateTable("environments")
    .set({ archived_at: new Date(), updated_at: new Date() })
    .where("id", "=", envId)
    .where("workspace_id", "=", workspaceId)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw errNotFound(`environment ${envId} not found`);
  return environmentRowToJson(row);
}

/** 删除：仍被非终态会话引用时 409（spec §11.3）。 */
export async function deleteEnvironment(db: Kysely<Database>, workspaceId: string, envId: string) {
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", envId)
      .where("workspace_id", "=", workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errNotFound(`environment ${envId} not found`);
    const refs = await tx
      .selectFrom("sessions")
      .select(["id"])
      .where("environment_id", "=", envId)
      .where("archived_at", "is", null)
      .limit(1)
      .execute();
    if (refs.length > 0) {
      throw errConflict("environment is referenced by active sessions");
    }
    await tx.deleteFrom("environments").where("id", "=", envId).execute();
    return { id: envId, type: "environment_deleted" as const };
  });
}
