import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sql, type Kysely } from "kysely";
import { newId, memoryPathError, spanTraceparent, startSpan, type SessionEventJson, type Span } from "@mas/core";
import type { Database } from "@mas/db";
import {
  appendEvent,
  appendInternalEvent,
  assignSeqAndProcessedAt,
  claimNextSteer,
  collectOutputs,
  commitCheckpoint,
  fallBackSteer,
  markSteerDelivered,
  recoverOrphanSteers,
  unsettledSteers,
  FAKE_CODEX_DIGEST,
  getLaneThreadId,
  reapExhaustedExecutions,
  fakeCodexHome,
  objectStoreFromEnv,
  getSessionRow,
  listFallbackCheckpoints,
  markCheckpointCorrupt,
  markDelivered,
  pendingLanes,
  readSkillZip,
  restoreCheckpoint,
  renewExecution,
  setLaneThreadId,
  settleExecution,
  claimNextExecution,
  upsertMemory,
  PreconditionFailedError,
  type CheckpointManifest,
  type SnapshotStore,
} from "@mas/db";
import {
  type AgentRuntimeDriver,
  type NormalizedRuntimeEvent,
  type RuntimeHandle,
} from "@mas/runtime";
import { FakeSandboxProvider, recordOrphan, type SandboxProvider, type SandboxSpec } from "@mas/sandbox";
import { egressEnvForSandbox } from "@mas/egress";
import { egressWireFromEnv, fetchEgressCa, prepareEgressBinding, revokeEgressBinding, type EgressWire } from "./egress.js";

const LEASE_SECONDS = 30;
const RENEW_INTERVAL_MS = 10_000;
const TICK_MS = 300;

/**
 * checkpoint 归档排除清单（真实 codex 的 CODEX_HOME 在会话 home 下）：
 *  - tmp/arg0 下有 codex 运行时解出的 241MB 级二进制包装器（打进归档会撑爆内存）；
 *  - cache/plugins/skills/models_cache/logs 均可由 codex 重建；
 *  - auth.json 是机密，绝不能落快照存储（restore 后由 driver 重新复制）。
 */
const CODEX_JUNK = [".codex/tmp/", ".codex/cache/", ".codex/plugins/", ".codex/skills/", ".codex/log/"];
const excludeFromCheckpoint = (rel: string): boolean =>
  rel === ".codex/auth.json" ||
  rel === ".codex/models_cache.json" ||
  rel === ".DS_Store" ||
  CODEX_JUNK.some((p) => rel.startsWith(p));

/** 单 lane 持有的 runtime 句柄（multiagent lanes，spec §5.6 二期：lane_id=thread_id）。 */
interface HeldLane {
  handle: RuntimeHandle;
  /** fake itemId → sevt id（审批与 tool_result 关联）。 */
  toolUseIds: Map<string, string>;
}

/** 会话级运行时壳：一个沙箱/一套 egress，每 lane 一个 thread 句柄。 */
interface HeldRuntime {
  lanes: Map<string, HeldLane>;
  /** egress binding（§10.4 attach 时签发；dispose/失栅时 revoke）。 */
  egress?: { bindingId: string; token: string; expiresAt: string };
}

/**
 * SessionRunner：持租约驱动一个会话的执行（spec §8、§7.1）。
 * driver 由 MAS_RUNTIME_DRIVER 选择（fake / codex app-server），接口统一（spec §8.1）。
 */
export interface RunnerFaults {
  /** 在 checkpoint 候选上传后、CAS 发布前模拟 worker 崩溃（REC-03）。 */
  crashBeforeCheckpointPublish?: boolean;
  /** 在输出对象上传后、manifest CAS 发布前模拟 worker 崩溃（REC-08）。 */
  crashAfterOutputUpload?: boolean;
}

export class SessionRunner {
  private runtimes = new Map<string, HeldRuntime>();
  private disposed = false;
  /** File 内容存储（与 api 同根；MAS_OBJECT_STORE=s3 时同为 MinIO/S3）。 */
  private filesStore = objectStoreFromEnv(process.env, process.env.MAS_FILES_DIR ?? "/tmp/mas-files");
  /** 测试故障注入（spec §5.19 的进程内等价物）。 */
  readonly faults: RunnerFaults = {};

  private provider: SandboxProvider;
  /** egress 生命周期接线（§10.4；MAS_EGRESS_URL 未设=关闭）。 */
  private egress: EgressWire | null = egressWireFromEnv();
  /** driver 进沙箱（spec §8.4；MAS_RUNTIME_SANDBOX=inside）。 */
  private inSandboxRuntime = false;

  constructor(
    private db: Kysely<Database>,
    private driver: AgentRuntimeDriver,
    private workerId = `worker_${process.pid}`,
    private store: SnapshotStore = objectStoreFromEnv(process.env, process.env.MAS_SNAPSHOT_DIR ?? "/tmp/mas-snapshots"),
    /** 沙箱 provider（或其声明的隔离等级字符串；Fake provider 兜底）。 */
    providerOrIsolation: SandboxProvider | string = new FakeSandboxProvider(
      (process.env.MAS_SANDBOX_ISOLATION as "gvisor" | "microvm" | "runc") ?? "gvisor",
    ),
  ) {
    this.provider =
      typeof providerOrIsolation === "string"
        ? new FakeSandboxProvider(providerOrIsolation as "gvisor" | "microvm" | "runc")
        : providerOrIsolation;
    // driver 进沙箱（spec §8.4）：MAS_RUNTIME_SANDBOX=inside 且 provider 支持 exec 时开启
    this.inSandboxRuntime = process.env.MAS_RUNTIME_SANDBOX === "inside";
  }

