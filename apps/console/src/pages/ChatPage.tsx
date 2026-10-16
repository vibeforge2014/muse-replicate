import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Send, Square, ChevronDown, ChevronRight, AlertTriangle, RotateCw, Wrench } from "lucide-react";
import { sessions } from "../api";
import type { SessionRecord, EventEnvelope, UserInputEvent } from "../api/types";
import { openSse, type SseClient } from "../api/sse";

export default function ChatPage() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const lastSeqRef = useRef<number>(0);
  const sseRef = useRef<SseClient | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sseStatusRef = useRef<"idle" | "open" | "error">("idle");

  // 初始加载：session + history
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const s = await sessions.get(id);
        setSession(s);
        const r = await sessions.listEvents(id, { order: "asc", limit: 200 });
        const evs = r.data;
        setEvents(evs);
        if (evs.length) {
          const maxSeq = evs.reduce((m, e) => (e.seq != null && Number(e.seq) > m ? Number(e.seq) : m), 0);
          lastSeqRef.current = maxSeq;
        }
      } catch (e: any) {
        setErr(e?.apiError?.message ?? e?.message ?? "加载失败");
      }
    })();
  }, [id]);

  // SSE 实时流
  useEffect(() => {
    if (!id) return;
    sseStatusRef.current = "idle";
    const lastId = lastSeqRef.current > 0 ? String(lastSeqRef.current) : null;
    const c = openSse(`/v1/sessions/${id}/events/stream`, lastId, {
      onOpen: () => {
        sseStatusRef.current = "open";
        setStreaming(true);
      },
      onFrame: (f) => {
        if (f.id) {
          const s = Number(f.id);
          if (s > lastSeqRef.current) lastSeqRef.current = s;
        }
        const ev = f.data as EventEnvelope;
        setEvents((prev) => {
          // 去重（按 id 或 seq）
          if (ev.id && prev.some((p) => p.id === ev.id)) return prev;
          if (ev.seq != null && prev.some((p) => p.seq === ev.seq)) return prev;
          return [...prev, ev];
        });
        // status 变化时刷新 session
        if (ev.type === "session.status_idle" || ev.type === "session.status_running" || ev.type === "session.status_terminated") {
          sessions.get(id).then(setSession).catch(() => {});
        }
      },
      onError: () => {
        sseStatusRef.current = "error";
        setStreaming(false);
      },
    });
    sseRef.current = c;
    return () => {
      c.close();
      sseRef.current = null;
    };
  }, [id]);

  // 自动滚动到底
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events.length]);

  // 刷新 session（status_idle 期间 usage 会更新）
  useEffect(() => {
    if (session?.status === "running") {
      const t = setInterval(() => {
        sessions.get(id).then(setSession).catch(() => {});
      }, 3000);
      return () => clearInterval(t);
    }
  }, [id, session?.status]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);
    try {
      const ev: UserInputEvent = { type: "user.message", content: [{ type: "text", text }] };
      const r = await sessions.sendEvents(id, [ev]);
      // 立即追加 user.message 到列表（不等 SSE）
      for (const e of r.data) {
        setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
      }
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "发送失败");
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!confirm("中断当前 turn？")) return;
    try {
      await sessions.sendEvents(id, [{ type: "user.interrupt" }]);
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "中断失败");
    }
  };

  const confirmTool = async (toolUseId: string, result: "allow" | "deny", denyMessage?: string) => {
    try {
      await sessions.sendEvents(id, [
        result === "allow"
          ? { type: "user.tool_confirmation", tool_use_id: toolUseId, result: "allow" }
          : { type: "user.tool_confirmation", tool_use_id: toolUseId, result: "deny", deny_message: denyMessage ?? "" },
      ]);
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  if (err) return <div className="p-6 text-red-600">{err}</div>;
  if (!session) return <div className="p-6 text-mas-500">加载中...</div>;

  const pendingTools = extractPendingTools(events, session.stop_reason);

  return (
    <div className="flex h-full">
      {/* 左侧：会话信息 */}
      <aside className="w-64 border-r bg-white p-4 overflow-auto">
        <Link to="/sessions" className="text-xs text-blue-600 hover:underline">
          ← 返回列表
        </Link>
        <h2 className="text-base font-semibold mt-2 mb-1">{session.title ?? session.id.slice(0, 12)}</h2>
        <div className="text-xs text-mas-500 mb-3">{session.id}</div>

        <div className="space-y-2 text-sm">
          <div>
            <div className="text-xs text-mas-500">Agent</div>
            <div className="font-medium">{session.agent.name}</div>
            <div className="text-xs text-mas-500">v{session.agent.version} · {session.agent.model.id}</div>
          </div>
          <div>
            <div className="text-xs text-mas-500">Status</div>
            <div className="font-medium">{session.status}</div>
            {session.stop_reason && (
              <div className="text-xs text-mas-500">stop: {session.stop_reason.type}</div>
            )}
          </div>
          <div>
            <div className="text-xs text-mas-500">Usage</div>
            <div className="font-mono text-xs">
              in: {session.usage.input_tokens}
              <br />
              out: {session.usage.output_tokens}
              <br />
              cache: {session.usage.cache_read_input_tokens}
            </div>
          </div>
          {session.resources.length > 0 && (
            <div>
              <div className="text-xs text-mas-500">Resources</div>
              <div className="text-xs">
                {session.resources.map((r, i) => (
                  <div key={i} className="font-mono">
                    {r.type}: {r.mount_path}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 右侧：聊天主区 */}
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                sseStatusRef.current === "open"
                  ? "bg-green-500 animate-pulse"
                  : sseStatusRef.current === "error"
                  ? "bg-red-500"
                  : "bg-mas-300"
              }`}
            />
            <span className="text-xs text-mas-500">
              {sseStatusRef.current === "open" ? "已连接" : sseStatusRef.current === "error" ? "连接断开" : "连接中..."}
            </span>
            <button
              className="btn-ghost p-1 ml-2"
              onClick={() => {
                sessions.get(id).then(setSession).catch(() => {});
                sessions.listEvents(id, { order: "asc", limit: 200 }).then((r) => setEvents(r.data));
              }}
              title="手动刷新"
            >
              <RotateCw size={12} />
            </button>
          </div>
          {session.status === "running" && (
            <button className="btn-danger text-xs" onClick={interrupt}>
              <Square size={12} /> 中断
            </button>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-auto p-4 space-y-2 bg-mas-50">
          {events.length === 0 && <div className="text-center text-mas-500 py-12">暂无消息</div>}
          {events.map((e) => (
            <EventBlock
              key={e.id ?? `${e.type}-${e.seq}`}
              ev={e}
              onToolConfirm={confirmTool}
            />
          ))}

          {pendingTools.length > 0 && (
            <div className="card p-3 bg-yellow-50 border-yellow-200">
              <div className="flex items-center gap-2 text-yellow-800 font-medium mb-2">
                <AlertTriangle size={14} /> 需要你的确认
              </div>
              {pendingTools.map((t) => (
                <div key={t.id} className="bg-white rounded p-2 mb-2 border border-yellow-200">
                  <div className="text-sm font-medium">
                    <Wrench size={12} className="inline mr-1" />
                    {t.name}
                  </div>
                  <pre className="text-xs bg-mas-50 p-2 rounded mt-1 overflow-auto max-h-32">
                    {JSON.stringify(t.input, null, 2)}
                  </pre>
                  <div className="flex gap-2 mt-2">
                    <button className="btn-primary text-xs" onClick={() => confirmTool(t.id, "allow")}>
                      允许
                    </button>
                    <button
                      className="btn-secondary text-xs"
                      onClick={() => {
                        const m = prompt("拒绝原因：");
                        if (m !== null) confirmTool(t.id, "deny", m);
                      }}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t bg-white p-3">
          <div className="flex items-end gap-2">
            <textarea
              className="input min-h-12 max-h-48 resize-y"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              disabled={session.status === "terminated"}
            />
            <button
              className="btn-primary h-10"
              onClick={send}
              disabled={!input.trim() || sending || session.status === "terminated"}
            >
              <Send size={14} /> 发送
            </button>
          </div>
          {session.status === "running" && (
            <div className="text-xs text-mas-500 mt-1">
              running 中：消息会以 steer 形式插话（除非 Agent 配置 steer_mode=queue）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function extractPendingTools(events: EventEnvelope[], stopReason: any): { id: string; name: string; input: any }[] {
  if (stopReason?.type !== "requires_action") return [];
  const ids = new Set<string>(stopReason.event_ids ?? []);
  const out: { id: string; name: string; input: any }[] = [];
  for (const e of events) {
    if ((e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") && ids.has(e.id)) {
      out.push({ id: e.id, name: (e as any).name ?? "tool", input: (e as any).input });
    }
  }
  return out;
}

function EventBlock({ ev, onToolConfirm }: { ev: EventEnvelope; onToolConfirm: (id: string, r: "allow" | "deny", m?: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const t = ev.type;

  if (t === "user.message") {
    const content = (ev as any).content as any[] | undefined;
    const text = (content ?? []).map((b) => b?.text ?? "").join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  if (t === "agent.message") {
    const content = (ev as any).content as any[] | undefined;
    const text = (content ?? []).map((b) => b?.text ?? "").join("");
    return (
      <div className="flex justify-start">
        <div className="max-w-[70%] bg-white border border-mas-200 rounded-2xl rounded-tl-sm px-4 py-2 text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  if (t === "agent.thinking") {
    const content = (ev as any).content as any[] | undefined;
    const text = (content ?? []).map((b) => b?.thinking ?? "").join("");
    return (
      <details className="text-xs text-mas-500 ml-2" open={false}>
        <summary className="cursor-pointer hover:text-mas-700">💭 thinking...</summary>
        <div className="ml-4 mt-1 italic whitespace-pre-wrap">{text}</div>
      </details>
    );
  }

  if (t === "agent.tool_use" || t === "agent.custom_tool_use") {
    return (
      <div className="ml-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-mas-500 hover:text-mas-700 flex items-center gap-1"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          🔧 {(ev as any).name ?? t}
        </button>
        {expanded && (
          <pre className="text-xs bg-mas-100 p-2 rounded mt-1 overflow-auto max-h-32">
            {JSON.stringify((ev as any).input, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (t === "agent.tool_result" || t === "agent.mcp_tool_result") {
    return (
      <div className="ml-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-mas-500 hover:text-mas-700 flex items-center gap-1"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          ↪ result
        </button>
        {expanded && (
          <pre className="text-xs bg-mas-50 border border-mas-200 p-2 rounded mt-1 overflow-auto max-h-32">
            {JSON.stringify((ev as any).content, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (t === "session.status_running") {
    return <div className="text-center text-xs text-blue-600 my-1">— running —</div>;
  }
  if (t === "session.status_idle") {
    return <div className="text-center text-xs text-mas-400 my-1">— idle —</div>;
  }
  if (t === "session.status_terminated") {
    return <div className="text-center text-xs text-red-600 my-1">— terminated —</div>;
  }
  if (t === "session.error") {
    return (
      <div className="card p-2 bg-red-50 border-red-200 text-xs text-red-700">
        error: {JSON.stringify((ev as any).error)}
      </div>
    );
  }

  // 其他事件类型折叠显示
  return (
    <details className="text-xs text-mas-400 ml-2">
      <summary className="cursor-pointer">{t}</summary>
      <pre className="bg-mas-50 p-2 rounded mt-1 overflow-auto max-h-32">{JSON.stringify(ev, null, 2)}</pre>
    </details>
  );
}
