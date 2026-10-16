import { useState } from "react";
import { X } from "lucide-react";
import { environments } from "../api";
import type { EnvironmentRecord, Isolation } from "../api/types";

interface Props {
  env: EnvironmentRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function EnvFormModal({ env, onClose, onSaved }: Props) {
  const isNew = !env;
  const [name, setName] = useState(env?.name ?? "");
  const [description, setDescription] = useState(env?.description ?? "");
  const [isolation, setIsolation] = useState<Isolation | "">(env?.config.isolation ?? "");
  const [netType, setNetType] = useState<"unrestricted" | "limited">(env?.config.networking.type ?? "unrestricted");
  const [allowedHosts, setAllowedHosts] = useState(
    env?.config.networking.type === "limited" ? env.config.networking.allowed_hosts.join("\n") : ""
  );
  const [allowPm, setAllowPm] = useState(
    env?.config.networking.type === "limited" ? env.config.networking.allow_package_managers : false
  );
  const [allowMcp, setAllowMcp] = useState(
    env?.config.networking.type === "limited" ? env.config.networking.allow_mcp_servers : false
  );
  const [apt, setApt] = useState((env?.config.packages?.apt ?? []).join("\n"));
  const [npm, setNpm] = useState((env?.config.packages?.npm ?? []).join("\n"));
  const [pip, setPip] = useState((env?.config.packages?.pip ?? []).join("\n"));
  const [cargo, setCargo] = useState((env?.config.packages?.cargo ?? []).join("\n"));
  const [gem, setGem] = useState((env?.config.packages?.gem ?? []).join("\n"));
  const [go, setGo] = useState((env?.config.packages?.go ?? []).join("\n"));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setErr(null);
    setSaving(true);
    try {
      const config: any = {
        type: "cloud",
        ...(isolation ? { isolation } : {}),
        networking:
          netType === "unrestricted"
            ? { type: "unrestricted" }
            : {
                type: "limited",
                allowed_hosts: allowedHosts
                  .split(/\s+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
                allow_package_managers: allowPm,
                allow_mcp_servers: allowMcp,
              },
      };
      const packages: any = {};
      const arr = (s: string) => s.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      if (apt.trim()) packages.apt = arr(apt);
      if (npm.trim()) packages.npm = arr(npm);
      if (pip.trim()) packages.pip = arr(pip);
      if (cargo.trim()) packages.cargo = arr(cargo);
      if (gem.trim()) packages.gem = arr(gem);
      if (go.trim()) packages.go = arr(go);
      if (Object.keys(packages).length > 0) {
        if (netType !== "limited" || !allowPm) {
          throw new Error("启用 packages 需要 networking=limited 且 allow_package_managers=true");
        }
        config.packages = packages;
      }

      if (isNew) {
        await environments.create({
          name,
          description: description || null,
          config,
        });
      } else {
        await environments.update(env!.id, {
          name,
          description: description || null,
          config,
        });
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.apiError?.message ?? e?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{isNew ? "新建 Environment" : `编辑 Environment: ${env!.name}`}</h2>
          <button onClick={onClose} className="btn-ghost p-1">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">名称 *</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">描述</label>
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <label className="label">Isolation</label>
              <select className="input" value={isolation} onChange={(e) => setIsolation(e.target.value as any)}>
                <option value="">默认（平台）</option>
                <option value="gvisor">gvisor</option>
                <option value="microvm">microvm</option>
                <option value="runc">runc</option>
              </select>
            </div>
            <div>
              <label className="label">Networking</label>
              <select className="input" value={netType} onChange={(e) => setNetType(e.target.value as any)}>
                <option value="unrestricted">unrestricted</option>
                <option value="limited">limited</option>
              </select>
            </div>
          </div>

          {netType === "limited" && (
            <div className="space-y-3 p-3 bg-mas-50 rounded">
              <div>
                <label className="label">Allowed Hosts（一行一个，支持通配符 *.example.com）</label>
                <textarea
                  className="input min-h-20 font-mono text-xs"
                  value={allowedHosts}
                  onChange={(e) => setAllowedHosts(e.target.value)}
                />
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={allowPm} onChange={(e) => setAllowPm(e.target.checked)} />
                  允许包管理
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={allowMcp} onChange={(e) => setAllowMcp(e.target.checked)} />
                  允许 MCP Servers
                </label>
              </div>
            </div>
          )}

          <details className="border rounded">
            <summary className="cursor-pointer p-3 text-sm font-medium">包管理（需 limited + allow_package_managers）</summary>
            <div className="p-3 grid grid-cols-2 gap-3">
              {[
                ["apt", apt, setApt],
                ["npm", npm, setNpm],
                ["pip", pip, setPip],
                ["cargo", cargo, setCargo],
                ["gem", gem, setGem],
                ["go", go, setGo],
              ].map(([label, val, setter]: any) => (
                <div key={label}>
                  <label className="label">{label}</label>
                  <textarea
                    className="input min-h-16 font-mono text-xs"
                    value={val}
                    onChange={(e) => setter(e.target.value)}
                  />
                </div>
              ))}
            </div>
          </details>

          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !name.trim()}>
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
