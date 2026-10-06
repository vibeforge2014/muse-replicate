import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { errConflict, errInvalid, errNotFound, newId } from "@mas/core";
import type { Database } from "./schema.js";
import type { SkillRow, SkillVersionRow } from "./schema.js";
import type { SnapshotStore } from "./checkpoint.js";

/**
 * Skills（plan M6 W12 / test-case-plan 5.13 SKL-01~07）：
 * zip 上传 → 规范化（剥公共根目录、剔除越界路径、200 文件上限静默截断）→ 重打包存储；
 * 目录名 workspace 内唯一（SKL-02）；版本化（SKL-04）；会话挂载 /workspace/skills/<dir>/。
 */

export const SKILL_MAX_FILES = 200;

export interface SkillFile {
  path: string;
  content: Buffer;
}

export interface NormalizedSkill {
  /** 全部条目共享的单层根目录（无则 null）；作为 skill directory 的缺省值。 */
  rootDirectory: string | null;
  files: SkillFile[];
}

export class InvalidSkillZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillZipError";
  }
}

/** 解析并规范化 zip：绝对路径/`..` 段剔除、目录条目跳过、公共根剥离、按 path 排序、>200 截断。 */
export function normalizeSkillZip(bytes: Buffer): NormalizedSkill {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new InvalidSkillZipError("body is not a valid zip archive");
  }
  const raw: SkillFile[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    const segs = name.split("/").filter((s) => s.length > 0 && s !== ".");
    if (segs.length === 0 || segs.includes("..")) continue; // 越界/空条目剔除
    raw.push({ path: segs.join("/"), content: entry.getData() });
  }
  if (raw.length === 0) throw new InvalidSkillZipError("zip contains no files");
  raw.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const roots = new Set(raw.map((f) => f.path.split("/")[0]!));
  const rootDirectory = roots.size === 1 && raw.some((f) => f.path.includes("/")) ? [...roots][0]! : null;
  const strip = rootDirectory !== null ? `${rootDirectory}/` : "";
  const files = raw.slice(0, SKILL_MAX_FILES).map((f) => ({
    path: strip && f.path.startsWith(strip) ? f.path.slice(strip.length) : f.path,
    content: f.content,
  }));
  return { rootDirectory, files };
}

export function packSkillZip(files: SkillFile[]): Buffer {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.path, f.content);
  return zip.toBuffer();
}

export function readSkillZip(bytes: Buffer): SkillFile[] {
  return normalizeSkillZip(bytes).files;
}

type SkillSel = Selectable<SkillRow>;
type SkillVersionSel = Selectable<SkillVersionRow>;
export type { SkillSel as SkillView, SkillVersionSel as SkillVersionView };

export interface StoredSkillVersion {
  skill: SkillSel;
  version: SkillVersionSel;
}

/** SKL-01/02：根（剥公共根后）必须有 SKILL.md；目录名冲突 → 409 skill_directory_conflict。 */
export async function createSkill(
  db: Kysely<Database>,
  store: SnapshotStore,
  args: { workspaceId: string; directory: string; description: string | null; files: SkillFile[] },
): Promise<StoredSkillVersion> {
  if (!args.files.some((f) => f.path === "SKILL.md")) {
    throw errInvalid("skill zip must contain SKILL.md at the root");
  }
  return db.transaction().execute(async (tx) => {
    const clash = await tx
      .selectFrom("skills")
      .select(["id"])
      .where("workspace_id", "=", args.workspaceId)
      .where("directory", "=", args.directory)
      .executeTakeFirst();
    if (clash) throw errConflict("skill_directory_conflict", { directory: args.directory });
    const id = newId("skl");
    const skill = await tx
      .insertInto("skills")
      .values({
        id,
        workspace_id: args.workspaceId,
        directory: args.directory,
        description: args.description,
        latest_version: 1,
      })
      .returningAll()
      .executeTakeFirst();
    // 版本行在事务内落库；zip 字节走 putIfAbsent（内容寻址幂等）
    const version = await storeSkillZipInTx(tx, store, {
      workspaceId: args.workspaceId,
      skillId: id,
      version: 1,
      files: args.files,
    });
    return { skill: skill!, version };
  });
}