  /** 模拟 kill -9：中止在途工作并停掉全部 runtime（测试用）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [, shell] of this.runtimes) {
      if (shell.egress && this.egress) await revokeEgressBinding(this.egress, shell.egress.bindingId);
      for (const [, lane] of shell.lanes) {
        await lane.handle.stop("disposed").catch(() => undefined);
      }
    }
    this.runtimes.clear();
  }

  /**
   * 消费一个会话的全部待办（multiagent lanes，spec §5.6 二期）：
   * 同 lane 严格 FIFO（一个 lane 同时最多一个在途执行），跨 lane 并发推进。
   * 外层循环直到无待办：处理期间新 admitted 的 lane 也会被同一调用接走
   * （调用方的 in-flight 去重以会话为粒度，并发性由本次调用内部的 Promise.all 保证）。
   */
  async processSession(sessionId: string): Promise<void> {
    // 毒任务回收（REC-06）：耗尽且租约过期的执行置 failed 并写 exhausted 事件
    await reapExhaustedExecutions(this.db);
    // 孤儿 steer 兜底（参考 §7.4）：目标 turn 已终态的 steer 回退为排队执行
    await recoverOrphanSteers(this.db, sessionId);
    for (;;) {
      const lanes = await pendingLanes(this.db, sessionId);
      if (lanes.length === 0) return;
      if (lanes.length === 1) {
        await this.drainLane(sessionId, lanes[0]!);
        continue;
      }
      await Promise.all(lanes.map((lane) => this.drainLane(sessionId, lane)));
    }
  }

  /** 单 lane 的 claim 循环：返回表示租约窗口内可能还有后续工作（lane 内 FIFO）。 */
  private async drainLane(sessionId: string, laneId: string): Promise<void> {
    for (let i = 0; i < 20 && !this.disposed; i++) {
      const attemptId = `att_${randomUUID().slice(0, 12)}`;
      const exec = await claimNextExecution(this.db, sessionId, this.workerId, attemptId, LEASE_SECONDS, laneId);
      if (!exec) return;
      const more = await this.runExecution(sessionId, exec, attemptId, laneId);
      if (!more) return;
    }
  }

  /**
   * 执行 span 包装（spec §16：worker 以 execution.traceparent 为父）。
   * 结束时回读 session_executions.state 作为终态，异常按 error 结束。
   */
  private async runExecution(
    sessionId: string,
    exec: { id: string; generation: number; kind: string; input_event_ids: string[]; interrupt_requested_at: Date | null; delivered_at: Date | null; traceparent: string | null },
    attemptId: string,
    laneId: string,
  ): Promise<boolean> {
    const span: Span = startSpan(
      "mas.worker.execution",
      { worker_id: this.workerId, session_id: sessionId, execution_id: exec.id, kind: exec.kind, lane: laneId, attempt: attemptId },
      exec.traceparent,
    );
    try {
      const more = await this.runExecutionInner(sessionId, exec, attemptId, span, laneId);
      const row = await this.db
        .selectFrom("session_executions")
        .select("state")
        .where("id", "=", exec.id)
        .executeTakeFirst();
      span.end(row?.state !== "failed", { final_state: row?.state ?? "unknown", more_work: more });
      return more;
    } catch (e) {
      span.end(false, { error: String((e as Error).message).slice(0, 200) });
      throw e;
    }
  }

