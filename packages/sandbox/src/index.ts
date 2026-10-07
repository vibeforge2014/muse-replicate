import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { sql, type Kysely } from "kysely";
import type { Database } from "@mas/db";

/**
 * SandboxProvider（spec §9）：worker 与具体沙箱实现之间的唯一边界。
 * - capabilities()：能力协商（§9.0 fail closed 的输入）；
 * - create/destroy：会话沙箱生命周期（§9.3）；
 * - 无法确认销毁的沙箱记入 sandbox_orphans，由 scheduler reconcile（§9.3）。
 */

export interface ProviderCapabilities {
  /** 隔离等级：gvisor / microvm / runc（§9.0 协商用）。 */
  isolation: "gvisor" | "microvm" | "runc";
  persistentWorkspace: boolean;
  egress: "enforced" | "advisory" | "unsupported";
}

export interface SandboxSpec {
  sessionId: string;
  generation: number;
  /** 挂载：内容已由 worker 物化到 hostPath，沙箱内只读挂到 mountPath。 */
  mounts: { hostPath: string; mountPath: string }[];
  /** CODEX_HOME 宿主侧目录（持久化 rollout/sqlite，§9.2）。 */
  codexHome: string;
  /** outputs 宿主侧目录（轮末收集，§5.5）。 */
  outputsDir: string;
}

export interface SandboxHandle {
  sandboxId: string;
  /** 实际运行目录约定（§9.2）。 */
  workspaceDir: string;
  outputsDir: string;
  uploadsDir: string;
}