async function storeSkillZipInTx(
  tx: Kysely<Database>,
  store: SnapshotStore,
  args: { workspaceId: string; skillId: string; version: number; files: SkillFile[] },
): Promise<SkillVersionSel> {
  const bytes = packSkillZip(args.files);
  const objectKey = `skills/${args.skillId}/v${args.version}.zip`;
  await store.putIfAbsent(objectKey, bytes);
  return (
    await tx
      .insertInto("skill_versions")
      .values({
        id: newId("skv"),
        skill_id: args.skillId,
        workspace_id: args.workspaceId,
        version: args.version,
        object_key: objectKey,
        file_count: args.files.length,
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
      .returningAll()
      .executeTakeFirst()
  )!;
}

/** SKL-04：追加新版本。 */
export async function addSkillVersion(
  db: Kysely<Database>,
  store: SnapshotStore,
  args: { workspaceId: string; skillId: string; files: SkillFile[] },
): Promise<StoredSkillVersion> {
  if (!args.files.some((f) => f.path === "SKILL.md")) {
    throw errInvalid("skill zip must contain SKILL.md at the root");
  }
  return db.transaction().execute(async (tx) => {
    const skill = await tx
      .selectFrom("skills")
      .forUpdate()
      .selectAll()
      .where("id", "=", args.skillId)
      .where("workspace_id", "=", args.workspaceId)
      .executeTakeFirst();
    if (!skill) throw errNotFound(`skill ${args.skillId} not found`);
    if (skill.archived_at) throw errConflict(`skill ${args.skillId} is archived`);
    const next = skill.latest_version + 1;
    const version = await storeSkillZipInTx(tx, store, {
      workspaceId: args.workspaceId,
      skillId: args.skillId,
      version: next,
      files: args.files,
    });
    const updated = await tx
      .updateTable("skills")
      .set({ latest_version: next, updated_at: new Date() })
      .where("id", "=", args.skillId)
      .where("latest_version", "=", skill.latest_version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw errConflict("concurrent skill version upload; retry");
    return { skill: updated!, version };
  });
}

export async function getSkill(db: Kysely<Database>, workspaceId: string, skillId: string): Promise<SkillSel> {
  const row = await db
    .selectFrom("skills")
    .selectAll()
    .where("id", "=", skillId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw errNotFound(`skill ${skillId} not found`);
  return row;
}

export async function getSkillVersion(
  db: Kysely<Database>,
  workspaceId: string,
  skillId: string,
  version: number,
): Promise<{ skill: SkillSel; version: SkillVersionSel }> {
  const skill = await getSkill(db, workspaceId, skillId);
  const row = await db
    .selectFrom("skill_versions")
    .selectAll()
    .where("skill_id", "=", skillId)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row) throw errNotFound(`skill ${skillId} has no version ${version}`);
  return { skill, version: row };
}

/** SKL-05：仍被 agent 引用（任意版本 config.skills 包含该 id）→ 409。 */
export async function deleteSkill(db: Kysely<Database>, workspaceId: string, skillId: string): Promise<void> {
  await getSkill(db, workspaceId, skillId);
  const refs = await db
    .selectFrom("agent_versions")
    .innerJoin("agents", (join) => join.onRef("agents.id", "=", "agent_versions.agent_id"))
    .select(["agent_versions.agent_id"])
    .where("agents.workspace_id", "=", workspaceId)
    .where(sql<boolean>`agent_versions.config->'skills' @> ${JSON.stringify([skillId])}::jsonb`)
    .limit(1)
    .execute();
  if (refs.length > 0) {
    throw errConflict(`skill ${skillId} is still referenced by agent ${refs[0]!.agent_id}`);
  }
  const mounted = await db
    .selectFrom("session_resources")
    .select(["id"])
    .where("skill_id", "=", skillId)
    .limit(1)
    .execute();
  if (mounted.length > 0) throw errConflict(`skill ${skillId} is still mounted by a session`);
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("skill_versions").where("skill_id", "=", skillId).execute();
    await tx.deleteFrom("skills").where("id", "=", skillId).execute();
  });
}

/** SKL-07：内置（source=zai）skill 播种，幂等。 */
export async function seedBuiltinSkills(db: Kysely<Database>, store: SnapshotStore): Promise<void> {
  const existing = await db.selectFrom("skills").select(["id"]).where("source", "=", "zai").limit(1).execute();
  if (existing.length > 0) return;
  const ws = await db.selectFrom("workspaces").select(["id"]).limit(1).executeTakeFirst();
  if (!ws) return;
  const builtins: { directory: string; description: string; body: string }[] = [
    { directory: "pdf-toolkit", description: "内置：PDF 解析与整理", body: "# pdf-toolkit\n解析 PDF 并输出结构化文本。\n" },
    { directory: "web-research", description: "内置：网页检索摘要", body: "# web-research\n检索并摘要网页内容。\n" },
  ];
  for (const b of builtins) {
    const files: SkillFile[] = [
      { path: "SKILL.md", content: Buffer.from(b.body, "utf8") },
      { path: "scripts/run.md", content: Buffer.from("run via sandbox bash\n", "utf8") },
    ];
    const id = newId("skl");
    await db
      .insertInto("skills")
      .values({
        id,
        workspace_id: ws.id,
        source: "zai",
        directory: b.directory,
        description: b.description,
        latest_version: 1,
      })
      .execute();
    await storeSkillZipInTx(db, store, { workspaceId: ws.id, skillId: id, version: 1, files });
  }
}
