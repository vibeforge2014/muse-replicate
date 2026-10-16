import { useEffect, useState } from "react";
import { Plus, Archive, ArchiveRestore, Edit, Trash2 } from "lucide-react";
import { agents } from "../api";
import type { AgentRecord } from "../api/types";
import { MasApiError } from "../api/client";
import AgentFormModal from "../components/AgentFormModal";

export default function AgentsPage() {
  const [list, setList] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentRecord | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const all = await agents.list(true);
      setList(all.filter((a) => showArchived || !a.archived_at));
    } catch (e: any) {
      setErr(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [showArchived]);

  const onArchive = async (a: AgentRecord) => {
    if (!confirm(a.archived_at ? `恢复 Agent "${a.name}"？` : `归档 Agent "${a.name}"？`)) return;
    try {
      if (a.archived_at) {
        // 平台没提供 unarchive；如需恢复请重新创建
        alert("当前不支持恢复已归档的 Agent，请重新创建。");
        return;
      }
      await agents.archive(a.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  const onDelete = async (a: AgentRecord) => {
    if (!confirm(`删除 Agent "${a.name}"？`)) return;
    // 平台无 delete endpoint；用 archive 替代
    try {
      await agents.archive(a.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Agent</h1>
          <p className="text-sm text-mas-500 mt-1">管理 Agent 配置（名称、模型、工具、技能）</p>
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
          <button className="btn-primary" onClick={() => setEditing("new")}>
            <Plus size={16} /> 新建
          </button>
        </div>
      </div>

      {err && <div className="card p-4 mb-4 text-red-600 text-sm">{err}</div>}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">模型</th>
              <th className="px-4 py-2 font-medium">版本</th>
              <th className="px-4 py-2 font-medium">工具/MCP</th>
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium">更新时间</th>
              <th className="px-4 py-2 font-medium w-32">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-mas-500">
                  暂无数据
                </td>
              </tr>
            )}
            {list.map((a) => (
              <tr key={a.id} className="border-t border-mas-100 hover:bg-mas-50">
                <td className="px-4 py-2">
                  <div className="font-medium">{a.name}</div>
                  {a.description && <div className="text-xs text-mas-500 mt-0.5">{a.description}</div>}
                </td>
                <td className="px-4 py-2 text-mas-600">
                  {a.model.id}
                  <span className="text-xs text-mas-400 ml-1">/ {a.model.effort}</span>
                </td>
                <td className="px-4 py-2 text-mas-600">v{a.version}</td>
                <td className="px-4 py-2 text-mas-600">
                  {a.tools.length > 0 ? `${a.tools.length} tools` : "—"}
                  {a.mcp_servers.length > 0 && (
                    <span className="ml-1 text-xs text-mas-400">+{a.mcp_servers.length} mcp</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {a.archived_at ? (
                    <span className="badge bg-mas-200 text-mas-700">已归档</span>
                  ) : (
                    <span className="badge bg-green-100 text-green-700">活跃</span>
                  )}
                </td>
                <td className="px-4 py-2 text-mas-500 text-xs">
                  {new Date(a.updated_at).toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      className="btn-ghost p-1"
                      onClick={() => setEditing(a)}
                      title="编辑"
                      disabled={!!a.archived_at}
                    >
                      <Edit size={14} />
                    </button>
                    <button
                      className="btn-ghost p-1"
                      onClick={() => onArchive(a)}
                      title={a.archived_at ? "恢复" : "归档"}
                    >
                      {a.archived_at ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                    </button>
                    <button
                      className="btn-ghost p-1 text-red-600"
                      onClick={() => onDelete(a)}
                      title="归档/删除"
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

      {editing && (
        <AgentFormModal
          agent={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
