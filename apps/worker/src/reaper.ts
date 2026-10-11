/**
 * 空闲沙箱 reaper（spec §3 scheduler / §9.3 / §9.4）：
 * - 会话 idle 超过 idle_pause_after（默认 10min）→ provider.pause（k8s=删 Pod，目录留 PVC）；
 * - idle 超过 idle_destroy_after（默认 24h）→ provider.destroy + 清 sandbox_id（下一条消息懒重建，
 *   §14.2 checkpoint 恢复路径已就绪）；
 * - sandbox_orphans 定期 reconcile（§9.4：destroy 无法确认的沙箱反复重试直到 provider 确认）。
 * 多 worker 由 PG advisory lock 选主（每 tick 竞争，1 活跃）；env：
 *   MAS_REAPER=0 关闭 / MAS_REAPER_TICK_MS（默认 60s）/ MAS_IDLE_PAUSE_AFTER_S（600）
 *   / MAS_IDLE_DESTROY_AFTER_S（86400）。
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "@mas/db";
import { listUnresolvedOrphans, markOrphanAttempt, recordOrphan, type SandboxProvider } from "@mas/sandbox";

export interface ReaperDeps {
  db: Kysely<Database>;
  provider: SandboxProvider;
  /** 暂停/销毁前先释放 worker 本进程持有的 warm runtime（handle.stop + 移出 map）。 */
  dropRuntime?: (sessionId: string) => Promise<void> | void;
}

export interface ReaperOptions {
  pauseAfterSec?: number;
  destroyAfterSec?: number;
  /** 单次 tick 各段处理上限（防长事务/风暴）。 */
  batchPause?: number;
  batchDestroy?: number;
  batchOrphans?: number;
}

export interface ReapResult {
  paused: number;
  destroyed: number;
  orphansResolved: number;
  orphansRetried: number;
}

export function reaperOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  tickMs: number;
  opts: ReaperOptions;
} {
  return {
    enabled: env.MAS_REAPER !== "0",
    tickMs: Number(env.MAS_REAPER_TICK_MS ?? 60_000) || 60_000,
    opts: {
      pauseAfterSec: Number(env.MAS_IDLE_PAUSE_AFTER_S ?? 600) || 600,
      destroyAfterSec: Number(env.MAS_IDLE_DESTROY_AFTER_S ?? 86_400) || 86_400,
    },
  };
}

