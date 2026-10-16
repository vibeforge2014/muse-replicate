import { useEffect, useState } from "react";
import { Plus, Edit, Archive } from "lucide-react";
import { environments } from "../api";
import type { EnvironmentRecord } from "../api/types";
import EnvFormModal from "../components/EnvFormModal";

export default function EnvironmentsPage() {
  const [list, setList] = useState<EnvironmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<EnvironmentRecord | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const all = await environments.list(true);
      setList(all.filter((e) => showArchived || !e.archived_at));
    } catch (e: any) {
      setErr(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [showArchived]);

  const onArchive = async (e: EnvironmentRecord) => {
    if (!confirm(`归档 Environment "${e.name}"？`)) return;
    try {
      await environments.archive(e.id);
      refresh();
    } catch (err: any) {
      alert(err?.apiError?.message ?? err?.message ?? "操作失败");
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Environment</h1>
          <p className="text-sm text-mas-500 mt-1">管理沙箱环境配置（隔离等级、网络、包管理）</p>
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
              <th className="px-4 py-2 font-medium">Isolation</th>
              <th className="px-4 py-2 font-medium">Networking</th>
              <th className="px-4 py-2 font-medium">Packages</th>
              <th className="px-4 py-2 font-medium">状态</th>
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
                  暂无数据
                </td>
              </tr>
            )}
            {list.map((e) => (
              <tr key={e.id} className="border-t border-mas-100 hover:bg-mas-50">
                <td className="px-4 py-2 font-medium">{e.name}</td>
                <td className="px-4 py-2 text-mas-600">{e.config.isolation ?? "默认"}</td>
                <td className="px-4 py-2 text-mas-600">
                  <span className="badge bg-mas-100 text-mas-700">{e.config.networking.type}</span>
                  {e.config.networking.type === "limited" && (
                    <div className="text-xs text-mas-500 mt-1">
                      {e.config.networking.allowed_hosts.length} hosts
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-mas-600">
                  {countPackages(e.config.packages)}
                </td>
                <td className="px-4 py-2">
                  {e.archived_at ? (
                    <span className="badge bg-mas-200 text-mas-700">已归档</span>
                  ) : (
                    <span className="badge bg-green-100 text-green-700">活跃</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      className="btn-ghost p-1"
                      onClick={() => setEditing(e)}
                      title="编辑"
                      disabled={!!e.archived_at}
                    >
                      <Edit size={14} />
                    </button>
                    <button
                      className="btn-ghost p-1 text-red-600"
                      onClick={() => onArchive(e)}
                      title="归档"
                    >
                      <Archive size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EnvFormModal
          env={editing === "new" ? null : editing}
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

function countPackages(p: any): string {
  if (!p) return "—";
  let total = 0;
  for (const k of ["apt", "npm", "pip", "cargo", "gem", "go"]) {
    total += (p[k] ?? []).length;
  }
  return total > 0 ? `${total} 个包` : "—";
}
