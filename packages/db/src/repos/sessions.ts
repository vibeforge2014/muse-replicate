import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { errConflict, errNotFound, type SessionEventJson } from "@mas/core";
import type { Selectable } from "kysely";
import type { Database, ExecutionRow, SessionRow } from "../schema.js";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const nowIso = () => iso(new Date());

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export interface SessionJson {
  id: string;
  type: "session";
  status: string;
  stop_reason: Record<string, unknown> | null;
  agent: Record<string, unknown>;
  environment_id: string;
  title: string | null;
  metadata: Record<string, string>;
  resources: { type: string; file_id: string; mount_path: string; id?: string }[];
  vault_ids: string[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function sessionRowToJson(
  s: Selectable<SessionRow>,
  resources: { id: string; type: string; file_id: string; mount_path: string }[],
): SessionJson {
  return {
    id: s.id,
    type: "session",
    status: s.status,
    stop_reason: s.stop_reason ?? null,
    agent: s.agent_snapshot,
    environment_id: s.environment_id,
    title: s.title,
    metadata: s.metadata,
    resources: resources.map((r) => ({ type: r.type, file_id: r.file_id, mount_path: r.mount_path })),
    vault_ids: s.vault_ids,
    usage: s.usage,
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
    archived_at: s.archived_at ? iso(s.archived_at) : null,
  };
}

export async function getSessionRow(
  db: Kysely<Database>,
  workspaceId: string,
  sessionId: string,
): Promise<Selectable<SessionRow>> {
  const row = await db
    .selectFrom("sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw errNotFound(`session ${sessionId} not found`);
  return row;
}

export async function listSessionResources(
  db: Kysely<Database>,
  sessionId: string,
): Promise<{ id: string; type: string; file_id: string; mount_path: string }[]> {
  const rows = await db
    .selectFrom("session_resources")
    .select(["id", "type", "file_id", "mount_path"])
    .where("session_id", "=", sessionId)
    .orderBy("created_at asc")
    .execute();
  return rows;
}

// ---------------------------------------------------------------------------
// 事件准入（api 侧，spec §5.6 / §7.3）
// ---------------------------------------------------------------------------

export interface AdmitInput {
  sessionId: string;
  workspaceId: string;
  events: { id: string; type: string; payload: Record<string, unknown> }[];
  executionKind: "user_message" | "tool_confirmation" | "interrupt";
  leaseSeconds?: number;
  deadlineHours?: number;
}

export interface AdmitResult {
  events: SessionEventJson[];
  executionId: string;
  interruptAccepted: boolean;
}

function fingerprintOf(events: AdmitInput["events"]): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify(
      events.map((e) => [e.type, e.payload]),
      Object.keys({}).sort(),
    ),
  );
  return h.digest("hex");
}

/**
 * 同一事务：写入排队的用户事件（seq=NULL, processed_at=NULL）+ session_executions(queued)。
 * 若批次含 user.interrupt：持久化中断请求，取消同 lane 的 queued 输入并把它们 flush。
 */
export async function admitEvents(db: Kysely<Database>, input: AdmitInput): Promise<AdmitResult> {
  const leaseSeconds = input.leaseSeconds ?? 30;
  const deadlineHours = input.deadlineHours ?? 6;
  const hasInterrupt = input.events.some((e) => e.type === "user.interrupt");
  return db.transaction().execute(async (tx) => {
    const s = await tx
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", input.sessionId)
      .where("workspace_id", "=", input.workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw errNotFound(`session ${input.sessionId} not found`);
    if (s.archived_at) throw errConflict("session is archived");

    const executionId = `exe_${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
    const receivedAt = new Date();

    // 排队写入（processed_at=NULL → 历史可见，表示排队中）
    for (const e of input.events) {
      await tx.insertInto("session_events").values({
        session_id: input.sessionId,
        id: e.id,
        type: e.type,
        payload: e.payload,
        received_at: receivedAt,
      }).execute();
    }

    // interrupt 是用户意图的时刻标记：接收时即在 session 行锁内定序（与 worker 写入串行化，
    // 保证顺序位于本轮 idle 事件之前；spec §7.3 第 4 条 api 定序路径的合理扩展）
    if (hasInterrupt) {
      const interruptIds = input.events.filter((e) => e.type === "user.interrupt").map((e) => e.id);
      if (interruptIds.length > 0) {
        await assignSeqAndProcessedAt(tx, input.sessionId, interruptIds, "normal");
      }
    }

    let interruptAccepted = false;
    if (hasInterrupt) {
      // 持久化中断请求（spec §6）：作用于活跃 execution；取消 queued 输入并 flush 其事件。
      const active = await tx
        .updateTable("session_executions")
        .set({ interrupt_requested_at: new Date(), revision: (sql`revision + 1`) as never })
        .where("session_id", "=", input.sessionId)
        .where("lane_id", "=", "main")
        .where("state", "in", ["claimed", "delivered"])
        .where("interrupt_requested_at", "is", null)
        .returning(["id"])
        .execute();
      const cancelled = await tx
        .updateTable("session_executions")
        .set({ state: "cancelled", settled_at: new Date() })
        .where("session_id", "=", input.sessionId)
        .where("lane_id", "=", "main")
        .where("state", "=", "queued")
        .returning(["id", "input_event_ids"])
        .execute();
      for (const c of cancelled) {
        for (const eid of c.input_event_ids) {
          await flushQueuedEvent(tx, input.sessionId, eid);
        }
      }
      interruptAccepted = active.length > 0 || cancelled.length > 0;
    }

    if (!hasInterrupt || input.executionKind === "interrupt") {
      // requires_action 时的 interrupt：生成 interrupt 执行，由 worker 作废未决审批（TOOL-09）
      await tx.insertInto("session_executions").values({
        id: executionId,
        workspace_id: input.workspaceId,
        session_id: input.sessionId,
        lane_id: "main",
        kind: input.executionKind,
        input_event_ids: input.events.map((e) => e.id),
        input_fingerprint: fingerprintOf(input.events),
        state: "queued",
        deadline_at: new Date(Date.now() + deadlineHours * 3600_000),
      }).execute();
    } else if (!interruptAccepted) {
      // idle 时单独的 interrupt：没有活跃 execution → 直接定序写入历史（EVT-S09）
      for (const e of input.events.filter((e) => e.type === "user.interrupt")) {
        await assignSeqAndProcessedAt(tx, input.sessionId, [e.id], "normal");
      }
    }

    await tx.updateTable("sessions").set({ updated_at: new Date() }).where("id", "=", input.sessionId).execute();

    // 事务内登记 NOTIFY，提交后由 PG 送达（worker 立即感知有新工作）
    if (!hasInterrupt) {
      await sql`SELECT pg_notify('session_exec', ${input.sessionId})`.execute(tx);
    }

    const events: SessionEventJson[] = input.events.map((e) => ({
      id: e.id,
      type: e.type as SessionEventJson["type"],
      processed_at: null,
      ...e.payload,
    }));
    return { events, executionId, interruptAccepted };
  });
}

// ---------------------------------------------------------------------------
// 定序（spec §7.3：seq 与 processed_at 只由持有 fence 的写入者分配）
// ---------------------------------------------------------------------------

async function loadSeqState(tx: Kysely<Database>, sessionId: string) {
  const s = await tx
    .selectFrom("sessions")
    .select(["last_event_seq", "last_processed_at"])
    .where("id", "=", sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!s) throw errNotFound(`session ${sessionId} not found`);
  return s;
}

/** 为排队事件分配 seq 和单调唯一的 processed_at，并推进 session 水位。 */
export async function assignSeqAndProcessedAt(
  tx: Kysely<Database>,
  sessionId: string,
  eventIds: string[],
  disposition: "normal" | "flushed",
): Promise<{ lastSeq: number }> {
  const state = await loadSeqState(tx, sessionId);
  let seq = Number(state.last_event_seq ?? 0);
  let lastMs = state.last_processed_at ? state.last_processed_at.getTime() : 0;
  const nowMs = Date.now();
  for (const eid of eventIds) {
    // 幂等：已定序（seq 非 NULL）的行跳过，不重复分配
    const row = await tx
      .selectFrom("session_events")
      .select(["id"])
      .where("session_id", "=", sessionId)
      .where("id", "=", eid)
      .where("seq", "is", null)
      .executeTakeFirst();
    if (!row) continue;
    seq += 1;
    const t = Math.max(nowMs, lastMs + 1);
    lastMs = t;
    await tx
      .updateTable("session_events")
      .set({ seq, processed_at: new Date(t), disposition })
      .where("session_id", "=", sessionId)
      .where("id", "=", eid)
      .execute();
  }
  await tx
    .updateTable("sessions")
    .set({ last_event_seq: seq, last_processed_at: new Date(lastMs) })
    .where("id", "=", sessionId)
    .execute();
  return { lastSeq: seq };
}

async function flushQueuedEvent(tx: Kysely<Database>, sessionId: string, eventId: string): Promise<void> {
  const pending = await tx
    .selectFrom("session_events")
    .select(["id"])
    .where("session_id", "=", sessionId)
    .where("id", "=", eventId)
    .where("seq", "is", null)
    .executeTakeFirst();
  if (pending) {
    await assignSeqAndProcessedAt(tx, sessionId, [eventId], "flushed");
  }
}

// ---------------------------------------------------------------------------
// Execution claim / renew / settle（spec §7.1，execution 级 fencing）
// ---------------------------------------------------------------------------

export type ClaimedExecution = Selectable<ExecutionRow>;

export async function claimNextExecution(
  db: Kysely<Database>,
  sessionId: string,
  ownerId: string,
  attemptId: string,
  leaseSeconds = 30,
): Promise<ClaimedExecution | null> {
  const result = await sql<Selectable<ExecutionRow>>`
    UPDATE session_executions e
       SET state='claimed', owner_id=${ownerId}, attempt_id=${attemptId},
           generation=generation+1, attempt_count=attempt_count+1,
           claimed_at=now(), lease_expires_at=now() + make_interval(secs => ${leaseSeconds}),
           revision=revision+1
     WHERE e.id = (
       SELECT id FROM session_executions
        WHERE session_id=${sessionId} AND lane_id='main'
          AND (state='queued' OR (state IN ('claimed','delivered') AND lease_expires_at < now()))
          AND attempt_count < max_attempts AND deadline_at > now()
        ORDER BY admitted_at, id LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *`.execute(db);
  return result.rows[0] ?? null;
}

/** 有待处理工作的会话（worker 轮询入口）。 */
export async function sessionsWithWork(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ session_id: string }>`
    SELECT DISTINCT session_id FROM session_executions
     WHERE state='queued'
        OR (state IN ('claimed','delivered') AND lease_expires_at < now() AND attempt_count < max_attempts AND deadline_at > now())`.execute(db);
  return result.rows.map((r) => r.session_id);
}

export async function renewExecution(
  db: Kysely<Database>,
  executionId: string,
  generation: number,
  attemptId: string,
  leaseSeconds = 30,
): Promise<boolean> {
  const result = await db
    .updateTable("session_executions")
    .set({ lease_expires_at: new Date(Date.now() + leaseSeconds * 1000), revision: (sql`revision + 1`) as never })
    .where("id", "=", executionId)
    .where("generation", "=", generation)
    .where("attempt_id", "=", attemptId)
    .returning(["id"])
    .execute();
  return result.length > 0;
}

export async function markDelivered(
  db: Kysely<Database>,
  executionId: string,
  generation: number,
  attemptId: string,
): Promise<boolean> {
  const result = await db
    .updateTable("session_executions")
    .set({ state: "delivered", delivered_at: new Date() })
    .where("id", "=", executionId)
    .where("generation", "=", generation)
    .where("attempt_id", "=", attemptId)
    .where("state", "=", "claimed")
    .returning(["id"])
    .execute();
  return result.length > 0;
}

export async function settleExecution(
  db: Kysely<Database>,
  executionId: string,
  generation: number,
  attemptId: string,
  outcome: { state: "completed" | "failed"; failure?: Record<string, unknown> },
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    // settle 前必须再续约一次（spec §5.6）
    const renewed = await tx
      .updateTable("session_executions")
      .set({ lease_expires_at: new Date(Date.now() + 30_000), revision: (sql`revision + 1`) as never })
      .where("id", "=", executionId)
      .where("generation", "=", generation)
      .where("attempt_id", "=", attemptId)
      .returning(["id"])
      .execute();
    if (renewed.length === 0) return false;
    await tx
      .updateTable("session_executions")
      .set({ state: outcome.state, settled_at: new Date(), failure: outcome.failure ?? null })
      .where("id", "=", executionId)
      .execute();
    return true;
  });
}

/** 毒任务回收（spec §5.6 / REC-06）：attempt 耗尽且租约过期的执行置为 failed，返回需要收尾的会话。 */
export async function failExhaustedExecutions(db: Kysely<Database>): Promise<
  { sessionId: string; executionId: string }[]
> {
  const result = await sql<{ id: string; session_id: string }>`
    UPDATE session_executions
       SET state='failed', settled_at=now(), failure='{"reason":"exhausted"}'::jsonb
     WHERE state IN ('claimed','delivered')
       AND attempt_count >= max_attempts
       AND lease_expires_at < now()
     RETURNING id, session_id`.execute(db);
  return result.rows.map((r) => ({ sessionId: r.session_id, executionId: r.id }));
}

/** 毒任务回收 + 会话收尾（REC-06）：failed 之后写 session.error(exhausted) + idle，并物化状态。 */
export async function reapExhaustedExecutions(db: Kysely<Database>): Promise<void> {
  const reaped = await failExhaustedExecutions(db);
  for (const r of reaped) {
    await db.transaction().execute(async (tx) => {
      const s = await tx
        .selectFrom("sessions")
        .select(["id", "status"])
        .where("id", "=", r.sessionId)
        .executeTakeFirst();
      // 仅 running/rescheduling 的会话需要收尾；idle 会话只保留 failed 记录
      if (!s || (s.status !== "running" && s.status !== "rescheduling")) return;
      const state = await loadSeqState(tx, r.sessionId);
      let seq = Number(state.last_event_seq ?? 0);
      let lastMs = state.last_processed_at ? state.last_processed_at.getTime() : 0;
      const insert = async (type: string, payload: Record<string, unknown>) => {
        seq += 1;
        lastMs = Math.max(Date.now(), lastMs + 1);
        await tx
          .insertInto("session_events")
          .values({
            session_id: r.sessionId,
            seq,
            id: `sevt_${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`,
            type,
            payload,
            processed_at: new Date(lastMs),
          })
          .execute();
        await sql`SELECT pg_notify('session:' || ${r.sessionId}, ${seq}::text)`.execute(tx);
      };
      await insert("session.error", {
        error: { type: "execution_exhausted", message: "retries exhausted", retry_status: "exhausted" },
      });
      await insert("session.status_idle", { stop_reason: { type: "retries_exhausted" } });
      await tx
        .updateTable("sessions")
        .set({
          status: "idle",
          stop_reason: { type: "retries_exhausted" } as Record<string, unknown>,
          last_event_seq: seq,
          last_processed_at: new Date(lastMs),
          last_completed_execution_id: r.executionId,
          updated_at: new Date(),
        })
        .where("id", "=", r.sessionId)
        .execute();
    });
  }
}

// ---------------------------------------------------------------------------
// Worker 侧事件追加（带 fence），状态物化（spec §6/§7）
// ---------------------------------------------------------------------------

export interface AppendEventInput {
  sessionId: string;
  executionId: string;
  generation: number;
  attemptId: string;
  eventId?: string;
  sourceEventId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** 追加一个事件：分配 seq/processed_at；若为状态事件则物化 sessions.status。 */
export async function appendEvent(db: Kysely<Database>, input: AppendEventInput): Promise<SessionEventJson | null> {
  const eventId =
    input.eventId ?? (input.payload.id as string | undefined) ??
    `sevt_${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
  return db.transaction().execute(async (tx) => {
    // fence 检查：execution 仍归本 attempt 持有，否则拒绝写入（旧 generation 立即失效）
    const fence = await tx
      .selectFrom("session_executions")
      .select(["id"])
      .where("id", "=", input.executionId)
      .where("generation", "=", input.generation)
      .where("attempt_id", "=", input.attemptId)
      .executeTakeFirst();
    if (!fence) throw errConflict("execution fence lost");
    const state = await loadSeqState(tx, input.sessionId);
    const seq = Number(state.last_event_seq ?? 0) + 1;
    const lastMs = state.last_processed_at ? state.last_processed_at.getTime() : 0;
    const t = Math.max(Date.now(), lastMs + 1);
    const payload = { ...input.payload };
    try {
      await tx.insertInto("session_events").values({
        session_id: input.sessionId,
        seq,
        id: eventId,
        type: input.type,
        payload,
        processed_at: new Date(t),
        source_event_id: input.sourceEventId ?? null,
        generation: input.generation,
      }).execute();
    } catch (e) {
      // (session_id, source_event_id) 唯一冲突 → 驱动重放，幂等跳过
      if ((e as { code?: string }).code === "23505") return null;
      throw e;
    }
    const sessionUpdate: Record<string, unknown> = {
      last_event_seq: seq,
      last_processed_at: new Date(t),
      updated_at: new Date(),
    };
    if (input.type === "session.status_running") sessionUpdate.status = "running";
    if (input.type === "session.status_idle") {
      sessionUpdate.status = "idle";
      sessionUpdate.stop_reason = payload.stop_reason ?? null;
      const stopType = (payload.stop_reason as { type?: string } | undefined)?.type;
      // 轮真正落定（end_turn/error/exhausted）才推进 canonical 水位线；requires_action 不算（§14.2.1）
      if (stopType && stopType !== "requires_action") {
        sessionUpdate.last_completed_execution_id = input.executionId;
      }
    }
    if (input.type === "session.status_rescheduled") sessionUpdate.status = "rescheduling";
    if (input.type === "session.status_terminated") {
      sessionUpdate.status = "terminated";
      sessionUpdate.stop_reason = payload.stop_reason ?? { type: "error" };
    }
    if (input.type === "session.usage") {
      sessionUpdate.usage = payload.usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      };
    }
    await tx.updateTable("sessions").set(sessionUpdate).where("id", "=", input.sessionId).execute();
    // outbox：NOTIFY SSE 消费者（事务提交后由 PG 送达）
    await sql`SELECT pg_notify('session:' || ${input.sessionId}, ${seq}::text)`.execute(tx);
    return {
      id: eventId,
      type: input.type as SessionEventJson["type"],
      processed_at: iso(new Date(t)),
      ...payload,
    };
  });
}

/** api 产生的 session.updated / session.deleted（无活跃 execution 时由 api 定序）。 */
export async function appendApiEvent(
  db: Kysely<Database>,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const state = await loadSeqState(tx, sessionId);
    const seq = Number(state.last_event_seq ?? 0) + 1;
    const lastMs = state.last_processed_at ? state.last_processed_at.getTime() : 0;
    const t = Math.max(Date.now(), lastMs + 1);
    const eventId = payload.id as string | undefined ?? `sevt_${Math.floor(Math.random() * 1e9).toString(36)}${Date.now().toString(36)}`;
    await tx.insertInto("session_events").values({
      session_id: sessionId,
      seq,
      id: eventId,
      type,
      payload,
      processed_at: new Date(t),
    }).execute();
    const sessionUpdate: Record<string, unknown> = { last_event_seq: seq, last_processed_at: new Date(t) };
    if (type === "session.usage") {
      // gateway 计量走 api 侧写入：payload.usage 为累计值，直接替换物化（§10.3）
      sessionUpdate.usage = (payload as { usage?: Record<string, number> }).usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      };
    }
    await tx
      .updateTable("sessions")
      .set(sessionUpdate)
      .where("id", "=", sessionId)
      .execute();
    await sql`SELECT pg_notify('session:' || ${sessionId}, ${seq}::text)`.execute(tx);
  });
}

// ---------------------------------------------------------------------------
// 历史查询（spec §7.3 第 5 条：ORDER BY seq NULLS LAST, received_at, id）
// ---------------------------------------------------------------------------

export interface ListEventsParams {
  sessionId: string;
  types?: string[];
  timeFilter?: Partial<Record<"gt" | "gte" | "lt" | "lte", string>>;
  order?: "asc" | "desc";
  limit?: number;
  afterSeq?: number;
  cursorSeq?: number | null;
}

export async function listEvents(db: Kysely<Database>, p: ListEventsParams): Promise<SessionEventJson[]> {
  const limit = Math.min(Math.max(p.limit ?? 100, 1), 100);
  const rows = await db
    .selectFrom("session_events")
    .selectAll()
    .where("session_id", "=", p.sessionId)
    .$if(!!p.types?.length, (q) => q.where("type", "in", p.types!))
    .$if(p.afterSeq !== undefined, (q) => q.where("seq", ">", p.afterSeq!))
    .$if(!!p.timeFilter?.gt, (q) => q.where("processed_at", ">", new Date(p.timeFilter!.gt!)))
    .$if(!!p.timeFilter?.gte, (q) => q.where("processed_at", ">=", new Date(p.timeFilter!.gte!)))
    .$if(!!p.timeFilter?.lt, (q) => q.where("processed_at", "<", new Date(p.timeFilter!.lt!)))
    .$if(!!p.timeFilter?.lte, (q) => q.where("processed_at", "<=", new Date(p.timeFilter!.lte!)))
    .orderBy(sql`seq asc nulls last`)
    .orderBy("received_at", "asc")
    .orderBy("id", "asc")
    .limit(1000)
    .execute();
  const json = rows.map((r) => ({
    id: r.id,
    type: r.type as SessionEventJson["type"],
    processed_at: r.processed_at ? iso(r.processed_at) : null,
    seq: r.seq,
    ...r.payload,
  }));
  if (p.order === "desc") {
    // desc：排队事件（processed_at=null）在最前，其余按 processed_at 降序
    const queued = json.filter((e) => e.processed_at === null);
    const processed = json.filter((e) => e.processed_at !== null).reverse();
    return [...queued, ...processed].slice(0, limit);
  }
  return json.slice(0, limit);
}

export { iso as isoDate, nowIso };