export async function reapOnce(deps: ReaperDeps, opts: ReaperOptions = {}): Promise<ReapResult> {
  const { db, provider } = deps;
  const pauseAfterSec = opts.pauseAfterSec ?? 600;
  const destroyAfterSec = opts.destroyAfterSec ?? 86_400;
  const batchPause = opts.batchPause ?? 20;
  const batchDestroy = opts.batchDestroy ?? 10;
  const batchOrphans = opts.batchOrphans ?? 10;
  const result: ReapResult = { paused: 0, destroyed: 0, orphansResolved: 0, orphansRetried: 0 };

  // ---- 1) destroy（先于 pause：同 tick 内更久的先回收，避免 pause→destroy 二段跳）----
  const toDestroy = await db
    .selectFrom("sessions")
    .select(["id as session_id", "sandbox_id", "sandbox_spec"])
    .where("sandbox_id", "is not", null)
    .where(sql<boolean>`coalesce(sandbox_state, 'active') in ('active', 'paused')`)
    .where("status", "=", "idle")
    .where(
      sql<boolean>`not exists (select 1 from session_executions e where e.session_id = sessions.id and e.state in ('queued', 'running', 'retrying'))`,
    )
    .where(
      sql<boolean>`(select max(created_at) from session_events ev where ev.session_id = sessions.id) < now() - make_interval(secs => ${sql.lit(destroyAfterSec)})`,
    )
    .limit(batchDestroy)
    .execute();
  for (const row of toDestroy) {
    if (deps.dropRuntime) await deps.dropRuntime(row.session_id);
    try {
      await provider.destroy(row.sandbox_id!);
      await db
        .updateTable("sessions")
        .set({ sandbox_id: null, sandbox_state: null, sandbox_paused_at: null, sandbox_spec: null })
        .where("id", "=", row.session_id)
        .execute();
      result.destroyed++;
    } catch (e) {
      // 无法确认销毁 → orphan 登记（§9.4），会话侧仍清引用（下一条消息懒重建新沙箱）
      await recordOrphan(db, {
        sandboxRef: row.sandbox_id!,
        sessionId: row.session_id,
        generation: 1,
        reason: "reaper_destroy_failed",
        lastError: (e as Error).message,
      }).catch(() => undefined);
      await db
        .updateTable("sessions")
        .set({ sandbox_id: null, sandbox_state: null, sandbox_paused_at: null, sandbox_spec: null })
        .where("id", "=", row.session_id)
        .execute();
      console.warn(`[reaper] destroy failed for ${row.session_id}: ${(e as Error).message}（已记 orphan）`);
    }
  }

  // ---- 2) pause ----
  const toPause = await db
    .selectFrom("sessions")
    .select(["id as session_id", "sandbox_id"])
    .where("sandbox_id", "is not", null)
    .where(sql<boolean>`coalesce(sandbox_state, 'active') = 'active'`)
    .where("status", "=", "idle")
    .where(
      sql<boolean>`not exists (select 1 from session_executions e where e.session_id = sessions.id and e.state in ('queued', 'running', 'retrying'))`,
    )
    .where(
      sql<boolean>`(select max(created_at) from session_events ev where ev.session_id = sessions.id) < now() - make_interval(secs => ${sql.lit(pauseAfterSec)})`,
    )
    .limit(batchPause)
    .execute();
  for (const row of toPause) {
    if (deps.dropRuntime) await deps.dropRuntime(row.session_id);
    try {
      await provider.pause(row.sandbox_id!);
      await db
        .updateTable("sessions")
        .set({ sandbox_state: "paused", sandbox_paused_at: new Date() })
        .where("id", "=", row.session_id)
        .execute();
      result.paused++;
    } catch (e) {
      console.warn(`[reaper] pause failed for ${row.session_id}: ${(e as Error).message}（下个 tick 重试）`);
    }
  }

  // ---- 3) sandbox_orphans reconcile（§9.4）----
  const orphans = (await listUnresolvedOrphans(db)).slice(0, batchOrphans);
  for (const o of orphans) {
    try {
      await provider.destroy(o.sandbox_ref);
      await markOrphanAttempt(db, o.id, true);
      result.orphansResolved++;
    } catch (e) {
      await markOrphanAttempt(db, o.id, false, (e as Error).message).catch(() => undefined);
      result.orphansRetried++;
    }
  }
  return result;
}

/**
 * 常驻循环：每 tick 以 PG advisory lock 竞选（多 worker 时同一 tick 仅一个执行，
 * spec §3 "1 活跃 + 备"）；锁在 tick 结束释放，不跨 tick 持有。
 */
export function startReaper(deps: ReaperDeps, tickMs = 60_000): () => void {
  const tick = async () => {
    let locked = false;
    try {
      const r = await sql`select pg_try_advisory_lock(hashtext('mas:reaper')) as ok`.execute(deps.db);
      locked = Boolean((r.rows[0] as { ok: boolean } | undefined)?.ok);
      if (!locked) return;
      const res = await reapOnce(deps);
      if (res.paused || res.destroyed || res.orphansResolved || res.orphansRetried) {
        console.log(
          `[reaper] paused=${res.paused} destroyed=${res.destroyed} orphans(resolved=${res.orphansResolved}, retried=${res.orphansRetried})`,
        );
      }
    } catch (e) {
      console.warn(`[reaper] tick failed: ${(e as Error).message}`);
    } finally {
      if (locked) await sql`select pg_advisory_unlock(hashtext('mas:reaper'))`.execute(deps.db).catch(() => undefined);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), tickMs);
  return () => clearInterval(timer);
}
