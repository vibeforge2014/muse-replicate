import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { newId, type SessionEventJson } from "@mas/core";
import type { Database } from "@mas/db";
import {
  appendEvent,
  assignSeqAndProcessedAt,
  getSessionRow,
  markDelivered,
  renewExecution,
  settleExecution,
  claimNextExecution,
} from "@mas/db";
import {
  FakeCodexDriver,
  type NormalizedRuntimeEvent,
  type RuntimeHandle,
} from "@mas/runtime";

const LEASE_SECONDS = 30;
const RENEW_INTERVAL_MS = 10_000;
const TICK_MS = 300;

interface HeldRuntime {
  handle: RuntimeHandle;
  /** fake itemId → sevt id（审批与 tool_result 关联）。 */
  toolUseIds: Map<string, string>;
}

/**
 * SessionRunner：持租约驱动一个会话的执行（spec §8、§7.1）。
 * MVP 用 FakeCodexDriver；真实部署替换为 codex app-server driver，接口不变。
 */
export class SessionRunner {
  private runtimes = new Map<string, HeldRuntime>();

  constructor(
    private db: Kysely<Database>,
    private driver: FakeCodexDriver,
    private workerId = `worker_${process.pid}`,
  ) {}

  async processSession(sessionId: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const attemptId = `att_${randomUUID().slice(0, 12)}`;
      const exec = await claimNextExecution(this.db, sessionId, this.workerId, attemptId, LEASE_SECONDS);
      if (!exec) return;
      const more = await this.runExecution(sessionId, exec.id, exec.generation, attemptId, exec.kind, exec.input_event_ids, exec.interrupt_requested_at !== null);
      if (!more) return;
    }
  }

  /** 返回 true 表示同会话还有后续工作。 */
  private async runExecution(
    sessionId: string,
    executionId: string,
    generation: number,
    attemptId: string,
    kind: string,
    inputEventIds: string[],
    interruptAlreadyRequested: boolean,
  ): Promise<boolean> {
    const session = await getSessionRow(this.db, (await this.workspaceOf(sessionId)), sessionId);
    const agent = session.agent_snapshot as {
      system: string | null;
      model: { id: string; effort?: string };
      tools?: { type: string; default_config?: { permission_policy?: { type: string } } }[];
    };
    const hasAsk = (agent.tools ?? []).some(
      (t) => t.default_config?.permission_policy?.type === "always_ask",
    );
    const hasToolset = (agent.tools ?? []).some((t) => t.type?.startsWith("agent_toolset"));

    // 1) 定序排队输入（spec §7.3：claim 后、写 stdin 前分配 seq/processed_at）
    await this.db.transaction().execute(async (tx) => {
      await assignSeqAndProcessedAt(tx, sessionId, inputEventIds, "normal");
    });
    await this.notifySeq(sessionId);

    // 2) runtime（内存缓存；requires_action 期间保留）
    let held = this.runtimes.get(sessionId);
    if (!held) {
      const replay = FakeCodexDriver.readHistory(sessionId);
      const handle = await this.driver.start({
        sessionId,
        system: agent.system,
        model: agent.model,
        approvalPolicy: hasAsk ? "untrusted" : "never",
        hasBuiltinToolset: hasToolset,
        ...(replay.length ? { replayHistory: replay } : {}),
      });
      held = { handle, toolUseIds: new Map() };
      this.runtimes.set(sessionId, held);
    }

    let fenceLost = false;
    let interruptSent = interruptAlreadyRequested;
    let lastRenew = Date.now();

    const renew = async () => {
      if (Date.now() - lastRenew < RENEW_INTERVAL_MS) return true;
      lastRenew = Date.now();
      const ok = await renewExecution(this.db, executionId, generation, attemptId, LEASE_SECONDS);
      if (!ok) fenceLost = true;
      return ok;
    };

    const append = async (type: string, payload: Record<string, unknown>, opts: { eventId?: string; sourceEventId?: string | null } = {}): Promise<SessionEventJson | null> => {
      if (fenceLost) return null;
      try {
        return await appendEvent(this.db, {
          sessionId,
          executionId,
          generation,
          attemptId,
          type,
          payload,
          eventId: opts.eventId,
          sourceEventId: opts.sourceEventId,
        });
      } catch (e) {
        if ((e as { status?: number }).status === 409) {
          fenceLost = true;
          return null;
        }
        throw e;
      }
    };

    // 3) 按执行类型推进（spec §5.6 kind）
    if (kind === "interrupt") {
      // requires_action 时的 interrupt：未决审批按 deny 处理（spec §6 / TOOL-09），最终 idle(end_turn)
      const pendingIds = ((session.stop_reason as { event_ids?: string[] } | null)?.event_ids ?? []).map(String);
      await append("session.status_running", {});
      for (const pendingId of pendingIds) {
        const fakeItemId = held.toolUseIds.get(pendingId) ?? (await this.lookupSourceEventId(sessionId, pendingId));
        await this.driver.send(held.handle, {
          type: "approval_response",
          sourceEventId: fakeItemId,
          approved: false,
          denyMessage: "interrupted",
        });
      }
      if (pendingIds.length === 0) {
        await append("session.status_idle", { stop_reason: { type: "end_turn" } });
        await settleExecution(this.db, executionId, generation, attemptId, { state: "completed" });
        return false;
      }
      await markDelivered(this.db, executionId, generation, attemptId);
    } else if (kind === "user_message") {
      if (interruptAlreadyRequested) {
        // 接手的 worker 遵守持久化中断：不再启动 turn，直接收尾（spec §6 / REC-02）
        await append("session.status_idle", { stop_reason: { type: "end_turn" } });
        await settleExecution(this.db, executionId, generation, attemptId, { state: "completed" });
        return false;
      }
      await append("session.status_running", {});
      const text = await this.textOfInput(sessionId, inputEventIds);
      await this.driver.send(held.handle, { type: "user_message", text });
      await markDelivered(this.db, executionId, generation, attemptId);
    } else if (kind === "tool_confirmation") {
      const conf = await this.loadEvent(sessionId, inputEventIds[0]!);
      const toolUseId = String(conf?.tool_use_id ?? "");
      const approved = conf?.result === "allow";
      const fakeItemId = held.toolUseIds.get(toolUseId) ?? (await this.lookupSourceEventId(sessionId, toolUseId));
      await append("session.status_running", {});
      await this.driver.send(held.handle, {
        type: "approval_response",
        sourceEventId: fakeItemId,
        approved,
        denyMessage: conf?.deny_message as string | undefined,
      });
      await markDelivered(this.db, executionId, generation, attemptId);
    }

    // 4) 事件循环：续约、中断、归一化事件 → 对外事件（spec §12.1）
    for (;;) {
      if (fenceLost) {
        await held.handle.stop("fence lost");
        this.runtimes.delete(sessionId);
        return false;
      }
      const ev = await this.driver.nextEvent(held.handle, TICK_MS);
      if (ev) {
        const done = await this.onRuntimeEvent(sessionId, executionId, generation, attemptId, held, ev, append);
        if (done !== null) {
          await settleExecution(this.db, executionId, generation, attemptId, { state: "completed" });
          return true;
        }
        continue;
      }
      // tick：续约 + 中断检查
      if (!(await renew())) continue;
      if (!interruptSent) {
        const row = await this.db
          .selectFrom("session_executions")
          .select(["interrupt_requested_at"])
          .where("id", "=", executionId)
          .executeTakeFirst();
        if (row?.interrupt_requested_at) {
          interruptSent = true;
          await this.driver.send(held.handle, { type: "interrupt" });
        }
      }
    }
  }

  /** sourceEventId 按 kind 加前缀，避免不同事件共用同一 driver itemId 时被唯一约束误判为重放。 */
  private static prefixed(kind: string, sourceId: string): string {
    return `${kind}:${sourceId}`;
  }

  private async onRuntimeEvent(
    sessionId: string,
    executionId: string,
    generation: number,
    attemptId: string,
    held: HeldRuntime,
    ev: NormalizedRuntimeEvent,
    append: (type: string, payload: Record<string, unknown>, opts?: { eventId?: string; sourceEventId?: string | null }) => Promise<SessionEventJson | null>,
  ): Promise<null | "turn_done" | "awaiting_approval"> {
    switch (ev.kind) {
      case "turn_started":
        return null;
      case "agent_thinking":
        await append(
          "agent.thinking",
          { content: [{ type: "thinking", thinking: ev.summary }] },
          { sourceEventId: SessionRunner.prefixed("th", ev.sourceId) },
        );
        return null;
      case "agent_message":
        await append(
          "agent.message",
          { content: [{ type: "text", text: ev.text }] },
          { sourceEventId: SessionRunner.prefixed("msg", ev.sourceId) },
        );
        return null;
      case "tool_use_started": {
        const eventId = newId("sevt");
        held.toolUseIds.set(ev.sourceId, eventId);
        await append(
          "agent.tool_use",
          { name: ev.toolName, input: ev.input, evaluated_permission: ev.evaluatedPermission },
          { eventId, sourceEventId: SessionRunner.prefixed("tu", ev.sourceId) },
        );
        return null;
      }
      case "tool_result": {
        const toolUseId = held.toolUseIds.get(ev.toolUseSourceId) ?? ev.toolUseSourceId;
        await append(
          "agent.tool_result",
          {
            tool_use_id: toolUseId,
            content: [{ type: "text", text: ev.content }],
            is_error: ev.isError,
          },
          { sourceEventId: SessionRunner.prefixed("tr", ev.sourceId) },
        );
        return null;
      }
      case "approval_request": {
        const toolUseId = held.toolUseIds.get(ev.toolUseSourceId);
        // 未决审批 → idle(requires_action)，event_ids 指向 agent.tool_use（spec §12.1）
        await append("session.status_idle", {
          stop_reason: { type: "requires_action", event_ids: toolUseId ? [toolUseId] : [] },
        });
        return "awaiting_approval";
      }
      case "turn_completed":
        await append("session.status_idle", {
          stop_reason: { type: "end_turn" },
        });
        return "turn_done";
      case "error":
        await append("session.error", {
          error: { type: "runtime_error", message: ev.message, retry_status: ev.retryable ? "retrying" : "terminal" },
        });
        if (!ev.retryable) {
          await append("session.status_idle", { stop_reason: { type: "error", error_type: "runtime_error" } });
          await settleExecution(this.db, executionId, generation, attemptId, {
            state: "failed",
            failure: { message: ev.message },
          });
          return "turn_done";
        }
        return null;
      default:
        return null;
    }
  }

  private async workspaceOf(sessionId: string): Promise<string> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["workspace_id"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row?.workspace_id ?? "";
  }

  private async textOfInput(sessionId: string, eventIds: string[]): Promise<string> {
    const rows = await this.db
      .selectFrom("session_events")
      .select(["payload"])
      .where("session_id", "=", sessionId)
      .where("id", "in", eventIds)
      .execute();
    const texts: string[] = [];
    for (const r of rows) {
      const content = (r.payload as { content?: { type: string; text?: string }[] }).content ?? [];
      for (const b of content) {
        if (b.type === "text" && b.text) texts.push(b.text);
      }
    }
    return texts.join("\n");
  }

  private async loadEvent(sessionId: string, eventId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .selectFrom("session_events")
      .select(["payload"])
      .where("session_id", "=", sessionId)
      .where("id", "=", eventId)
      .executeTakeFirst();
    return (row?.payload as Record<string, unknown>) ?? null;
  }

  private async lookupSourceEventId(sessionId: string, toolUseEventId: string): Promise<string> {
    // 审批恢复路径：从 agent.tool_use 事件行取 driver 的原始 itemId（去掉 kind 前缀）
    const row = await this.db
      .selectFrom("session_events")
      .select(["source_event_id"])
      .where("session_id", "=", sessionId)
      .where("id", "=", toolUseEventId)
      .executeTakeFirst();
    const raw = row?.source_event_id ?? toolUseEventId;
    return raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  }

  private async notifySeq(sessionId: string): Promise<void> {
    // 定序后的用户事件在 SSE 上出现（spec §7.3 第 5 条：SSE 在定序时推送）
    await sql`SELECT pg_notify('session:' || ${sessionId}, 'seq')`.execute(this.db);
  }
}
