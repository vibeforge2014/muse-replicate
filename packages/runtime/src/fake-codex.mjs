#!/usr/bin/env node
/**
 * Fake Codex app-server：按脚本应答的 JSON-RPC（stdio）假 runtime（spec plan 1.9）。
 * 行为由用户输入中的指令前缀驱动，供集成测试使用：
 *   - 默认：回显（agent.message = "echo: <text>"）
 *   - "run <cmd>"    → bash tool_use + tool_result（模拟执行 echo）
 *   - "ask ..."      → 审批流：tool_use(ask) → 等待 approvalResponse → tool_result
 *   - "sleep <sec>"  → 慢任务（测中断）
 *   - "fail"         → error 通知（可重试）
 *   - "crash"        → 进程直接退出（测 worker 恢复）
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const home = process.env.FAKE_CODEX_HOME ?? "/tmp/fake-codex-home";
mkdirSync(home, { recursive: true });
const rolloutPath = join(home, "rollout.json");

let nextId = 1;
const pendingApprovals = new Map(); // itemId -> {resolve}
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
      reply(id, { threadId: "thrx_" + (nextId++).toString(36) });
      return;
    case "thread/resume":
      reply(id, { threadId: params.threadId ?? "thrx_resumed" });
      return;
    case "thread/inject_items":
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
    const itemId = "itm_ask_" + nextId++;
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
      notify("item/completed", { itemId: "itm_msg_" + nextId++, itemType: "agentMessage", text: "done after approval" });
      history.push({ role: "agent", text: "done after approval" });
    } else {
      notify("item/completed", {
        itemId,
        itemType: "commandExecution",
        exitCode: 1,
        output: `denied: ${response.denyMessage ?? "user denied"}`,
      });
      notify("item/completed", { itemId: "itm_msg_" + nextId++, itemType: "agentMessage", text: "tool was denied" });
      history.push({ role: "agent", text: "tool was denied" });
    }
    persist();
    notify("turn/completed", { reason: "completed" });
    return;
  }
  if (text.startsWith("run")) {
    if (!hasBash) {
      notify("item/completed", { itemId: "itm_msg_" + nextId++, itemType: "agentMessage", text: "no tools available" });
      notify("turn/completed", { reason: "completed" });
      return;
    }
    const cmd = text.slice(3).trim();
    const itemId = "itm_cmd_" + nextId++;
    notify("item/started", { itemId, itemType: "commandExecution", command: cmd, evaluatedPermission: approval ? "ask" : "allow" });
    // always_allow 直接执行；always_ask 也自动放行（平台 ApprovalBroker 在 untrusted 下会拦截真正的破坏性命令）
    await sleep(approval ? 30 : 10);
    const output = `ran: ${cmd}`;
    notify("item/completed", { itemId, itemType: "commandExecution", exitCode: 0, output });
    notify("item/completed", { itemId: "itm_msg_" + nextId++, itemType: "agentMessage", text: `ran ${cmd}` });
    history.push({ role: "user", text }, { role: "agent", text: `ran ${cmd}` });
    persist();
    notify("turn/completed", { reason: "completed" });
    return;
  }
  const response = text.startsWith("echo:") ? text.slice(5).trim() : `echo: ${text}`;
  notify("item/started", { itemId: "itm_rsn_" + nextId++, itemType: "reasoning", summary: "thinking about it" });
  notify("item/completed", { itemId: "itm_msg_" + nextId++, itemType: "agentMessage", text: response });
  history.push({ role: "user", text }, { role: "agent", text: response });
  persist();
  notify("turn/completed", { reason: "completed" });
}

process.on("SIGTERM", () => process.exit(0));