  /** 返回 true 表示同会话还有后续工作。 */
  private async runExecutionInner(
    sessionId: string,
    exec: { id: string; generation: number; kind: string; input_event_ids: string[]; interrupt_requested_at: Date | null; delivered_at: Date | null },
    attemptId: string,
    parentSpan: Span,
    laneId: string,
  ): Promise<boolean> {
    const executionId = exec.id;
    const generation = exec.generation;
    const kind = exec.kind;
    const inputEventIds = exec.input_event_ids;
    const interruptAlreadyRequested = exec.interrupt_requested_at !== null;
    // 接管判定：claim 到的是已 delivered 的过期租约 → 消息可能已进入 runtime，
    // 不得重放（避免重复副作用，spec §14.1 / REC-01）
    const tookOverDelivered = exec.delivered_at !== null && kind === "user_message" && !interruptAlreadyRequested;

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

    if (tookOverDelivered) {
      // REC-01：接管已投递的执行 → 不重放用户消息，terminal error + idle(end_turn)；
      // 其未完成的 steer 一并回退为排队执行（turn 已死，不重放不 steer，参考 §7.4 第 5 条）
      await this.settleSteersAtTurnEnd(sessionId, executionId);
      await append("session.error", {
        error: {
          type: "worker_takeover",
          message: "worker lost lease mid-turn; user message was not replayed",
          retry_status: "terminal",
        },
      });
      await append("session.status_idle", { stop_reason: { type: "end_turn" } });
      await settleExecution(this.db, executionId, generation, attemptId, { state: "completed" });
      return true;
    }

    // 1.5) 能力协商（spec §9.0 / REC-09）：不满足就 fail closed，禁止静默降级
    const envConfig = (session.environment_snapshot as { config?: { isolation?: string } }).config ?? {};
    const requiredIsolation = envConfig.isolation; // undefined → 平台默认 gvisor/microvm
    const caps = await this.provider.capabilities();
    const providedIsolation = caps.isolation;
    const isolationOk =
      requiredIsolation === "runc" ||
      providedIsolation === requiredIsolation ||
      (requiredIsolation === undefined && (providedIsolation === "gvisor" || providedIsolation === "microvm"));
    if (!isolationOk) {
      await append("session.error", {
        error: {
          type: "capability_unsatisfied",
          message: "sandbox provider cannot satisfy the environment's isolation requirement",
          retry_status: "terminal",
          details: { required: requiredIsolation ?? "gvisor|microvm", provided: providedIsolation },
        },
      });
      await append("session.status_terminated", { stop_reason: { type: "capability_unsatisfied" } });
      await settleExecution(this.db, executionId, generation, attemptId, {
        state: "failed",
        failure: { reason: "capability_unsatisfied" },
      });
      return false;
    }

    // 2) runtime（内存缓存；requires_action 期间保留）——按水位线决定 Level 0/1 恢复（lane 维度）
    const laneHeld = await this.acquireRuntime(sessionId, session, agent, hasAsk, hasToolset, { executionId, generation, attemptId, append }, laneId);
    // 2.1) 挂载 Session File Resource 到沙箱 uploads（只读；每轮重建，卸载即消失）
    await this.materializeResources(sessionId);
    // 3) 按执行类型推进（spec §5.6 kind）
    if (kind === "interrupt") {
      // requires_action 时的 interrupt：未决审批按 deny 处理（spec §6 / TOOL-09），最终 idle(end_turn)；
      // 未决自定义工具按中断作废（CT-04）
      const pendingIds = ((session.stop_reason as { event_ids?: string[] } | null)?.event_ids ?? []).map(String);
      await append("session.status_running", {});
      for (const pendingId of pendingIds) {
        const fakeItemId = laneHeld.toolUseIds.get(pendingId) ?? (await this.lookupSourceEventId(sessionId, pendingId));
        const target = await this.loadEvent(sessionId, pendingId);
        if (target?.type === "agent.custom_tool_use") {
          await this.driver.send(laneHeld.handle, {
            type: "custom_tool_output",
            sourceEventId: fakeItemId,
            output: "",
            interrupted: true,
          });
        } else {
          await this.driver.send(laneHeld.handle, {
            type: "approval_response",
            sourceEventId: fakeItemId,
            approved: false,
            denyMessage: "interrupted",
          });
        }
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
      await this.driver.send(laneHeld.handle, { type: "user_message", text });
      await markDelivered(this.db, executionId, generation, attemptId);
    } else if (kind === "tool_confirmation") {
      const conf = await this.loadEvent(sessionId, inputEventIds[0]!);
      const toolUseId = String(conf?.tool_use_id ?? "");
      const approved = conf?.result === "allow";
      const fakeItemId = laneHeld.toolUseIds.get(toolUseId) ?? (await this.lookupSourceEventId(sessionId, toolUseId));
      await append("session.status_running", {});
      await this.driver.send(laneHeld.handle, {
        type: "approval_response",
        sourceEventId: fakeItemId,
        approved,
        denyMessage: conf?.deny_message as string | undefined,
      });
      await markDelivered(this.db, executionId, generation, attemptId);
    } else if (kind === "custom_tool_result") {
      // 自定义工具结果（CT）：回写 runtime 续轮（事件已由 api 即时定序，spec §7.3 例外）
      const res = await this.loadEvent(sessionId, inputEventIds[0]!);
      const toolUseId = String(res?.tool_use_id ?? "");
      const output = String(res?.output ?? "");
      const fakeItemId = laneHeld.toolUseIds.get(toolUseId) ?? (await this.lookupSourceEventId(sessionId, toolUseId));
      await append("session.status_running", {});
      await this.driver.send(laneHeld.handle, { type: "custom_tool_output", sourceEventId: fakeItemId, output });
      await markDelivered(this.db, executionId, generation, attemptId);
    }

    // 4) 事件循环：续约、中断、归一化事件 → 对外事件（spec §12.1）
    // driver 子 span：覆盖与 runtime 的整个交互（send → nextEvent 循环 → 终态）
    const loopSpan = startSpan(
      "mas.worker.turn_loop",
      { session_id: sessionId, execution_id: executionId },
      spanTraceparent(parentSpan),
    );
    try {
    for (;;) {
      const shell = this.runtimes.get(sessionId);
      if (fenceLost) {
        if (shell?.egress && this.egress) await revokeEgressBinding(this.egress, shell.egress.bindingId);
        await laneHeld.handle.stop("fence lost");
        this.runtimes.delete(sessionId);
        loopSpan.end(false, { outcome: "fence_lost" });
        return false;
      }
      const ev = await this.driver.nextEvent(laneHeld.handle, TICK_MS);
      if (ev) {
        const done = await this.onRuntimeEvent(sessionId, executionId, generation, attemptId, laneHeld, ev, append);
        if (done !== null) {
          await settleExecution(this.db, executionId, generation, attemptId, { state: "completed" });
          loopSpan.end(true, { outcome: done });
          if (done === "turn_done") {
            // 轮末 steer 收尾（参考 §7.4 第 4 条）：delivered 未确认 → 回退排队（steer_unconsumed）；
            // 仍未 claimed 的 queued → 同样回退（turn 已结束）
            await this.settleSteersAtTurnEnd(sessionId, executionId);
            // 轮末持久化：watermark + checkpoint（spec §9.4 / §14.2.1）
            await this.checkpointTurn(sessionId, executionId, generation, attemptId);
            // 轮末产出收集：outputs → manifest → File 登记（spec §5.5 / REC-08）
            await this.collectOutputsTurn(sessionId, executionId, generation, attemptId, append);
            // 轮末 memory 回写：read_write 挂载下的沙箱写 → 新版本（MEM-08）
            await this.syncMemoryWrites(sessionId);
          }
          return true;
        }
        continue;
      }
      // tick：共享进程退出 → 交还租约（同会话其他 lane 同样受影响，各自退出由接管重试）；
      // 续约 + 中断检查
      if (laneHeld.handle.procExited?.()) {
        this.runtimes.delete(sessionId);
        loopSpan.end(false, { outcome: "proc_exited" });
        return false;
      }
      if (!(await renew())) continue;
      if (!interruptSent) {
        const row = await this.db
          .selectFrom("session_executions")
          .select(["interrupt_requested_at"])
          .where("id", "=", executionId)
          .executeTakeFirst();
        if (row?.interrupt_requested_at) {
          interruptSent = true;
          await this.driver.send(laneHeld.handle, { type: "interrupt" });
        }
      }
      // steer 插话（参考 §7.4）：同 turn 逐条串行；中断已发/进程已死 → 回退为排队执行
      await this.applySteers(sessionId, executionId, laneHeld, interruptSent);
    }
    } finally {
      loopSpan.end(); // 兜底收口（正常路径已在上方带 outcome 结束；幂等）
    }
  }

  /**
   * steer 插话投递（参考 §7.4）：当前 turn 的持有者逐条认领同 target 的 steer，
   * 尽力送进运行中的 runtime；任何拒绝/不支持/turn 已在收尾 → 回退为排队的 user_message
   * （保留 admitted_at，队头语义不变）。accepted/unknown → delivered：消费确认
   * （steer_confirmed）或 turn 结算（settleSteersAtTurnEnd）二者必居其一。
   */
  private async applySteers(
    sessionId: string,
    executionId: string,
    laneHeld: HeldLane,
    interruptSent: boolean,
  ): Promise<void> {
    for (;;) {
      const st = await claimNextSteer(this.db, sessionId, executionId, this.workerId, randomUUID(), 30);
      if (!st) return;
      if (interruptSent || laneHeld.handle.procExited?.()) {
        await fallBackSteer(this.db, st.id, "turn_cancelling");
        continue;
      }
      if (!this.driver.steer) {
        await fallBackSteer(this.db, st.id, "steer_unsupported");
        continue;
      }
      const text = await this.textOfInput(sessionId, st.input_event_ids);
      const ack = await this.driver.steer(laneHeld.handle, {
        sourceEventId: st.input_event_ids[0] ?? st.id,
        text,
      });
      if (ack.status === "rejected") {
        // no_active_turn / turn_mismatch / turn_not_steerable：回退排队，下个 turn 处理
        await fallBackSteer(this.db, st.id, ack.code);
        continue;
      }
      // accepted：runtime 已接单；unknown（超时类）：绝不重发，等消费确认或 turn 结算兜底
      await markSteerDelivered(this.db, st.id, st.generation, st.attempt_id ?? "");
    }
  }

  /**
   * turn 结束时结算未消费的 steer（参考 §7.4 第 4/5 条）：正常完成、接管或失败路径
   * 都调这里——仍未等到消费确认的 delivered steer 说明模型没看到它，回退排队。
   */
  private async settleSteersAtTurnEnd(sessionId: string, executionId: string): Promise<void> {
    const rows = await unsettledSteers(this.db, sessionId, executionId);
    for (const st of rows) {
      await fallBackSteer(this.db, st.id, "steer_unconsumed");
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
    lane: HeldLane,
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
        lane.toolUseIds.set(ev.sourceId, eventId);
        await append(
          "agent.tool_use",
          { name: ev.toolName, input: ev.input, evaluated_permission: ev.evaluatedPermission },
          { eventId, sourceEventId: SessionRunner.prefixed("tu", ev.sourceId) },
        );
        return null;
      }
      case "custom_tool_use_started": {
        // 自定义工具调用（CT）：业务方声明、平台外执行的工具
        const eventId = newId("sevt");
        lane.toolUseIds.set(ev.sourceId, eventId);
        await append(
          "agent.custom_tool_use",
          { name: ev.toolName, input: ev.input },
          { eventId, sourceEventId: SessionRunner.prefixed("ctu", ev.sourceId) },
        );
        return null;
      }
      case "custom_tool_output_request": {
        // turn 挂起等待业务方输出 → idle(requires_action)，event_ids 指向 agent.custom_tool_use（spec §7.3 例外）
        const toolUseId = lane.toolUseIds.get(ev.toolUseSourceId);
        await append("session.status_idle", {
          stop_reason: { type: "requires_action", event_ids: toolUseId ? [toolUseId] : [] },
        });
        return "awaiting_approval";
      }
      case "tool_result": {
        const toolUseId = lane.toolUseIds.get(ev.toolUseSourceId) ?? ev.toolUseSourceId;
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
        const toolUseId = lane.toolUseIds.get(ev.toolUseSourceId);
        // 未决审批 → idle(requires_action)，event_ids 指向 agent.tool_use（spec §12.1）
        await append("session.status_idle", {
          stop_reason: { type: "requires_action", event_ids: toolUseId ? [toolUseId] : [] },
        });
        return "awaiting_approval";
      }
      case "steer_confirmed": {
        // 定序点=消费确认（参考 §7.4 核心决策）：item/started(userMessage{clientId})
        // 到达的同一时刻为批内事件定序（processed_at = 模型实际看到它），再 completed；
        // wire 上此前的事件都在它之前、此后的事件才可能受它影响——§7.3 不变量严格成立
        const row = await this.db
          .selectFrom("session_executions")
          .selectAll()
          .where("session_id", "=", sessionId)
          .where("kind", "=", "steer")
          .where("state", "=", "delivered")
          .where(sql`input_event_ids[1] = ${ev.sourceId}`)
          .executeTakeFirst();
        if (!row) return null; // 不匹配的确认（历史注入等）——忽略
        await this.db.transaction().execute(async (tx) => {
          await assignSeqAndProcessedAt(tx, sessionId, row.input_event_ids, "normal");
        });
        await this.notifySeq(sessionId);
        await settleExecution(this.db, row.id, row.generation, row.attempt_id ?? "", { state: "completed" });
        return null;
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

  /**
   * 获取/恢复 runtime（spec §14.2.1 恢复判定 + §5.6 二期 lane 语义）：
   *  - 无历史 → 全新 thread；
   *  - active checkpoint 水位线+digest 与 sessions 行匹配 → Level 1 原生恢复
   *    （restore 文件 + thread/resume）；
   *  - 否则 → Level 0 语义恢复：从事件日志重放 user/agent 消息（绝不重放工具输入），
   *    产出内部事件 runtime.recovered{mode:"semantic",reason}。
   * lane 维度：main 沿用会话级 thread/checkpoint 判定；非 main lane 恢复自己的
   * session_lanes.codex_thread_id（丢失或水位线不符 → 全新 thread + 会话级语义重放）。
   * 热会话（本进程已持有沙箱/进程壳）加 lane：不 restore、不重放，直接 resume 持久化的
   * lane thread（进程内 CODEX_HOME 是活的，覆盖式 restore 反而会污染运行态）。
   */
  private async acquireRuntime(
    sessionId: string,
    session: { codex_thread_id: string | null; codex_version_digest: string | null; last_completed_execution_id: string | null; active_workspace_checkpoint: Record<string, unknown> | null; sandbox_id: string | null; sandbox_state: string | null; sandbox_spec: Record<string, unknown> | null },
    agent: { system: string | null; model: { id: string; effort?: string } },
    hasAsk: boolean,
    hasToolset: boolean,
    fence: {
      executionId: string;
      generation: number;
      attemptId: string;
      append: (type: string, payload: Record<string, unknown>) => Promise<SessionEventJson | null>;
    },
    laneId: string,
  ): Promise<HeldLane> {
    const shell0 = this.runtimes.get(sessionId);
    const existing = shell0?.lanes.get(laneId);
    if (existing) return existing;
    const cold = !shell0;

    // 真实 driver 提供版本指纹（CLI 升级 → Level 0）；fake 沿用库内常量
    const digest = this.driver.versionDigest ?? session.codex_version_digest ?? FAKE_CODEX_DIGEST;
    const active = session.active_workspace_checkpoint as unknown as CheckpointManifest | null;
    let resumeThreadId: string | undefined;
    let replayHistory: { role: "user" | "agent"; text: string }[] | undefined;
    let recovered: { mode: "native" } | { mode: "semantic"; reason: string } | null = null;

    if (!cold) {
      // 热 会话加 lane：resume 该 lane 持久化的 thread（没有就全新，首次使用的 lane 无历史可恢复）
      resumeThreadId =
        laneId === "main"
          ? (session.codex_thread_id ?? undefined)
          : ((await getLaneThreadId(this.db, sessionId, laneId)) ?? undefined);
    } else if (laneId === "main") {
      if (session.last_completed_execution_id || active) {
        if (
          active &&
          active.completed_execution_watermark === session.last_completed_execution_id
        ) {
          if (active.codex_version_digest === digest) {
            // Level 1：水位线一致 → 从 checkpoint 恢复文件并原生 resume
            try {
              await restoreCheckpoint(this.store, active, fakeCodexHome(sessionId));
              resumeThreadId = active.thread_id || undefined;
              recovered = { mode: "native" };
            } catch {
              // 校验失败：标记 corrupt、报 session.error，再降级语义恢复（REC-05）
              await markCheckpointCorrupt(this.db, sessionId, active.checkpoint_id);
              await fence.append("session.error", {
                error: {
                  type: "checkpoint_corrupt",
                  message: `checkpoint ${active.checkpoint_id} failed integrity verification`,
                  retry_status: "terminal",
                },
              });
              recovered = { mode: "semantic", reason: "checkpoint_corrupt" };
            }
          } else {
            // 原 digest 已下线（升级/召回）：强制 Level 0 并告知用户（spec §8.7 / REC-10）
            await fence.append("session.error", {
              error: {
                type: "runtime_upgraded",
                message: "runtime digest changed; falling back to semantic recovery",
                retry_status: "retrying",
                details: { checkpoint_digest: active.codex_version_digest, current_digest: digest },
              },
            });
            recovered = { mode: "semantic", reason: "runtime_upgraded" };
          }
        } else {
          // 水位线不一致（checkpoint 落后/超前或缺失）→ Level 0（REC-03）
          recovered = { mode: "semantic", reason: "watermark_mismatch" };
        }
        if (recovered?.mode === "semantic") {
          // 尽力恢复最近一个 superseded checkpoint 的文件（workspace 层面少丢一点）
          for (const fb of await listFallbackCheckpoints(this.db, sessionId)) {
            try {
              await restoreCheckpoint(this.store, fb, fakeCodexHome(sessionId));
              break;
            } catch {
              /* 尝试下一个回退候选 */
            }
          }
          replayHistory = await this.buildReplayHistory(sessionId);
        }
      }
    } else {
      // 冷 非 main lane：先尽力恢复会话文件（与 main Level 1 同判），再 resume lane thread；
      // 无法原生恢复 → 全新 thread + 会话级语义重放（lane 不丢上下文）
      const laneThreadId = await getLaneThreadId(this.db, sessionId, laneId);
      const watermarkOk = !!active && active.completed_execution_watermark === session.last_completed_execution_id;
      if (laneThreadId && watermarkOk && active && active.codex_version_digest === digest) {
        try {
          await restoreCheckpoint(this.store, active, fakeCodexHome(sessionId));
          resumeThreadId = laneThreadId;
          recovered = { mode: "native" };
        } catch {
          await markCheckpointCorrupt(this.db, sessionId, active.checkpoint_id);
          await fence.append("session.error", {
            error: {
              type: "checkpoint_corrupt",
              message: `checkpoint ${active.checkpoint_id} failed integrity verification`,
              retry_status: "terminal",
            },
          });
          recovered = { mode: "semantic", reason: "checkpoint_corrupt" };
        }
      } else if (active && !watermarkOk) {
        recovered = { mode: "semantic", reason: "watermark_mismatch" };
      } else if (!laneThreadId) {
        recovered = { mode: "semantic", reason: "lane_thread_missing" };
      }
      if (recovered?.mode === "semantic") {
        for (const fb of await listFallbackCheckpoints(this.db, sessionId)) {
          try {
            await restoreCheckpoint(this.store, fb, fakeCodexHome(sessionId));
            break;
          } catch {
            /* 尝试下一个回退候选 */
          }
        }
        replayHistory = await this.buildReplayHistory(sessionId);
      }
    }

    // driver 进沙箱（spec §8.4）：沙箱必须先于 runtime 存在——exec 落在沙箱 Pod 里，
    // 路径经 provider 映射（宿主 PVC 路径 ↔ 容器路径）
    const insideSandbox = this.inSandboxRuntime && typeof this.provider.exec === "function";
    let sandboxId = session.sandbox_id;
    let sandboxEgress: HeldRuntime["egress"];
    let sandboxSpec: Record<string, unknown> | null = null;
    if (sandboxId && session.sandbox_state === "paused") {
      // 懒恢复（spec §9.3：被 reaper 暂停的沙箱在下一条消息到来时 resume）；
      // 失败不阻塞——降级为销毁重建（工作区在 PVC/checkpoint，语义等价）
      try {
        await this.provider.resume(
          sandboxId,
          session.sandbox_spec ? (session.sandbox_spec as unknown as SandboxSpec) : undefined,
        );
        await this.db
          .updateTable("sessions")
          .set({ sandbox_state: "active", sandbox_paused_at: null })
          .where("id", "=", sessionId)
          .execute();
      } catch (e) {
        console.warn(`[worker] sandbox resume failed for ${sessionId}: ${(e as Error).message}（重建）`);
        await this.provider.destroy(sandboxId).catch(() => undefined);
        await recordOrphan(this.db, {
          sandboxRef: sandboxId,
          sessionId,
          generation: fence.generation,
          reason: "resume_failed",
          lastError: (e as Error).message,
        }).catch(() => undefined);
        sandboxId = null;
      }
    }
    if (insideSandbox && !sandboxId) {
      const r = await this.ensureSandbox(sessionId, fence);
      sandboxId = r.sandboxId;
      sandboxEgress = r.egress;
      sandboxSpec = r.spec;
    }

    const handle = await this.driver.start({
      sessionId,
      laneId,
      system: agent.system,
      model: agent.model,
      approvalPolicy: hasAsk ? "untrusted" : "never",
      hasBuiltinToolset: hasToolset,
      ...(resumeThreadId ? { resumeThreadId } : {}),
      ...(replayHistory?.length ? { replayHistory } : {}),
      ...(insideSandbox && sandboxId ? { remote: this.provider.exec!(sandboxId) } : {}),
    });
    const laneHeld: HeldLane = { handle, toolUseIds: new Map() };
    let shell = this.runtimes.get(sessionId);
    if (!shell) {
      shell = { lanes: new Map(), ...(sandboxEgress ? { egress: sandboxEgress } : {}) };
      this.runtimes.set(sessionId, shell);
    } else if (sandboxEgress) {
      shell.egress = sandboxEgress;
    }
    shell.lanes.set(laneId, laneHeld);
    // 宿主 runtime 模式：沙箱在 driver 之后建（原顺序，spec §9.3）
    if (!sandboxId) {
      const r = await this.ensureSandbox(sessionId, fence);
      sandboxId = r.sandboxId;
      sandboxSpec = r.spec;
      if (r.egress) shell.egress = r.egress;
    }
    // lane thread 持久化（spec §5.6 二期）：main 同时维护 sessions.codex_thread_id
    // （checkpoint watermark / reaper / 兼容旧查询仍以会话主 thread 为准）
    await setLaneThreadId(this.db, sessionId, laneId, handle.threadId);
    await this.db
      .updateTable("sessions")
      .set({
        ...(laneId === "main" ? { codex_thread_id: handle.threadId } : {}),
        codex_version_digest: digest,
        sandbox_id: sandboxId,
        // create 路径写入重建提示与状态（spec §9.3 reaper 状态机）
        ...(sandboxSpec ? { sandbox_spec: sandboxSpec, sandbox_state: "active", sandbox_paused_at: null } : {}),
      })
      .where("id", "=", sessionId)
      .execute();
    if (recovered) {
      await appendInternalEvent(this.db, sessionId, "runtime.recovered", {
        mode: recovered.mode,
        ...(recovered.mode === "semantic" ? { reason: recovered.reason } : {}),
        lane: laneId,
      });
    }
    return laneHeld;
  }

  /** 沙箱创建（spec §9.3）+ egress attach（§10.4）。 */
  private async ensureSandbox(
    sessionId: string,
    fence: { executionId: string; generation: number },
  ): Promise<{ sandboxId: string; spec: Record<string, unknown>; egress?: HeldRuntime["egress"] }> {
    const spec: {
      sessionId: string;
      generation: number;
      mounts: { hostPath: string; mountPath: string }[];
      codexHome: string;
      outputsDir: string;
      env?: Record<string, string>;
    } = {
      sessionId,
      generation: fence.generation,
      mounts: [],
      codexHome: fakeCodexHome(sessionId),
      outputsDir: join(fakeCodexHome(sessionId), "outputs"),
    };
    // egress attach（§10.4 生命周期：claim → prepare → create → attach）：
    // 签发出站 token + 写入企业 CA + 组装 HTTP(S)_PROXY env。
    // 失败只降级为"无代理沙箱"（warn 可观测），不阻塞会话执行。
    let egress: HeldRuntime["egress"] | undefined;
    if (this.egress) {
      try {
        const [binding, caPem] = await Promise.all([
          prepareEgressBinding(this.egress, {
            workspaceId: await this.workspaceOf(sessionId),
            sessionId,
            executionId: fence.executionId,
            generation: fence.generation,
            sandboxId: `pending:${sessionId}`,
            // 绑定随沙箱生命周期（Pod env 不可变）：exp 取沙箱尺度；
            // 逐请求 fence 校验 + revoke denylist 才是权威控制（§10.4）
            ttlSeconds: 86_400,
          }),
          fetchEgressCa(this.egress),
        ]);
        const caName = "egress-ca.crt";
        // inside 模式下顺序反转（沙箱先于 driver 创建），home 目录此刻可能尚不存在
        // （host 模式由本地 driver 进程先建）；CA 写入前先补建（PVC 上，Pod subPath 可见）
        mkdirSync(fakeCodexHome(sessionId), { recursive: true });
        writeFileSync(join(fakeCodexHome(sessionId), caName), caPem);
        // 沙箱内路径按 provider 约定：k8s 把 codexHome 挂在 /session/.codex；fake 同机同路径
        const caPath =
          this.provider.kind === "k8s" ? `/session/.codex/${caName}` : join(fakeCodexHome(sessionId), caName);
        spec.env = egressEnvForSandbox({ proxyUrl: this.egress.url, token: binding.token, caPath });
        egress = { bindingId: binding.bindingId, token: binding.token, expiresAt: binding.expiresAt };
      } catch (e) {
        console.warn(`[worker] egress attach skipped for ${sessionId}: ${(e as Error).message}`);
      }
    }
    const sbx = await this.provider.create(spec);
    return { sandboxId: sbx.sandboxId, spec: spec as Record<string, unknown>, ...(egress ? { egress } : {}) };
  }

  /**
   * 释放本进程持有的 warm runtime（reaper 暂停/销毁沙箱前调用）：
   * stop 全部 lane 的 driver 进程 + 移出 map；下一条消息按 checkpoint 恢复路径重建。
   * 不在此撤销 egress 绑定——绑定随沙箱生命周期（§10.4：resume 用同一 Pod env；
   * destroy 后由逐请求 fence 校验 + token exp 兜底）。
   */
  async dropRuntime(sessionId: string): Promise<void> {
    const shell = this.runtimes.get(sessionId);
    if (!shell) return;
    this.runtimes.delete(sessionId);
    for (const [, lane] of shell.lanes) {
      await lane.handle.stop("sandbox pause").catch(() => undefined);
    }
  }

  /**
   * Level 0 语义恢复的重放历史：只取 user.message / agent.message 的文本块
   * （spec §14.2.1：绝不重放工具输入与结果），按 seq 排序。
   */
  private async buildReplayHistory(sessionId: string): Promise<{ role: "user" | "agent"; text: string }[]> {
    const rows = await this.db
      .selectFrom("session_events")
      .select(["type", "payload"])
      .where("session_id", "=", sessionId)
      .where("seq", "is not", null)
      .where("type", "in", ["user.message", "agent.message"])
      .orderBy("seq", "asc")
      .execute();
    const history: { role: "user" | "agent"; text: string }[] = [];
    for (const r of rows) {
      const content = (r.payload as { content?: { type: string; text?: string }[] }).content ?? [];
      const text = content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
      if (text) history.push({ role: r.type === "user.message" ? "user" : "agent", text });
    }
    return history;
  }

  /** 轮末输出收集（spec §5.5）；上传后崩溃的注入点在 CAS 之前（REC-08）。 */
  private async collectOutputsTurn(
    sessionId: string,
    executionId: string,
    generation: number,
    attemptId: string,
    append: (type: string, payload: Record<string, unknown>) => Promise<SessionEventJson | null>,
  ): Promise<void> {
    if (this.faults.crashAfterOutputUpload) {
      // 模拟"对象已上传、CAS 之前"崩溃：先真实上传内容，再中止（恢复后靠 (path, sha256) 去重登记）
      const dir = join(fakeCodexHome(sessionId), "outputs");
      const entries = existsSync(dir) ? readdirSync(dir).sort() : [];
      for (const name of entries) {
        const bytes = readFileSync(join(dir, name));
        const sha = createHash("sha256").update(bytes).digest("hex");
        await this.filesStore.putIfAbsent(`outputs/${sessionId}/${sha}`, bytes);
      }
      throw new Error("fault: crash after output upload");
    }
    const result = await collectOutputs({
      db: this.db,
      store: this.filesStore,
      sessionId,
      executionId,
      generation,
      attemptId,
      outputsDir: join(fakeCodexHome(sessionId), "outputs"),
    });
    if (result.manifest.incomplete.length > 0) {
      await append("session.error", {
        error: {
          type: "output_incomplete",
          message: "some output files failed to upload or were still changing",
          retry_status: "terminal",
          details: { paths: result.manifest.incomplete },
        },
      });
    }
  }

  /**
   * 轮末持久化（spec §9.4 / §14.2.1 第 1-2 步）：
   * watermark.json 落盘到 CODEX_HOME → 打包不可变候选 → sha256 校验 → fence CAS 发布 → GC。
   */
  private async checkpointTurn(
    sessionId: string,
    executionId: string,
    generation: number,
    attemptId: string,
  ): Promise<void> {
    const ws = await this.workspaceOf(sessionId);
    const s = await getSessionRow(this.db, ws, sessionId);
    if (!s.last_completed_execution_id) return;
    const digest = s.codex_version_digest ?? FAKE_CODEX_DIGEST;
    const home = fakeCodexHome(sessionId);
    writeFileSync(
      join(home, "watermark.json"),
      JSON.stringify({
        last_completed_execution_id: s.last_completed_execution_id,
        codex_thread_id: s.codex_thread_id,
        codex_version_digest: digest,
      }),
    );
    if (this.faults.crashBeforeCheckpointPublish) {
      // 模拟 crash：settle 之后、候选写入之前（REC-03 场景）
      throw new Error("fault: crash before checkpoint publish");
    }
    await commitCheckpoint({
      db: this.db,
      store: this.store,
      sessionId,
      executionId,
      generation,
      attemptId,
      watermarkExecutionId: s.last_completed_execution_id,
      sourceDir: home,
      codexVersionDigest: digest,
      threadId: s.codex_thread_id ?? "",
      exclude: excludeFromCheckpoint,
    });
  }

  /**
   * 把 session_resources 指向的 File 内容放到 <home>/uploads/<mount_path>（spec §9.2），
   * 把 memory_store 挂载的 head 版本物化到 <home>/mnt/memory/<slug>（spec §19 / MEM-08）：
   * - read_only：写完后 chmod 目录 555 / 文件 444，agent 写入失败；
   * - read_write：保持可写，轮末由 syncMemoryWrites 回写为新版本；
   * - 每轮重建（先恢复可写权限再删除），卸载即消失。
   */
  private async materializeResources(sessionId: string): Promise<void> {
    const fileRows = await this.db
      .selectFrom("session_resources")
      .innerJoin("files", (join) => join.onRef("files.id", "=", "session_resources.file_id"))
      .select(["mount_path", "object_key"])
      .where("session_resources.session_id", "=", sessionId)
      .where("session_resources.type", "=", "file")
      .execute();
    const memRows = await this.db
      .selectFrom("session_resources")
      .innerJoin("memory_stores", (join) => join.onRef("memory_stores.id", "=", "session_resources.memory_store_id"))
      .select(["session_resources.memory_store_id", "session_resources.read_only", "memory_stores.slug"])
      .where("session_resources.session_id", "=", sessionId)
      .where("session_resources.type", "=", "memory_store")
      .execute();
    const skillRows = await this.db
      .selectFrom("session_resources")
      .innerJoin("skills", (join) => join.onRef("skills.id", "=", "session_resources.skill_id"))
      .select([
        "session_resources.skill_id",
        "session_resources.skill_version",
        "skills.directory",
        "skills.latest_version",
      ])
      .where("session_resources.session_id", "=", sessionId)
      .where("session_resources.type", "=", "skill")
      .execute();

    const home = fakeCodexHome(sessionId);
    const uploads = join(home, "uploads");
    chmodRecursiveWritable(uploads);
    rmSync(uploads, { recursive: true, force: true });
    if (fileRows.length > 0) {
      mkdirSync(uploads, { recursive: true });
      for (const r of fileRows) {
        const content = await this.filesStore.get(r.object_key).catch(() => null);
        if (!content) continue;
        const target = join(uploads, r.mount_path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }

    const mntRoot = join(home, "mnt", "memory");
    chmodRecursiveWritable(mntRoot);
    rmSync(mntRoot, { recursive: true, force: true });
    for (const m of memRows) {
      if (!m.memory_store_id) continue;
      const storeDir = join(mntRoot, m.slug);
      const entries = await this.db
        .selectFrom("memories")
        .innerJoin(
          "memory_versions",
          (join) =>
            join.onRef("memory_versions.memory_id", "=", "memories.id").on(
              "memory_versions.version_no",
              "=",
              sql`memories.head_version`,
            ),
        )
        .select(["memories.path", "memory_versions.content"])
        .where("memories.store_id", "=", m.memory_store_id)
        .execute();
      for (const e of entries) {
        if (e.content === null) continue;
        const target = join(storeDir, e.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, e.content);
      }
      if (m.read_only) {
        // 只读挂载：目录 555 / 文件 444（owner 无写位 → 同 uid 进程写入 EACCES）
        chmodRecursiveReadOnly(storeDir);
      }
    }

    // Skill 挂载：<home>/workspace/skills/<directory>/（SKL-06；每轮按固定版本重建）
    const skillsRoot = join(home, "workspace", "skills");
    chmodRecursiveWritable(skillsRoot);
    rmSync(skillsRoot, { recursive: true, force: true });
    if (skillRows.length === 0) return;
    for (const s of skillRows) {
      if (!s.skill_id) continue;
      const version = s.skill_version ?? s.latest_version;
      const row = await this.db
        .selectFrom("skill_versions")
        .select(["object_key"])
        .where("skill_id", "=", s.skill_id)
        .where("version", "=", version)
        .executeTakeFirst();
      if (!row) continue;
      const bytes = await this.filesStore.get(row.object_key).catch(() => null);
      if (!bytes) continue;
      const dir = join(skillsRoot, s.directory);
      for (const f of readSkillZip(bytes)) {
        const target = join(dir, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content);
      }
      chmodRecursiveReadOnly(dir);
    }
  }

  /**
   * 轮末回写 read_write 挂载下的 memory 写入（MEM-08）：
   * 对比 <home>/mnt/memory/<slug> 与各 path 的 head 版本 sha，新增/变更的写为新版本；
   * precondition 用回写前读到的 head sha——并发写者抢先时 upsert 抛冲突，跳过即可。
   */
  private async syncMemoryWrites(sessionId: string): Promise<void> {
    const mounts = await this.db
      .selectFrom("session_resources")
      .innerJoin("memory_stores", (join) => join.onRef("memory_stores.id", "=", "session_resources.memory_store_id"))
      .select(["session_resources.memory_store_id", "memory_stores.slug", "memory_stores.workspace_id"])
      .where("session_resources.session_id", "=", sessionId)
      .where("session_resources.type", "=", "memory_store")
      .where("session_resources.read_only", "=", false)
      .execute();
    if (mounts.length === 0) return;
    const root = join(fakeCodexHome(sessionId), "mnt", "memory");
    if (!existsSync(root)) return;

    for (const mount of mounts) {
      if (!mount.memory_store_id) continue;
      const storeDir = join(root, mount.slug);
      if (!existsSync(storeDir)) continue;
      for (const rel of walkFiles(storeDir)) {
        if (memoryPathError(rel) !== null) continue; // 非法路径（套接字/越界符号等）不回写
        let content: string;
        try {
          content = readFileSync(join(storeDir, rel), "utf8");
        } catch {
          continue;
        }
        const head = await this.db
          .selectFrom("memories")
          .innerJoin(
            "memory_versions",
            (join) =>
              join.onRef("memory_versions.memory_id", "=", "memories.id").on(
                "memory_versions.version_no",
                "=",
                sql`memories.head_version`,
              ),
          )
          .select(["memories.id", "memory_versions.content_sha256"])
          .where("memories.store_id", "=", mount.memory_store_id)
          .where("memories.path", "=", rel)
          .executeTakeFirst();
        const sha = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
        if (head && head.content_sha256 === sha) continue;
        try {
          await upsertMemory(this.db, {
            workspaceId: mount.workspace_id,
            storeId: mount.memory_store_id,
            path: rel,
            content,
            preconditionSha: head?.content_sha256 ?? undefined,
          });
        } catch (e) {
          if (e instanceof PreconditionFailedError) continue;
          throw e;
        }
      }
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

  /** 返回事件 payload（含 type 列；interrupt 分支按事件类型区分审批与自定义工具）。 */
  private async loadEvent(
    sessionId: string,
    eventId: string,
  ): Promise<(Record<string, unknown> & { type?: string }) | null> {
    const row = await this.db
      .selectFrom("session_events")
      .select(["payload", "type"])
      .where("session_id", "=", sessionId)
      .where("id", "=", eventId)
      .executeTakeFirst();
    if (!row) return null;
    return { ...(row.payload as Record<string, unknown>), type: row.type };
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

/** 递归恢复写权限（read_only 挂载在上一轮被 chmod 后，rm 前需要）。 */
function chmodRecursiveWritable(root: string): void {
  if (!existsSync(root)) return;
  chmodSync(root, 0o755);
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) chmodRecursiveWritable(p);
    else chmodSync(p, 0o644);
  }
}

/** read_only memory 挂载：目录 555 / 文件 444。 */
function chmodRecursiveReadOnly(root: string): void {
  if (!existsSync(root)) return;
  chmodSync(root, 0o555);
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) chmodRecursiveReadOnly(p);
    else chmodSync(p, 0o444);
  }
}

/** 列出 root 下所有文件的相对路径（POSIX 分隔符）。 */
function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}
