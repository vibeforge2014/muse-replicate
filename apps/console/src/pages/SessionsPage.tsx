import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Trash2, Archive } from "lucide-react";
import { sessions, agents, environments } from "../api";
import type { SessionRecord, AgentRecord, EnvironmentRecord } from "../api/types";

export default function SessionsPage({ mode }: { mode?: "new" }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialAgentId = searchParams.get("agent_id") || "";

  const [list, setList] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // 新建表单状态
  const [agentList, setAgentList] = useState<AgentRecord[]>([]);
  const [envList, setEnvList] = useState<EnvironmentRecord[]>([]);
  const [selAgent, setSelAgent] = useState(initialAgentId);
  const [selEnv, setSelEnv] = useState("");
  const [title, setTitle] = useState("");
  const [initialMsg, setInitialMsg] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const all = await sessions.list({ include_archived: showArchived });
      setList(all);
    } catch (e: any) {
      setErr(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    if (mode === "new") {
      Promise.all([agents.list(), environments.list()]).then(([a, e]) => {
        setAgentList(a.filter((x) => !x.archived_at));
        setEnvList(e.filter((x) => !x.archived_at));
        if (!selAgent && a.length) setSelAgent(a[0].id);
        if (!selEnv && e.length) setSelEnv(e[0].id);
      });
    }
  }, [showArchived, mode]);

  const create = async () => {
    if (!selAgent || !selEnv) {
      alert("请选择 Agent 和 Environment");
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      const body: any = {
        agent: selAgent,
        environment_id: selEnv,
      };
      if (title.trim()) body.title = title.trim();
      if (initialMsg.trim()) {
        body.initial_events = [
          { type: "user.message", content: [{ type: "text", text: initialMsg.trim() }] },
        ];
      }
      const s = await sessions.create(body);
      navigate(`/sessions/${s.id}`);
    } catch (e: any) {
      setErr(e?.apiError?.message ?? e?.message ?? "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (s: SessionRecord) => {
    if (!confirm(`删除 Session "${s.title ?? s.id}"？`)) return;
    try {
      await sessions.delete(s.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "删除失败");
    }
  };

  const onArchive = async (s: SessionRecord) => {
    if (!confirm(`归档 Session "${s.title ?? s.id}"？`)) return;
    try {
      await sessions.archive(s.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  if (mode === "new") {
    return (
      <div className="p-6 max-w-2xl">
        <h1 className="text-2xl font-semibold mb-4">新建 Session</h1>
        <div className="card p-4 space-y-4">
          <div>
            <label className="label">Agent</label>
            <select className="input" value={selAgent} onChange={(e) => setSelAgent(e.target.value)}>
              <option value="">选择...</option>
              {agentList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (v{a.version})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Environment</label>
            <select className="input" value={selEnv} onChange={(e) => setSelEnv(e.target.value)}>
              <option value="">选择...</option>
              {envList.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">标题（可选）</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="label">初始消息（可选，创建后立即发送）</label>
            <textarea
              className="input min-h-24"
              value={initialMsg}
              onChange={(e) => setInitialMsg(e.target.value)}
              placeholder="你好..."
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={() => navigate("/sessions")}>
              取消
            </button>
            <button className="btn-primary" onClick={create} disabled={creating || !selAgent || !selEnv}>
              {creating ? "创建中..." : "创建"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Session</h1>
          <p className="text-sm text-mas-500 mt-1">查看和管理会话，点击进入聊天界面</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-mas-600 flex items-center gap-2">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded"
            />
            显示已归档
          </label>
          <button className="btn-primary" onClick={() => navigate("/sessions/new")}>
            <Plus size={16} /> 新建
          </button>
        </div>
      </div>

      {err && <div className="card p-4 mb-4 text-red-600 text-sm">{err}</div>}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">标题</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium">Token 用量</th>
              <th className="px-4 py-2 font-medium">更新时间</th>
              <th className="px-4 py-2 font-medium w-24">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-mas-500">
                  暂无 Session
                </td>
              </tr>
            )}
            {list.map((s) => (
              <tr
                key={s.id}
                className="border-t border-mas-100 hover:bg-mas-50 cursor-pointer"
                onClick={() => navigate(`/sessions/${s.id}`)}
              >
                <td className="px-4 py-2">
                  <div className="font-medium">{s.title ?? s.id.slice(0, 12)}</div>
                  <div className="text-xs text-mas-500">{s.id}</div>
                </td>
                <td className="px-4 py-2 text-mas-600">{s.agent.name}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={s.status} stopReason={s.stop_reason?.type} />
                </td>
                <td className="px-4 py-2 text-mas-600 text-xs">
                  in {s.usage.input_tokens} / out {s.usage.output_tokens}
                </td>
                <td className="px-4 py-2 text-mas-500 text-xs">{new Date(s.updated_at).toLocaleString()}</td>
                <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <button
                      className="btn-ghost p-1"
                      onClick={() => onArchive(s)}
                      title="归档"
                      disabled={!!s.archived_at}
                    >
                      <Archive size={14} />
                    </button>
                    <button
                      className="btn-ghost p-1 text-red-600"
                      onClick={() => onDelete(s)}
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status, stopReason }: { status: string; stopReason?: string }) {
  if (status === "running") {
    return (
      <span className="badge bg-blue-100 text-blue-700 flex items-center gap-1 w-fit">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
        running
      </span>
    );
  }
  if (status === "terminated") return <span className="badge bg-red-100 text-red-700">terminated</span>;
  if (stopReason === "requires_action")
    return <span className="badge bg-yellow-100 text-yellow-700">requires_action</span>;
  if (stopReason === "error" || stopReason === "retries_exhausted")
    return <span className="badge bg-red-100 text-red-700">{stopReason}</span>;
  return <span className="badge bg-mas-100 text-mas-600">idle</span>;
}
