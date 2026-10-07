#!/usr/bin/env node
/**
 * Fake Codex app-server：按脚本应答的 JSON-RPC（stdio）假 runtime（spec plan 1.9）。
 * 行为由用户输入中的指令前缀驱动，供集成测试使用：
 *   - 默认：回显（agent.message = "echo: <text>"）
 *   - "run <cmd>"    → bash tool_use + tool_result（模拟执行 echo）
 *   - "out <text>"   → 把 text 写入 outputs/note.txt（模拟沙箱产出，SBX-03/REC-08）
 *   - "ask ..."      → 审批流：tool_use(ask) → 等待 approvalResponse → tool_result
 *   - "tool <n> <j>" → 自定义工具：custom_tool_use → 等待 customToolOutput → agent.message 续轮
 *   - "sleep <sec>"  → 慢任务（测中断）
 *   - "fail"         → error 通知（可重试）
 *   - "crash"        → 进程直接退出（测 worker 恢复）
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import readline from "node:readline";

const home = process.env.FAKE_CODEX_HOME ?? "/tmp/fake-codex-home";
mkdirSync(home, { recursive: true });
const rolloutPath = join(home, "rollout.json");

let nextId = 1;
// 每进程随机 tag：worker 重启/多 worker 场景下 itemId 全局唯一，
// 避免事件 source_event_id 唯一约束把新轮产出误判为重放
const tag = randomUUID().slice(0, 6);
const pendingApprovals = new Map(); // itemId -> {resolve}
const pendingCustomTools = new Map(); // itemId -> {resolve, toolName}
let awaitingInterrupt = null;
let hasBash = true;
const emitter = new EventEmitter();

let history = [];
if (existsSync(rolloutPath)) {
  try {
    history = JSON.parse(readFileSync(rolloutPath, "utf8"));
  } catch {
    history = [];
  }
}
function persist() {
  writeFileSync(rolloutPath, JSON.stringify(history));
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((e) => {
    if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } });
    }
  });
});

async function handle(msg) {
  const { method, params = {}, id } = msg;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, capabilities: { turnInterrupt: true, threadResume: true, approvals: true } });
      return;
    case "thread/start":
      hasBash = params.capabilities?.bash !== false;
      reply(id, { threadId: `thrx_${tag}_${(nextId++).toString(36)}` });
      return;
    case "thread/resume":
      reply(id, { threadId: params.threadId ?? "thrx_resumed" });
      return;
    case "thread/inject_items":
      // Level 0 语义恢复：注入的历史成为 fake 的持久化 rollout（下一轮可被 checkpoint 捕获）
      for (const item of params.items ?? []) {
        if (item.type === "message") {
          history.push({ role: item.role, text: item.text });
        }
      }
      persist();
      reply(id, { ok: true });
      return;
    case "turn/start":
      reply(id, { ok: true });
      runTurn(params).catch(() => {});
      return;
    case "turn/interrupt":
      reply(id, { ok: true });
      if (awaitingInterrupt) awaitingInterrupt();
      return;
    case "item/approvalResponse": {
      const p = pendingApprovals.get(params.itemId);
      if (p) {
        pendingApprovals.delete(params.itemId);
        p.resolve(params);
      }
      return;
    }
    case "item/customToolOutput": {
      // 业务方的 user.custom_tool_result（或 requires_action 中断时的作废信号）
      const p = pendingCustomTools.get(params.itemId);
      if (p) {
        pendingCustomTools.delete(params.itemId);
        p.resolve(params);
      }
      return;
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
      }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      awaitingInterrupt = null;
      resolve();
    }, ms);
    awaitingInterrupt = () => {
      clearTimeout(timer);
      awaitingInterrupt = null;
      resolve();
    };
  });
}

function userText(params) {
  return (params.input ?? [])
    .filter((i) => i.type === "message")
    .map((i) => (i.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"))
    .join("\n")
    .trim();
}

async function runTurn(params) {
  const text = userText(params);
  const approval = params.approvalPolicy === "untrusted";
  notify("turn/started", {});
  if (text === "crash") {
    process.exit(70);
  }
  if (text.startsWith("sleep")) {
    const secs = Number(text.split(/\s+/)[1] ?? 5);
    await sleep(secs * 1000);
    notify("turn/completed", { reason: "interrupted" });
    return;
  }
  if (text === "fail") {
    notify("error", { message: "simulated upstream failure", retryable: true });
    notify("turn/completed", { reason: "error" });
    return;
  }
  if (text.startsWith("ask")) {
    const itemId = `itm_ask_${tag}_${nextId++}`;
    notify("item/started", {
      itemId,
      itemType: "commandExecution",
      command: text.slice(3).trim(),
      evaluatedPermission: "ask",
    });
    notify("item/awaitingApproval", { itemId });
    const response = await new Promise((resolve) => pendingApprovals.set(itemId, { resolve }));
    history.push({ role: "user", text });
    if (response.approved) {
      notify("item/completed", { itemId, itemType: "commandExecution", exitCode: 0, output: `approved-run:${text.slice(3).trim()}` });
      notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: "done after approval" });
      history.push({ role: "agent", text: "done after approval" });
    } else {
      notify("item/completed", {
        itemId,
        itemType: "commandExecution",
        exitCode: 1,
        output: `denied: ${response.denyMessage ?? "user denied"}`,
      });
      notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: "tool was denied" });
      history.push({ role: "agent", text: "tool was denied" });
    }
    persist();
    notify("turn/completed", { reason: "completed" });
    return;
  }
  if (text.startsWith("tool ")) {
    // 自定义工具（CT）：custom_tool_use → 挂起等待业务方输出 → 收到后 agent.message 续轮
    const rest = text.slice(5).trim();
    const sp = rest.indexOf(" ");
    const toolName = sp === -1 ? rest : rest.slice(0, sp);
    const argRaw = sp === -1 ? "{}" : rest.slice(sp + 1);
    let input;
    try {
      input = JSON.parse(argRaw);
    } catch {
      input = { raw: argRaw };
    }
    const itemId = `itm_ct_${tag}_${nextId++}`;
    notify("item/started", { itemId, itemType: "customToolCall", toolName, input });
    notify("item/awaitingCustomToolOutput", { itemId, toolName });
    const response = await new Promise((resolve) => pendingCustomTools.set(itemId, { resolve, toolName }));
    history.push({ role: "user", text });
    let outcome;
    if (response.interrupted) {
      outcome = `custom tool ${toolName} aborted by interrupt`;
    } else {
      outcome = `custom tool ${toolName} result: ${String(response.output ?? "")}`;
    }
    notify("item/completed", { itemId, itemType: "customToolCall", toolName });
    notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: outcome });
    history.push({ role: "agent", text: outcome });
    persist();
    notify("turn/completed", { reason: response.interrupted ? "interrupted" : "completed" });
    return;
  }
  if (text.startsWith("memwrite ")) {
    // 模拟 agent 写 Memory Store 挂载目录（MEM-08）：<home>/mnt/<relpath>
    // read_only 挂载被 worker chmod 只读 → 写失败以 agent.message 报告
    const rest = text.slice("memwrite ".length);
    const sp = rest.indexOf(" ");
    const rel = sp === -1 ? rest : rest.slice(0, sp);
    const payload = sp === -1 ? "" : rest.slice(sp + 1);
    let outcome;
    try {
      const target = join(home, "mnt", rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, payload);
      outcome = `memwrite ok: ${rel} (${payload.length} bytes)`;
    } catch (e) {
      outcome = `memwrite failed: ${rel}: ${e?.code ?? e?.message ?? e}`;
    }
    notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: outcome });
    history.push({ role: "user", text }, { role: "agent", text: outcome });
    persist();
    notify("turn/completed", { reason: "completed" });
    return;
  }
  if (text.startsWith("out")) {
    // 模拟沙箱产出：写入 <home>/outputs/note.txt，轮末由 worker 收集为 File（spec §5.5）
    const payload = text.slice(3).trim() || "(empty)";
    mkdirSync(join(home, "outputs"), { recursive: true });
    writeFileSync(join(home, "outputs", "note.txt"), payload);
    notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: `wrote note.txt (${payload.length} bytes)` });
    history.push({ role: "user", text }, { role: "agent", text: `wrote note.txt (${payload.length} bytes)` });
    persist();
    notify("turn/completed", { reason: "completed" });
    return;
  }
  if (text.startsWith("run")) {
    if (!hasBash) {
      notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: "no tools available" });
      notify("turn/completed", { reason: "completed" });
      return;
    }
    const cmd = text.slice(3).trim();
    const itemId = `itm_cmd_${tag}_${nextId++}`;
    notify("item/started", { itemId, itemType: "commandExecution", command: cmd, evaluatedPermission: approval ? "ask" : "allow" });
    // always_allow 直接执行；always_ask 也自动放行（平台 ApprovalBroker 在 untrusted 下会拦截真正的破坏性命令）
    await sleep(approval ? 30 : 10);
    const output = `ran: ${cmd}`;
    notify("item/completed", { itemId, itemType: "commandExecution", exitCode: 0, output });
    notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: `ran ${cmd}` });
    history.push({ role: "user", text }, { role: "agent", text: `ran ${cmd}` });
    persist();
    notify("turn/completed", { reason: "completed" });
    return;
  }
  const response = text.startsWith("echo:") ? text.slice(5).trim() : `echo: ${text}`;
  notify("item/started", { itemId: `itm_rsn_${tag}_${nextId++}`, itemType: "reasoning", summary: "thinking about it" });
  notify("item/completed", { itemId: `itm_msg_${tag}_${nextId++}`, itemType: "agentMessage", text: response });
  history.push({ role: "user", text }, { role: "agent", text: response });
  persist();
  notify("turn/completed", { reason: "completed" });
}

process.on("SIGTERM", () => process.exit(0));
