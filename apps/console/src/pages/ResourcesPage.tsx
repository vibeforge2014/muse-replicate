import { useEffect, useState } from "react";
import { Upload, Trash2, Archive, Key, FolderTree, Zap, Webhook, RefreshCw } from "lucide-react";
import { files, vaults, memory, skills, deployments, webhooks, getApiKey } from "../api";
import type {
  FileRecord,
  VaultRecord,
  MemoryStoreRecord,
  SkillRecord,
  DeploymentRecord,
  WebhookRecord,
  CredentialRecord,
} from "../api/types";

const TABS = [
  { id: "files", label: "Files", icon: Upload },
  { id: "vaults", label: "Vaults", icon: Key },
  { id: "memory", label: "Memory", icon: FolderTree },
  { id: "skills", label: "Skills", icon: Zap },
  { id: "deployments", label: "Deployments", icon: RefreshCw },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ResourcesPage() {
  const [tab, setTab] = useState<TabId>("files");
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Resources</h1>
      <div className="flex border-b border-mas-200 mb-4">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm flex items-center gap-2 border-b-2 -mb-px ${
                tab === t.id ? "border-blue-600 text-blue-600" : "border-transparent text-mas-600 hover:text-mas-900"
              }`}
            >
              <Icon size={14} />
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === "files" && <FilesTab />}
      {tab === "vaults" && <VaultsTab />}
      {tab === "memory" && <MemoryTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "deployments" && <DeploymentsTab />}
      {tab === "webhooks" && <WebhooksTab />}
    </div>
  );
}

// ---------- Files ----------
function FilesTab() {
  const [list, setList] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [expires, setExpires] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await files.list());
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    try {
      await files.upload(f.name, f, { expiresAt: expires || undefined });
      setExpires("");
      e.target.value = "";
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const del = async (f: FileRecord) => {
    if (!confirm(`删除文件 "${f.filename}"？`)) return;
    try {
      await files.delete(f.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "删除失败");
    }
  };

  return (
    <div>
      <div className="card p-3 mb-4 flex items-end gap-2">
        <div>
          <label className="label">选择文件</label>
          <input type="file" onChange={upload} disabled={uploading} className="text-sm" />
        </div>
        <div>
          <label className="label">过期时间（可选，RFC3339）</label>
          <input
            type="datetime-local"
            className="input"
            value={expires}
            onChange={(e) => setExpires(e.target.value ? new Date(e.target.value).toISOString() : "")}
          />
        </div>
        {uploading && <span className="text-sm text-mas-500">上传中...</span>}
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">文件名</th>
              <th className="px-4 py-2 font-medium">大小</th>
              <th className="px-4 py-2 font-medium">SHA256</th>
              <th className="px-4 py-2 font-medium">过期</th>
              <th className="px-4 py-2 font-medium w-20">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  暂无文件
                </td>
              </tr>
            )}
            {list.map((f) => (
              <tr key={f.id} className="border-t border-mas-100">
                <td className="px-4 py-2 font-medium">{f.filename}</td>
                <td className="px-4 py-2 text-mas-600">{(f.size / 1024).toFixed(1)} KB</td>
                <td className="px-4 py-2 font-mono text-xs text-mas-500">{f.sha256.slice(0, 12)}...</td>
                <td className="px-4 py-2 text-xs text-mas-500">
                  {f.expires_at ? new Date(f.expires_at).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-2">
                  <button className="btn-ghost p-1 text-red-600" onClick={() => del(f)}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Vaults ----------
function VaultsTab() {
  const [list, setList] = useState<VaultRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await vaults.list(true));
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await vaults.create({ name: name.trim(), description: desc.trim() || null });
      setName("");
      setDesc("");
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "创建失败");
    }
  };

  const archive = async (v: VaultRecord) => {
    if (!confirm(`归档 Vault "${v.name}"？`)) return;
    try {
      await vaults.archive(v.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  return (
    <div>
      <div className="card p-3 mb-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="label">名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex-1">
          <label className="label">描述（可选）</label>
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={create} disabled={!name.trim()}>
          创建
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium w-40">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-mas-500">
                  暂无 Vault
                </td>
              </tr>
            )}
            {list.map((v) => (
              <>
                <tr key={v.id} className="border-t border-mas-100">
                  <td className="px-4 py-2">
                    <button onClick={() => setExpanded(expanded === v.id ? null : v.id)} className="font-medium text-left">
                      {expanded === v.id ? "▼" : "▶"} {v.name}
                    </button>
                    {v.description && <div className="text-xs text-mas-500 ml-4">{v.description}</div>}
                  </td>
                  <td className="px-4 py-2">
                    {v.archived_at ? (
                      <span className="badge bg-mas-200 text-mas-700">已归档</span>
                    ) : (
                      <span className="badge bg-green-100 text-green-700">活跃</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <button className="btn-ghost p-1 text-red-600" onClick={() => archive(v)}>
                      <Archive size={14} />
                    </button>
                  </td>
                </tr>
                {expanded === v.id && (
                  <tr key={v.id + "-creds"}>
                    <td colSpan={3} className="bg-mas-50 p-3">
                      <CredentialsPanel vaultId={v.id} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CredentialsPanel({ vaultId }: { vaultId: string }) {
  const [list, setList] = useState<CredentialRecord[]>([]);
  const [type, setType] = useState<"environment_variable" | "static_bearer" | "bearer">("environment_variable");
  const [cname, setCname] = useState("");
  const [secret, setSecret] = useState("");

  const refresh = async () => {
    try {
      setList(await vaults.credentials.list(vaultId));
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    }
  };
  useEffect(() => {
    refresh();
  }, [vaultId]);

  const create = async () => {
    if (!cname.trim() || !secret) return;
    try {
      await vaults.credentials.create(vaultId, {
        credential_type: type,
        name: cname.trim(),
        secret_value: secret,
      });
      setCname("");
      setSecret("");
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "创建失败");
    }
  };

  const archive = async (c: CredentialRecord) => {
    if (!confirm(`归档 Credential "${c.name}"？`)) return;
    try {
      await vaults.credentials.archive(vaultId, c.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-mas-700">凭据（仅显示脱敏值，原值不可读）</div>
      <table className="w-full text-sm bg-white rounded">
        <thead className="text-xs text-mas-600">
          <tr>
            <th className="px-2 py-1 text-left">名称</th>
            <th className="px-2 py-1 text-left">类型</th>
            <th className="px-2 py-1 text-left">脱敏值</th>
            <th className="px-2 py-1 w-16"></th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="px-2 py-2 text-center text-mas-500 text-xs">
                暂无凭据
              </td>
            </tr>
          )}
          {list.map((c) => (
            <tr key={c.id} className="border-t border-mas-100">
              <td className="px-2 py-1">{c.name}</td>
              <td className="px-2 py-1 text-xs">{c.credential_type}</td>
              <td className="px-2 py-1 font-mono text-xs">{c.masked_value}</td>
              <td className="px-2 py-1">
                <button className="btn-ghost p-1 text-red-600" onClick={() => archive(c)}>
                  <Archive size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-end gap-2 text-sm">
        <div>
          <label className="label text-xs">类型</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="environment_variable">env var</option>
            <option value="static_bearer">static bearer</option>
            <option value="bearer">bearer</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="label text-xs">名称</label>
          <input className="input" value={cname} onChange={(e) => setCname(e.target.value)} />
        </div>
        <div className="flex-1">
          <label className="label text-xs">密钥</label>
          <input
            type="password"
            className="input"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <button className="btn-secondary" onClick={create} disabled={!cname.trim() || !secret}>
          添加
        </button>
      </div>
    </div>
  );
}

// ---------- Memory ----------
function MemoryTab() {
  const [list, setList] = useState<MemoryStoreRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await memory.stores.list());
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await memory.stores.create({ name: name.trim() });
      setName("");
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "创建失败");
    }
  };

  return (
    <div>
      <div className="card p-3 mb-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="label">Store 名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={create} disabled={!name.trim()}>
          创建
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">Slug</th>
              <th className="px-4 py-2 font-medium">描述</th>
              <th className="px-4 py-2 font-medium">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-mas-500">
                  暂无 Memory Store
                </td>
              </tr>
            )}
            {list.map((m) => (
              <tr key={m.id} className="border-t border-mas-100">
                <td className="px-4 py-2 font-medium">{m.name}</td>
                <td className="px-4 py-2 text-mas-600 font-mono text-xs">{m.slug}</td>
                <td className="px-4 py-2 text-mas-600">{m.description ?? "—"}</td>
                <td className="px-4 py-2 text-xs text-mas-500">
                  {new Date(m.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Skills ----------
function SkillsTab() {
  const [list, setList] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await skills.list());
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    try {
      await skills.upload(f.name, f);
      e.target.value = "";
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <div className="card p-3 mb-4 flex items-center gap-3">
        <label className="btn-primary cursor-pointer">
          <Upload size={14} /> 上传 Skill（zip）
          <input type="file" accept=".zip" className="hidden" onChange={upload} disabled={uploading} />
        </label>
        {uploading && <span className="text-sm text-mas-500">上传中...</span>}
        <div className="text-xs text-mas-500">zip 须含 SKILL.md，按目录归一化存储</div>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">目录</th>
              <th className="px-4 py-2 font-medium">版本</th>
              <th className="px-4 py-2 font-medium">大小</th>
              <th className="px-4 py-2 font-medium">描述</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  暂无 Skill
                </td>
              </tr>
            )}
            {list.map((s) => (
              <tr key={s.id} className="border-t border-mas-100">
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className="px-4 py-2 font-mono text-xs text-mas-600">{s.directory}</td>
                <td className="px-4 py-2 text-mas-600">v{s.version}</td>
                <td className="px-4 py-2 text-mas-600">{(s.size / 1024).toFixed(1)} KB</td>
                <td className="px-4 py-2 text-mas-600">{s.description ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Deployments ----------
function DeploymentsTab() {
  const [list, setList] = useState<DeploymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [cron, setCron] = useState("");
  const [manualOnly, setManualOnly] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await deployments.list());
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    if (!name.trim() || !agentId) return;
    try {
      await deployments.create({
        agent_id: agentId,
        name: name.trim(),
        cron: cron || undefined,
        manual_only: manualOnly || !cron,
      });
      setName("");
      setCron("");
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "创建失败");
    }
  };

  const trigger = async (d: DeploymentRecord) => {
    try {
      await deployments.run(d.id);
      alert("已触发");
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "触发失败");
    }
  };

  const archive = async (d: DeploymentRecord) => {
    if (!confirm(`归档 Deployment "${d.name}"？`)) return;
    try {
      await deployments.archive(d.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  return (
    <div>
      <div className="card p-3 mb-4 grid grid-cols-4 gap-2">
        <div>
          <label className="label">名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Agent ID</label>
          <input className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        </div>
        <div>
          <label className="label">Cron（5字段，5min 间隔）</label>
          <input className="input" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/30 * * * *" />
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} />
            仅手动
          </label>
          <button className="btn-primary" onClick={create} disabled={!name.trim() || !agentId}>
            创建
          </button>
        </div>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium">触发方式</th>
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium w-32">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  暂无 Deployment
                </td>
              </tr>
            )}
            {list.map((d) => (
              <tr key={d.id} className="border-t border-mas-100">
                <td className="px-4 py-2 font-medium">{d.name}</td>
                <td className="px-4 py-2 text-mas-600 font-mono text-xs">{d.agent_id.slice(0, 16)}...</td>
                <td className="px-4 py-2 text-mas-600">
                  {d.manual_only ? (
                    <span className="badge bg-mas-100 text-mas-700">仅手动</span>
                  ) : (
                    <code className="text-xs">{d.cron}</code>
                  )}
                </td>
                <td className="px-4 py-2">
                  {d.archived_at ? (
                    <span className="badge bg-mas-200 text-mas-700">已归档</span>
                  ) : (
                    <span className="badge bg-green-100 text-green-700">活跃</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <button className="btn-ghost text-xs" onClick={() => trigger(d)}>
                    触发
                  </button>
                  <button className="btn-ghost p-1 text-red-600" onClick={() => archive(d)}>
                    <Archive size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Webhooks ----------
function WebhooksTab() {
  const [list, setList] = useState<WebhookRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await webhooks.list());
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    if (!name.trim() || !url.trim() || !events.trim()) return;
    try {
      const r = await webhooks.create({
        name: name.trim(),
        url: url.trim(),
        events: events.split(",").map((s) => s.trim()).filter(Boolean),
      });
      const secret = (r as any).secret;
      if (secret) {
        alert(`创建成功！Webhook secret (whsec_)：\n\n${secret}\n\n请妥善保存，secret 仅创建时返回。`);
      }
      setName("");
      setUrl("");
      setEvents("");
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "创建失败");
    }
  };

  const archive = async (w: WebhookRecord) => {
    if (!confirm(`归档 Webhook "${w.name}"？`)) return;
    try {
      await webhooks.archive(w.id);
      refresh();
    } catch (e: any) {
      alert(e?.apiError?.message ?? e?.message ?? "操作失败");
    }
  };

  return (
    <div>
      <div className="card p-3 mb-4 grid grid-cols-4 gap-2">
        <div>
          <label className="label">名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="label">URL</label>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhook"
          />
        </div>
        <div>
          <label className="label">事件（逗号分隔）</label>
          <input
            className="input"
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            placeholder="agent.message,session.status_idle"
          />
        </div>
        <div className="col-span-4">
          <button className="btn-primary" onClick={create} disabled={!name.trim() || !url.trim() || !events.trim()}>
            创建
          </button>
        </div>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mas-100 text-mas-700 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">URL</th>
              <th className="px-4 py-2 font-medium">事件</th>
              <th className="px-4 py-2 font-medium">启用</th>
              <th className="px-4 py-2 font-medium w-20">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  加载中...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mas-500">
                  暂无 Webhook
                </td>
              </tr>
            )}
            {list.map((w) => (
              <tr key={w.id} className="border-t border-mas-100">
                <td className="px-4 py-2 font-medium">{w.name}</td>
                <td className="px-4 py-2 text-mas-600 font-mono text-xs">{w.url}</td>
                <td className="px-4 py-2 text-xs text-mas-600">{w.events.join(", ")}</td>
                <td className="px-4 py-2">
                  {w.enabled ? (
                    <span className="badge bg-green-100 text-green-700">启用</span>
                  ) : (
                    <span className="badge bg-mas-200 text-mas-700">禁用</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <button className="btn-ghost p-1 text-red-600" onClick={() => archive(w)}>
                    <Archive size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
