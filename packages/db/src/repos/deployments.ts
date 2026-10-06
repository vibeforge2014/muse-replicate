import { type Kysely, type Selectable } from "kysely";
import { errConflict, errNotFound, newId, nextFireAfter } from "@mas/core";
import type { Database } from "../schema.js";
import type { DeploymentRow, DeploymentRunRow } from "../schema.js";
import { admitEvents } from "./sessions.js";
import { getAgent } from "./agents.js";

/**
 * Deployments（plan M6 W12 / test-case-plan 5.14 DEP-01~09）：
 * agent 版本在创建时固定；schedule 为 5 字段 cron（≥5min、必须有未来触发点、Asia/Shanghai）；
 * 手动 run 允许在 paused 状态（DEP-05）、归档后拒绝（DEP-06）；调度 tick 单进程轮询
 * （schedule 到点 → pending 启动建会话 → running 跟随 session → 完成）。
 */

export type DeploymentSel = Selectable<DeploymentRow>;
export type DeploymentRunSel = Selectable<DeploymentRunRow>;

export async function getDeployment(db: Kysely<Database>, workspaceId: string, id: string): Promise<DeploymentSel> {
  const row = await db
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", id)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw errNotFound(`deployment ${id} not found`);
  return row;
}

export interface CreateDeploymentArgs {
  workspaceId: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  schedule: string | null;
  input: Record<string, unknown>;
}

export async function createDeployment(
  db: Kysely<Database>,
  args: CreateDeploymentArgs,
): Promise<DeploymentSel> {
  const id = newId("dply");
  return (
    await db
      .insertInto("deployments")
      .values({
        id,
        workspace_id: args.workspaceId,
        agent_id: args.agentId,
        agent_version: args.agentVersion,
        environment_id: args.environmentId,
        schedule: args.schedule,
        input: args.input,
        status: "active",
      })
      .returningAll()
      .executeTakeFirst()
  )!;
}

/** DEP-04/DEP-06：手动 run——paused 允许、archived 拒绝。 */
export async function enqueueManualRun(
  db: Kysely<Database>,
  workspaceId: string,
  deploymentId: string,
  inputOverride?: Record<string, unknown>,
): Promise<DeploymentRunSel> {
  const dep = await getDeployment(db, workspaceId, deploymentId);
  if (dep.status === "archived") throw errConflict(`deployment ${deploymentId} is archived`);
  return (
    await db
      .insertInto("deployment_runs")
      .values({
        id: newId("dprn"),
        workspace_id: workspaceId,
        deployment_id: deploymentId,
        trigger_type: "manual",
        trigger_context: { type: "manual", ...(inputOverride ? { input: inputOverride } : {}) },
        status: "pending",
      })
      .returningAll()
      .executeTakeFirst()
  )!;
}

/** tick 第 1 步：pending run → 校验 env/agent → 建会话并投递首轮输入 → running。 */
async function startPendingRuns(db: Kysely<Database>): Promise<void> {
  const pending = await db
    .selectFrom("deployment_runs")
    .innerJoin("deployments", (join) => join.onRef("deployments.id", "=", "deployment_runs.deployment_id"))
    .selectAll(["deployment_runs"])
    .select(["deployments.agent_id", "deployments.agent_version", "deployments.environment_id", "deployments.input"])
    .where("deployment_runs.status", "=", "pending")
    .orderBy("deployment_runs.created_at", "asc")
    .limit(20)
    .execute();

  for (const run of pending) {
    try {
      const env = await db
        .selectFrom("environments")
        .select(["id", "name", "config", "archived_at"])
        .where("id", "=", run.environment_id)
        .where("workspace_id", "=", run.workspace_id)
        .executeTakeFirst();
      if (!env) throw new Error(`environment ${run.environment_id} not found`);
      if (env.archived_at) throw new Error(`environment ${run.environment_id} is archived`); // DEP-08
      const agent = await getAgent(db, run.workspace_id, run.agent_id, run.agent_version).catch(() => {
        throw new Error(`agent ${run.agent_id} v${run.agent_version} not found`);
      });

      const sessionId = newId("sesn");
      const input = (run.input ?? {}) as { message?: string };
      await db
        .insertInto("sessions")
        .values({
          id: sessionId,
          workspace_id: run.workspace_id,
          agent_snapshot: {
            type: "agent",
            id: agent.id,
            version: agent.version,
            name: agent.name,
            model: agent.model,
            system: agent.system,
            tools: agent.tools,
            mcp_servers: agent.mcp_servers,
            skills: agent.skills ?? [],
            metadata: agent.metadata,
          },
          environment_id: env.id,
          environment_snapshot: { id: env.id, type: "environment", name: env.name, config: env.config },
          status: "idle",
          title: `deployment ${run.deployment_id}`,
          metadata: { deployment_id: run.deployment_id, deployment_run_id: run.id },
        })
        .execute();
      await admitEvents(db, {
        sessionId,
        workspaceId: run.workspace_id,
        events: [
          {
            id: newId("sevt"),
            type: "user.message",
            payload: {
              id: newId("sevt"),
              type: "user.message",
              content: [{ type: "text", text: input.message ?? "deployment run" }],
            },
          },
        ],
        executionKind: "user_message",
      });
      await db
        .updateTable("deployment_runs")
        .set({ session_id: sessionId, status: "running", started_at: new Date() })
        .where("id", "=", run.id)
        .where("status", "=", "pending")
        .execute();
    } catch (e) {
      await db
        .updateTable("deployment_runs")
        .set({
          status: "failed",
          error: { type: "start_failed", message: String((e as Error)?.message ?? e) },
          finished_at: new Date(),
        })
        .where("id", "=", run.id)
        .where("status", "=", "pending")
        .execute();
    }
  }
}