export interface SandboxProvider {
  readonly kind: string;
  capabilities(): Promise<ProviderCapabilities>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /**
   * 迟绑定（spec §9.3 二期 warm pool）：把预建的"空沙箱"绑定到具体会话。
   * 真实 provider 在此挂载会话卷（codexHome/outputs/mounts）；未实现时
   * WarmPoolProvider 拒绝包装该 provider（fail closed，不虚报能力）。
   */
  attach?(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle>;
  pause(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// FakeSandboxProvider：FakeCodexDriver 配套（本机目录即"沙箱"）
// ---------------------------------------------------------------------------

/**
 * 本机假沙箱：fake home 扁平化为 §9.2 目录约定的宿主侧等价物
 * （uploads/ = /mnt/session/uploads，outputs/ = /mnt/session/outputs，
 *   home 根 = /session/.codex）。隔离等级由声明给出（测试/开发用）。
 */
export class FakeSandboxProvider implements SandboxProvider {
  readonly kind = "fake";
  private state = new Map<string, "ready" | "paused">();

  constructor(readonly declaredIsolation: "gvisor" | "microvm" | "runc" = "gvisor") {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      isolation: this.declaredIsolation,
      persistentWorkspace: true,
      egress: "unsupported", // 凭据出站由 egress-proxy 独立承担（§10）
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandboxId = `sbx_fake_${randomUUID().slice(0, 12)}`;
    return this.materialize(sandboxId, spec);
  }

  /** warm pool 迟绑定：复用预发的 sandboxId，按真实 spec 重新物化目录约定。 */
  async attach(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    return this.materialize(sandboxId, spec);
  }

  private materialize(sandboxId: string, spec: SandboxSpec): SandboxHandle {
    const home = spec.codexHome;
    mkdirSync(join(home, "outputs"), { recursive: true });
    mkdirSync(join(home, "uploads"), { recursive: true });
    writeFileSync(
      join(home, ".sandbox"),
      JSON.stringify({ sandboxId, sessionId: spec.sessionId, generation: spec.generation, kind: this.kind }),
    );
    this.state.set(sandboxId, "ready");
    return {
      sandboxId,
      workspaceDir: home,
      outputsDir: spec.outputsDir,
      uploadsDir: join(home, "uploads"),
    };
  }

  async pause(sandboxId: string): Promise<void> {
    this.state.set(sandboxId, "paused");
  }
  async resume(sandboxId: string): Promise<void> {
    this.state.set(sandboxId, "ready");
  }
  async destroy(sandboxId: string): Promise<void> {
    this.state.delete(sandboxId);
  }
}

// ---------------------------------------------------------------------------
// WarmPoolProvider（spec §9.3 二期：按 Environment 预建 N 个空沙箱）
// ---------------------------------------------------------------------------

/** 预热池统计（/internal/metrics 与测试观察用）。 */
export interface WarmPoolStats {
  /** 目标保温数量。 */
  min: number;
  /** 当前池内空沙箱数。 */
  warm: number;
  /** 命中预热的 create 次数。 */
  warmHits: number;
  /** 池空直落的冷创建次数。 */
  coldCreates: number;
  /** 后台补池执行次数 / 失败次数。 */
  refills: number;
  refillErrors: number;
}

export interface WarmPoolOptions {
  /** 保温数量（≤0 视为禁用，全部直落）。 */
  min: number;
  /** 预热沙箱临时宿主目录（缺省 OS tmp）。 */
  warmRoot?: string;
}

interface WarmEntry {
  sandboxId: string;
}

/**
 * 装饰器：包住支持 attach 的 provider，维持 min 个预建空沙箱。
 * - create(spec)：快路径弹出预热沙箱并迟绑定（inner.attach）；池空则直落 inner.create；
 * - 每次出池后后台补池（串行，避免预热风暴）；
 * - pause/resume/destroy 透传（针对已交付的活沙箱；池内沙箱由 drain 统一销毁）。
 * 构造即启动后台预热；进程退出前应调用 drain() 清理池内沙箱。
 */
export class WarmPoolProvider implements SandboxProvider {
  readonly kind: string;
  private readonly inner: SandboxProvider & { attach(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> };
  private readonly min: number;
  private readonly warmRoot: string;
  private pool: WarmEntry[] = [];
  /** 补池串行队列：构造期预热 / 出池补池 / prewarm 全部排同一链，防过填。 */
  private fillChain: Promise<void> = Promise.resolve();
  private fillPending = false;
  private stats: WarmPoolStats;

  constructor(inner: SandboxProvider, opts: WarmPoolOptions) {
    if (typeof inner.attach !== "function") {
      throw new Error(`WarmPoolProvider: provider ${inner.kind} does not support attach (late binding)`);
    }
    this.inner = inner as WarmPoolProvider["inner"];
    this.kind = `warmpool(${inner.kind})`;
    this.min = Math.max(0, Math.floor(opts.min));
    this.warmRoot = opts.warmRoot ?? tmpdir();
    this.stats = { min: this.min, warm: 0, warmHits: 0, coldCreates: 0, refills: 0, refillErrors: 0 };
    this.scheduleRefill();
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.inner.capabilities();
  }

  /** 等待池填满（测试/启动钩子用；与后台补池共用串行队列）。 */
  async prewarm(): Promise<void> {
    this.scheduleRefill();
    await this.fillChain;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const entry = this.pool.shift();
    this.stats.warm = this.pool.length;
    if (entry) {
      try {
        const handle = await this.inner.attach(entry.sandboxId, spec);
        this.stats.warmHits++;
        this.scheduleRefill();
        return handle;
      } catch {
        // 迟绑定失败：销毁该预热沙箱（尽力而为），直落冷创建
        await this.inner.destroy(entry.sandboxId).catch(() => undefined);
        this.stats.refillErrors++;
      }
    }
    this.stats.coldCreates++;
    const handle = await this.inner.create(spec);
    this.scheduleRefill();
    return handle;
  }

  async pause(sandboxId: string): Promise<void> {
    await this.inner.pause(sandboxId);
  }
  async resume(sandboxId: string): Promise<void> {
    await this.inner.resume(sandboxId);
  }
  async destroy(sandboxId: string): Promise<void> {
    await this.inner.destroy(sandboxId);
  }

  /** 销毁池内全部空沙箱（关停/测试用；已交付沙箱不在此列）。 */
  async drain(): Promise<void> {
    const entries = this.pool.splice(0);
    this.stats.warm = 0;
    for (const e of entries) {
      await this.inner.destroy(e.sandboxId).catch(() => undefined);
    }
  }

  getStats(): Readonly<WarmPoolStats> {
    return { ...this.stats, warm: this.pool.length };
  }

  /** 预热沙箱的占位 spec：临时宿主目录，无挂载无会话语义。 */
  private warmSpec(): SandboxSpec {
    const home = mkdtempSync(join(this.warmRoot, "mas-warm-"));
    return {
      sessionId: "warmup",
      generation: 0,
      mounts: [],
      codexHome: home,
      outputsDir: join(home, "warm-outputs"),
    };
  }

  private async fill(): Promise<void> {
    while (this.pool.length < this.min) {
      const handle = await this.inner.create(this.warmSpec());
      this.pool.push({ sandboxId: handle.sandboxId });
      this.stats.warm = this.pool.length;
    }
  }

  /**
   * 后台补池：排入串行队列（防预热风暴与过填）；已有补池在途或池已满时跳过。
   * 链尾发现仍未满（fill 期间又有人出池）则再排一轮。
   */
  private scheduleRefill(): void {
    if (this.fillPending || this.pool.length >= this.min) return;
    this.fillPending = true;
    this.stats.refills++;
    this.fillChain = this.fillChain
      .then(() => this.fill())
      .catch(() => {
        this.stats.refillErrors++;
      })
      .finally(() => {
        this.fillPending = false;
        if (this.pool.length < this.min) this.scheduleRefill();
      });
  }
}

// ---------------------------------------------------------------------------
// DockerProvider：兜底 provider（CI/生产 Linux + gVisor）
// ---------------------------------------------------------------------------

function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * Docker+runsc（spec §9.1）：internal 网络、CapDrop ALL、no-new-privileges、
 * 资源限额。MVP 通过 docker CLI 驱动（无 dockerode 依赖）。
 * runsc 可用性探测缓存：宿主没有 runsc（如 DSM 等未开 userns 的内核）时
 * create 以默认 runc 运行、capabilities 如实上报 runc（§9.0 禁止虚报）。
 */
export class DockerProvider implements SandboxProvider {
  readonly kind = "docker";
  private runscAvailable: boolean | undefined;
  constructor(
    readonly image: string,
    readonly opts: { memory?: string; pidsLimit?: number; nanoCpus?: string | number; network?: string } = {},
  ) {}

  /** runsc 探测（缓存；docker 不可达按无 runsc 处理）。 */
  private async hasRunsc(): Promise<boolean> {
    if (this.runscAvailable === undefined) {
      try {
        const runtimes = JSON.parse(await docker(["info", "--format", "{{json .Runtimes}}"], 5000)) as Record<string, unknown>;
        this.runscAvailable = "runsc" in (runtimes ?? {});
      } catch {
        this.runscAvailable = false;
      }
    }
    return this.runscAvailable;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    // 隔离等级如实上报；egress 由 internal 网络拓扑保证（§9.1：无外路由）
    return {
      isolation: (await this.hasRunsc()) ? "gvisor" : "runc",
      persistentWorkspace: true,
      egress: "enforced",
    };
  }

  /** 目标网络不存在时建为 internal（无默认网关）；并发竞争容忍已存在。 */
  private async ensureNetwork(name: string): Promise<void> {
    if (name === "host" || name === "none" || name === "bridge") return;
    try {
      await docker(["network", "inspect", name], 5000);
    } catch {
      await docker(["network", "create", "--internal", name], 15_000).catch(() => undefined);
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandboxId = `sbx_docker_${randomUUID().slice(0, 12)}`;
    const network = this.opts.network ?? "sandbox-net";
    const useRunsc = await this.hasRunsc();
    await this.ensureNetwork(network);
    // 防御性物化宿主侧目录（bind mount 要求存在；契约上 worker 已物化，这里兜底）
    mkdirSync(spec.outputsDir, { recursive: true });
    for (const m of spec.mounts) mkdirSync(m.hostPath, { recursive: true });
    const args = [
      "run", "-d", "--name", sandboxId,
      ...(useRunsc ? ["--runtime", "runsc"] : []),
      "--network", network,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.opts.pidsLimit ?? 512),
      "--memory", this.opts.memory ?? "2g",
      ...(this.opts.nanoCpus ? ["--cpus", String(Number(this.opts.nanoCpus) / 1e9)] : []),
      "-v", `${spec.codexHome}:/session/.codex`,
      "-v", `${spec.outputsDir}:/mnt/session/outputs`,
      ...spec.mounts.flatMap((m) => ["-v", `${m.hostPath}:/mnt/session/uploads/${m.mountPath}:ro`]),
      "--workdir", "/workspace",
      this.image, "sleep", "infinity",
    ];
    await docker(args);
    return {
      sandboxId,
      workspaceDir: "/workspace",
      outputsDir: "/mnt/session/outputs",
      uploadsDir: "/mnt/session/uploads",
    };
  }

  async pause(sandboxId: string): Promise<void> {
    await docker(["pause", sandboxId]);
  }
  async resume(sandboxId: string): Promise<void> {
    await docker(["unpause", sandboxId]);
  }
  async destroy(sandboxId: string): Promise<void> {
    try {
      await docker(["rm", "-f", sandboxId]);
    } catch (e) {
      // 无法确认销毁 → orphan 记录（§9.3），由 scheduler reconcile
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan 登记 / reconcile（spec §9.3）
// ---------------------------------------------------------------------------

export async function recordOrphan(
  db: Kysely<Database>,
  input: { sandboxRef: string; sessionId: string; generation: number; reason: string; lastError?: string },
): Promise<void> {
  await db
    .insertInto("sandbox_orphans")
    .values({
      sandbox_ref: input.sandboxRef,
      session_id: input.sessionId,
      generation: input.generation,
      reason: input.reason,
      last_error: input.lastError ?? null,
    })
    .execute();
}

export async function listUnresolvedOrphans(db: Kysely<Database>) {
  return db
    .selectFrom("sandbox_orphans")
    .selectAll()
    .where("resolved_at", "is", null)
    .orderBy("id", "asc")
    .limit(100)
    .execute();
}

export async function markOrphanAttempt(db: Kysely<Database>, id: number, ok: boolean, error?: string): Promise<void> {
  if (ok) {
    await db.updateTable("sandbox_orphans").set({ resolved_at: new Date() }).where("id", "=", id).execute();
  } else {
    await db
      .updateTable("sandbox_orphans")
      .set({ attempts: sql`attempts + 1`, last_error: error ?? null })
      .where("id", "=", id)
      .execute();
  }
}

/** 开发辅助：清空 fake 沙箱目录。 */
export function resetFakeSandboxHome(sessionId: string): void {
  rmSync(join(tmpdir(), "mas-fake-codex", sessionId), { recursive: true, force: true });
}
