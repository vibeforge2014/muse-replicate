import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sql, type Kysely } from "kysely";
import { newId, memoryPathError, type SessionEventJson } from "@mas/core";
import type { Database } from "@mas/db";
import {
  appendEvent,
  appendInternalEvent,
  assignSeqAndProcessedAt,
  collectOutputs,
  commitCheckpoint,
  FAKE_CODEX_DIGEST,
  reapExhaustedExecutions,
  fakeCodexHome,
  FsSnapshotStore,
  getSessionRow,
  listFallbackCheckpoints,
  markCheckpointCorrupt,
  markDelivered,
  restoreCheckpoint,
  renewExecution,
  settleExecution,
  claimNextExecution,
  upsertMemory,
  PreconditionFailedError,
  type CheckpointManifest,
  type SnapshotStore,
} from "@mas/db";
import {
  FakeCodexDriver,
  type NormalizedRuntimeEvent,
  type RuntimeHandle,
} from "@mas/runtime";
import { FakeSandboxProvider, type SandboxProvider } from "@mas/sandbox";

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
export interface RunnerFaults {
  /** 在 checkpoint 候选上传后、CAS 发布前模拟 worker 崩溃（REC-03）。 */
  crashBeforeCheckpointPublish?: boolean;
  /** 在输出对象上传后、manifest CAS 发布前模拟 worker 崩溃（REC-08）。 */
  crashAfterOutputUpload?: boolean;
}

export class SessionRunner {
  private runtimes = new Map<string, HeldRuntime>();
  private disposed = false;
  /** File 内容存储（与 api 同根；MVP 本地 FS）。 */
  private filesStore = new FsSnapshotStore(process.env.MAS_FILES_DIR ?? "/tmp/mas-files");
  /** 测试故障注入（spec §5.19 的进程内等价物）。 */
  readonly faults: RunnerFaults = {};

  private provider: SandboxProvider;

  constructor(
    private db: Kysely<Database>,
    private driver: FakeCodexDriver,
    private workerId = `worker_${process.pid}`,
    private store: SnapshotStore = new FsSnapshotStore(process.env.MAS_SNAPSHOT_DIR ?? "/tmp/mas-snapshots"),
    /** 沙箱 provider（或其声明的隔离等级字符串；Fake provider 兜底）。 */
    providerOrIsolation: SandboxProvider | string = new FakeSandboxProvider(
      (process.env.MAS_SANDBOX_ISOLATION as "gvisor" | "microvm" | "runc") ?? "gvisor",
    ),
  ) {
    this.provider =
      typeof providerOrIsolation === "string"
        ? new FakeSandboxProvider(providerOrIsolation as "gvisor" | "microvm" | "runc")
        : providerOrIsolation;
  }

  /** 模拟 kill -9：中止在途工作并停掉全部 runtime（测试用）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [, held] of this.runtimes) await held.handle.stop("disposed").catch(() => undefined);
    this.runtimes.clear();
  }

  async processSession(sessionId: string): Promise<void> {
    // 毒任务回收（REC-06）：耗尽且租约过期的执行置 failed 并写 exhausted 事件
    await reapExhaustedExecutions(this.db);
    for (let i = 0; i < 20 && !this.disposed; i++) {
      const attemptId = `att_${randomUUID().slice(0, 12)}`;
      const exec = await claimNextExecution(this.db, sessionId, this.workerId, attemptId, LEASE_SECONDS);
      if (!exec) return;
      const more = await this.runExecution(sessionId, exec, attemptId);
      if (!more) return;
    }
  }

  /** 返回 true 表示同会话还有后续工作。 */
  private async runExecution(
    sessionId: string,
    exec: { id: string; generation: number; kind: string; input_event_ids: string[]; interrupt_requested_at: Date | null; delivered_at: Date | null },
    attemptId: string,
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
      // REC-01：接管已投递的执行 → 不重放用户消息，terminal error + idle(end_turn)
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

    // 2) runtime（内存缓存；requires_action 期间保留）——按水位线决定 Level 0/1 恢复
    let held = await this.acquireRuntime(sessionId, session, agent, hasAsk, hasToolset, { executionId, generation, attemptId, append });
    // 2.1) 挂载 Session File Resource 到沙箱 uploads（只读；每轮重建，卸载即消失）
    await this.materializeResources(sessionId);
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
          if (done === "turn_done") {
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

  /**
   * 获取/恢复 runtime（spec §14.2.1 恢复判定）：
   *  - 无历史 → 全新 thread；
   *  - active checkpoint 水位线+digest 与 sessions 行匹配 → Level 1 原生恢复
   *    （restore 文件 + thread/resume）；
   *  - 否则 → Level 0 语义恢复：从事件日志重放 user/agent 消息（绝不重放工具输入），
   *    产出内部事件 runtime.recovered{mode:"semantic",reason}。
   */
  private async acquireRuntime(
    sessionId: string,
    session: { codex_thread_id: string | null; codex_version_digest: string | null; last_completed_execution_id: string | null; active_workspace_checkpoint: Record<string, unknown> | null; sandbox_id: string | null },
    agent: { system: string | null; model: { id: string; effort?: string } },
    hasAsk: boolean,
    hasToolset: boolean,
    fence: {
      executionId: string;
      generation: number;
      attemptId: string;
      append: (type: string, payload: Record<string, unknown>) => Promise<SessionEventJson | null>;
    },
  ): Promise<HeldRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;

    const digest = session.codex_version_digest ?? FAKE_CODEX_DIGEST;
    const active = session.active_workspace_checkpoint as unknown as CheckpointManifest | null;
    let resumeThreadId: string | undefined;
    let replayHistory: { role: "user" | "agent"; text: string }[] | undefined;
    let recovered: { mode: "native" } | { mode: "semantic"; reason: string } | null = null;

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
      if (recovered.mode === "semantic") {
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

    const handle = await this.driver.start({
      sessionId,
      system: agent.system,
      model: agent.model,
      approvalPolicy: hasAsk ? "untrusted" : "never",
      hasBuiltinToolset: hasToolset,
      ...(resumeThreadId ? { resumeThreadId } : {}),
      ...(replayHistory?.length ? { replayHistory } : {}),
    });
    const held: HeldRuntime = { handle, toolUseIds: new Map() };
    this.runtimes.set(sessionId, held);
    // 沙箱创建/复用（spec §9.3）：首个 runtime 生命周期内创建一次，登记 sandbox_id
    let sandboxId = session.sandbox_id;
    if (!sandboxId) {
      const sbx = await this.provider.create({
        sessionId,
        generation: fence.generation,
        mounts: [],
        codexHome: fakeCodexHome(sessionId),
        outputsDir: join(fakeCodexHome(sessionId), "outputs"),
      });
      sandboxId = sbx.sandboxId;
    }
    await this.db
      .updateTable("sessions")
      .set({ codex_thread_id: handle.threadId, codex_version_digest: digest, sandbox_id: sandboxId })
      .where("id", "=", sessionId)
      .execute();
    if (recovered) {
      await appendInternalEvent(this.db, sessionId, "runtime.recovered", {
        mode: recovered.mode,
        ...(recovered.mode === "semantic" ? { reason: recovered.reason } : {}),
      });
    }
    return held;
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
    if (memRows.length === 0) return;
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