/** tick 第 2 步：running run 跟随 session 状态收尾。 */
async function settleRunningRuns(db: Kysely<Database>): Promise<void> {
  const running = await db
    .selectFrom("deployment_runs")
    .selectAll()
    .where("status", "=", "running")
    .where("session_id", "is not", null)
    .limit(50)
    .execute();
  for (const run of running) {
    const s = await db
      .selectFrom("sessions")
      .select(["status", "stop_reason"])
      .where("id", "=", run.session_id!)
      .executeTakeFirst();
    if (!s) {
      await db
        .updateTable("deployment_runs")
        .set({ status: "failed", error: { type: "session_missing" }, finished_at: new Date() })
        .where("id", "=", run.id)
        .execute();
      continue;
    }
    if (s.status === "idle" && s.stop_reason !== null) {
      // stop_reason 非空 = 首轮已收尾（新会话在 worker 认领前 stop_reason 为 null，不算完成）
      const stop = (s.stop_reason ?? {}) as { type?: string };
      const failed = stop.type === "error" || stop.type === "retries_exhausted" || stop.type === "exhausted";
      await db
        .updateTable("deployment_runs")
        .set({
          status: failed ? "failed" : "succeeded",
          ...(failed ? { error: { type: "session_ended", stop_reason: s.stop_reason } } : {}),
          finished_at: new Date(),
        })
        .where("id", "=", run.id)
        .execute();
    } else if (s.status === "terminated") {
      await db
        .updateTable("deployment_runs")
        .set({
          status: "failed",
          error: { type: "session_terminated", stop_reason: s.stop_reason },
          finished_at: new Date(),
        })
        .where("id", "=", run.id)
        .execute();
    }
  }
}

/** tick 第 3 步：active + schedule 的 deployment 到点 → 产生 schedule run（每次至多补一个）。 */
async function triggerScheduledRuns(db: Kysely<Database>): Promise<void> {
  const rows = await db
    .selectFrom("deployments")
    .selectAll()
    .where("status", "=", "active")
    .where("schedule", "is not", null)
    .limit(100)
    .execute();
  const now = Date.now();
  for (const dep of rows) {
    const anchor = dep.last_scheduled_at?.getTime() ?? dep.created_at.getTime();
    const due = nextFireAfter(dep.schedule!, anchor);
    if (due === null || due > now) continue;
    await db
      .insertInto("deployment_runs")
      .values({
        id: newId("dprn"),
        workspace_id: dep.workspace_id,
        deployment_id: dep.id,
        trigger_type: "schedule",
        trigger_context: { type: "schedule" },
        status: "pending",
        scheduled_for: new Date(due),
      })
      .execute();
    await db
      .updateTable("deployments")
      .set({ last_scheduled_at: new Date(due), updated_at: new Date() })
      .where("id", "=", dep.id)
      .execute();
  }
}

/** 调度 tick（幂等；单进程 MVP，多实例部署需选主——偏差记录于 README）。 */
export async function runDeploymentTick(db: Kysely<Database>): Promise<void> {
  await triggerScheduledRuns(db);
  await startPendingRuns(db);
  await settleRunningRuns(db);
}

/** 启动周期 tick；返回 stop()。 */
export function startDeploymentScheduler(
  db: Kysely<Database>,
  intervalMs = Number(process.env.MAS_DEPLOYMENT_TICK_MS ?? 1000),
): () => void {
  const timer = setInterval(() => {
    void runDeploymentTick(db).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}

/** DEP-09：归档 agent 时联动归档其 deployments。 */
export async function archiveDeploymentsOfAgent(db: Kysely<Database>, workspaceId: string, agentId: string): Promise<void> {
  await db
    .updateTable("deployments")
    .set({ status: "archived", archived_at: new Date(), updated_at: new Date() })
    .where("workspace_id", "=", workspaceId)
    .where("agent_id", "=", agentId)
    .where("status", "!=", "archived")
    .execute();
}

export async function listRuns(
  db: Kysely<Database>,
  workspaceId: string,
  filters: { deploymentId?: string; hasError?: boolean; triggerType?: string; createdAfter?: Date; createdBefore?: Date; limit: number },
): Promise<DeploymentRunSel[]> {
  return db
    .selectFrom("deployment_runs")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .$if(filters.deploymentId !== undefined, (q) => q.where("deployment_id", "=", filters.deploymentId!))
    .$if(filters.hasError !== undefined, (q) =>
      filters.hasError ? q.where("error", "is not", null) : q.where("error", "is", null),
    )
    .$if(filters.triggerType !== undefined, (q) => q.where("trigger_type", "=", filters.triggerType!))
    .$if(filters.createdAfter !== undefined, (q) => q.where("created_at", ">=", filters.createdAfter!))
    .$if(filters.createdBefore !== undefined, (q) => q.where("created_at", "<=", filters.createdBefore!))
    .orderBy("created_at", "desc")
    .limit(filters.limit)
    .execute();
}

