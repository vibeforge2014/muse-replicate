import { useEffect, useState } from "react";
import { Link, useLocation, Outlet, useNavigate } from "react-router-dom";
import { Bot, Cog, MessageSquare, FolderOpen, KeyRound, LogOut, RefreshCw } from "lucide-react";
import { getApiKey, setApiKey, health } from "../api";

const navItems = [
  { path: "/agents", label: "Agent", icon: Bot },
  { path: "/environments", label: "Environment", icon: Cog },
  { path: "/sessions", label: "Session", icon: MessageSquare },
  { path: "/resources", label: "Resources", icon: FolderOpen },
];

export default function Layout() {
  const [authed, setAuthed] = useState(!!getApiKey());
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setAuthed(!!getApiKey());
  }, [location.pathname]);

  const checkHealth = async () => {
    try {
      await health.check();
      setHealthOk(true);
    } catch {
      setHealthOk(false);
    }
  };

  if (!authed) {
    return <ApiKeyGate onSet={() => setAuthed(true)} />;
  }

  return (
    <div className="flex h-screen">
      <aside className="w-56 bg-mas-800 text-white flex flex-col">
        <div className="px-4 py-4 border-b border-mas-700">
          <div className="text-lg font-semibold">MAS Console</div>
          <div className="text-xs text-mas-300 mt-1">管理界面</div>
        </div>
        <nav className="flex-1 py-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = location.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                  active ? "bg-mas-700 text-white" : "text-mas-200 hover:bg-mas-700/50 hover:text-white"
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-mas-700 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                healthOk === null ? "bg-mas-400" : healthOk ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-mas-200">{healthOk === null ? "未检查" : healthOk ? "API 可达" : "API 不可达"}</span>
            <button onClick={checkHealth} className="ml-auto text-mas-300 hover:text-white" title="重新检查">
              <RefreshCw size={12} />
            </button>
          </div>
          <button
            onClick={() => {
              setApiKey(null);
              setAuthed(false);
              navigate("/");
            }}
            className="flex items-center gap-2 text-xs text-mas-300 hover:text-white w-full"
          >
            <LogOut size={12} />
            清除 API Key
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto bg-mas-50">
        <Outlet />
      </main>
    </div>
  );
}

function ApiKeyGate({ onSet }: { onSet: () => void }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!key.trim()) return;
    setLoading(true);
    setErr(null);
    setApiKey(key.trim());
    try {
      await health.check();
      onSet();
    } catch (e: any) {
      setApiKey(null);
      setErr(e?.apiError?.message ?? e?.message ?? "连接失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="card p-8 w-96">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="text-blue-600" />
          <h1 className="text-xl font-semibold">设置 API Key</h1>
        </div>
        <p className="text-sm text-mas-500 mb-4">用于访问 MAS API 的 Bearer Token，存于本地 localStorage。</p>
        <label className="label">API Key</label>
        <input
          type="password"
          className="input"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="mas_..."
        />
        {err && <div className="mt-2 text-sm text-red-600">{err}</div>}
        <button className="btn-primary mt-4 w-full" onClick={submit} disabled={loading || !key.trim()}>
          {loading ? "验证中..." : "保存并连接"}
        </button>
      </div>
    </div>
  );
}
