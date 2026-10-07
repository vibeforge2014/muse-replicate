import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DockerProvider, type SandboxHandle } from "../packages/sandbox/src/index.ts";

/**
 * DockerProvider 真实宿主实测（偏差 #7）：无 DB 依赖，直接驱动 docker CLI，
 * 覆盖 create（隔离参数/挂载/internal 网络）→ pause/resume → destroy 全生命周期。
 * 宿主不可达 docker（如无 Docker 的开发机/CI）自动 skip。
 * NAS/DSM 等无 runsc 内核上验证的是 runc 降级路径（§9.0 如实上报）。
 */

// docker 可达性同步探测（skipIf 需要）
let dockerOk = false;
try {
  execSync("docker info --format ok", { stdio: "pipe", timeout: 8000 });
  dockerOk = true;
} catch {
  dockerOk = false;
}

const IMAGE = process.env.MAS_DOCKER_PROVIDER_IMAGE ?? "busybox:latest";
const NETWORK = `mas-test-net-${Date.now().toString(36)}`;

function sh(args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const { execFile } = require("node:child_process") as typeof import("node:child_process");
    execFile("docker", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.join(" ")}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

const provider = new DockerProvider(IMAGE, { network: NETWORK, memory: "512m", pidsLimit: 128 });
const handles: SandboxHandle[] = [];
let networkCreated = false;

afterAll(async () => {
  for (const h of handles) await provider.destroy(h.sandboxId).catch(() => undefined);
  if (networkCreated) await sh(["network", "rm", NETWORK]).catch(() => undefined);
});

describe.skipIf(!dockerOk)("DockerProvider（真实宿主生命周期）", () => {
  test("capabilities：隔离等级与宿主 runsc 实际状态一致（§9.0 不虚报）", async () => {
    const caps = await provider.capabilities();
    let runscPresent = false;
    try {
      const runtimes = JSON.parse(await sh(["info", "--format", "{{json .Runtimes}}"])) as Record<string, unknown>;
      runscPresent = "runsc" in runtimes;
    } catch {
      runscPresent = false;
    }
    expect(caps.isolation).toBe(runscPresent ? "gvisor" : "runc");
    expect(caps.egress).toBe("enforced"); // internal 网络拓扑保证
  });

  test("create：容器运行 + §9.1 隔离参数 + 挂载物化 + internal 网络", async () => {
    const home = mkdtempSync(join(tmpdir(), "mas-docker-test-"));
    // mkdtemp 0700 在 gVisor directfs 下连容器 root 都过不了宿主 DAC（runc 会绕过）；
    // 生产形态 worker 物化目录为正常 umask，这里对齐
    chmodSync(home, 0o755);
    const outputs = join(home, "outputs");
    const uploadHost = join(home, "upload-src");
    mkdirSync(outputs);
    mkdirSync(uploadHost);
    writeFileSync(join(uploadHost, "hello.txt"), "uploaded-content");

    const h = await provider.create({
      sessionId: "sesn_docker_test",
      generation: 1,
      mounts: [{ hostPath: uploadHost, mountPath: "hello" }],
      codexHome: home,
      outputsDir: outputs,
    });
    handles.push(h);

    const inspect = JSON.parse(await sh(["inspect", h.sandboxId])) as Array<{
      State: { Running: boolean; Paused: boolean };
      HostConfig: { Memory: number; PidsLimit: number; CapDrop: string[]; SecurityOpt: string[] };
    }>;
    expect(inspect[0].State.Running).toBe(true);
    expect(inspect[0].HostConfig.Memory).toBe(512 * 1024 * 1024);
    // DSM 等内核未挂 pids cgroup 控制器时 daemon 静默丢弃 pids-limit（inspect 为 null）——接受宿主侧降级
    expect([128, null]).toContain(inspect[0].HostConfig.PidsLimit);
    expect(inspect[0].HostConfig.CapDrop).toContain("ALL");
    expect(inspect[0].HostConfig.SecurityOpt).toContain("no-new-privileges");

    // 挂载：宿主写 → 容器内可见（codexHome / uploads），且 uploads 只读
    const seen = await sh(["exec", h.sandboxId, "cat", "/mnt/session/uploads/hello/hello.txt"]);
    expect(seen).toBe("uploaded-content");
    const codexSeen = await sh(["exec", h.sandboxId, "ls", "/session/.codex"]);
    expect(codexSeen).toContain("outputs");
    await expect(
      sh(["exec", h.sandboxId, "sh", "-c", "echo x > /mnt/session/uploads/hello/hello.txt"]),
    ).rejects.toThrow(/read-only|denied|permission/i);

    // internal 网络：已自动创建且 Internal=true（无外路由）
    networkCreated = true;
    const net = JSON.parse(await sh(["network", "inspect", NETWORK])) as Array<{ Internal: boolean }>;
    expect(net[0].Internal).toBe(true);
  });

  test("pause/resume：状态翻转且容器存活", async () => {
    const h = handles[0];
    await provider.pause(h.sandboxId);
    let st = JSON.parse(await sh(["inspect", h.sandboxId])) as Array<{ State: { Paused: boolean; Running: boolean } }>;
    expect(st[0].State.Paused).toBe(true);
    await provider.resume(h.sandboxId);
    st = JSON.parse(await sh(["inspect", h.sandboxId])) as Array<{ State: { Paused: boolean; Running: boolean } }>;
    expect(st[0].State.Paused).toBe(false);
    expect(st[0].State.Running).toBe(true);
  });

  test("destroy：容器彻底移除", async () => {
    const home = mkdtempSync(join(tmpdir(), "mas-docker-test-"));
    chmodSync(home, 0o755);
    const h = await provider.create({
      sessionId: "sesn_docker_test2",
      generation: 1,
      mounts: [],
      codexHome: home,
      outputsDir: join(home, "outputs"),
    });
    await provider.destroy(h.sandboxId);
    await expect(sh(["inspect", h.sandboxId])).rejects.toThrow();
  });
});
