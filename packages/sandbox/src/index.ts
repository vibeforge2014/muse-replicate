import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    const home = spec.codexHome;
    mkdirSync(join(home, "outputs"), { recursive: true });
    mkdirSync(join(home, "uploads"), { recursive: true });
    const sandboxId = `sbx_fake_${randomUUID().slice(0, 12)}`;
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
 * 资源限额。MVP 通过 docker CLI 驱动（无 dockerode 依赖）；
 * 仅在具备 Docker + runsc runtime 的宿主上可用（macOS 开发机不可用）。
 */
export class DockerProvider implements SandboxProvider {
  readonly kind = "docker";
  constructor(
    readonly image: string,
    readonly opts: { memory?: string; pidsLimit?: number; nanoCpus?: number; network?: string } = {},
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    // runsc runtime 可用性探测；探测失败按 runc 上报（§9.0 禁止虚报能力）
    try {
      const info = JSON.parse(await docker(["info", "--format", "{{json .Runtimes}}"], 5000)) as Record<string, unknown>;
      const hasRunsc = "runsc" in (info ?? {});
      return {
        isolation: hasRunsc ? "gvisor" : "runc",
        persistentWorkspace: true,
        egress: "enforced",
      };
    } catch {
      return { isolation: "runc", persistentWorkspace: true, egress: "advisory" };
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandboxId = `sbx_docker_${randomUUID().slice(0, 12)}`;
    const args = [
      "run", "-d", "--name", sandboxId,
      "--runtime", "runsc",
      "--network", this.opts.network ?? "sandbox-net", // internal 网络：无默认网关
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.opts.pidsLimit ?? 512),
      "--memory", this.opts.memory ?? "2g",
      ...(this.opts.nanoCpus ? ["--cpus", String(this.opts.nanoCpus / 1e9)] : []),
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
