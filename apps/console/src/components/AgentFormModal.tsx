import { useState } from "react";
import { X } from "lucide-react";
import { agents } from "../api";
import type { AgentRecord, ModelConfig, AgentTool, McpServer, Effort } from "../api/types";

interface Props {
  agent: AgentRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "max"];

export default function AgentFormModal({ agent, onClose, onSaved }: Props) {
  const isNew = !agent;
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [modelId, setModelId] = useState(agent?.model.id ?? "glm-5.3-flash");
  const [modelEffort, setModelEffort] = useState<Effort>(agent?.model.effort ?? "low");
  const [system, setSystem] = useState(agent?.system ?? "");
  const [toolsJson, setToolsJson] = useState(JSON.stringify(agent?.tools ?? [], null, 2));
  const [mcpJson, setMcpJson] = useState(JSON.stringify(agent?.mcp_servers ?? [], null, 2));
  const [skillsText, setSkillsText] = useState((agent?.skills ?? []).join("\n"));
  const [metadataJson, setMetadataJson] = useState(JSON.stringify(agent?.metadata ?? {}, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setErr(null);
    setSaving(true);
    try {
      let tools: AgentTool[] = [];
      if (toolsJson.trim()) {
        try {
          tools = JSON.parse(toolsJson);
        } catch (e: any) {
          throw new MasErrorLike("tools 不是合法 JSON: " + e.message);
        }
      }
      let mcp: McpServer[] = [];
      if (mcpJson.trim()) {
        try {
          mcp = JSON.parse(mcpJson);
        } catch (e: any) {
          throw new MasErrorLike("mcp_servers 不是合法 JSON: " + e.message);
        }
      }
      let metadata: Record<string, string> = {};
      if (metadataJson.trim()) {
        try {
          metadata = JSON.parse(metadataJson);
        } catch (e: any) {
          throw new MasErrorLike("metadata 不是合法 JSON: " + e.message);
        }
      }
      const skills = skillsText.split(/\s+/).filter(Boolean);

      const model: ModelConfig = { id: modelId, effort: modelEffort, speed: "standard" };
      const body: any = {
        name,
        description: description || null,
        model,
        system: system || null,
        tools,
        mcp_servers: mcp,
        skills,
        metadata,
      };
      if (isNew) {
        await agents.create(body);
      } else {
        await agents.update(agent!.id, { ...body, version: agent!.version });
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
      <div className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{isNew ? "新建 Agent" : `编辑 Agent: ${agent!.name}`}</h2>
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
              <label className="label">模型 ID</label>
              <input className="input" value={modelId} onChange={(e) => setModelId(e.target.value)} />
            </div>
            <div>
              <label className="label">Effort</label>
              <select className="input" value={modelEffort} onChange={(e) => setModelEffort(e.target.value as Effort)}>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">System Prompt</label>
            <textarea
              className="input min-h-24 font-mono text-xs"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Tools (JSON 数组)</label>
            <textarea
              className="input min-h-32 font-mono text-xs"
              value={toolsJson}
              onChange={(e) => setToolsJson(e.target.value)}
              placeholder='[{"type": "agent_toolset_20260601", "default_config": {"enabled": true, "permission_policy": {"type": "always_ask"}}}]'
            />
            <div className="text-xs text-mas-500 mt-1">
              类型: agent_toolset_20260401/20260601、mcp_toolset、custom
            </div>
          </div>

          <div>
            <label className="label">MCP Servers (JSON 数组)</label>
            <textarea
              className="input min-h-20 font-mono text-xs"
              value={mcpJson}
              onChange={(e) => setMcpJson(e.target.value)}
              placeholder='[{"type": "url", "name": "myserver", "url": "https://example.com/mcp"}]'
            />
          </div>

          <div>
            <label className="label">Skills (一行一个 ID)</label>
            <textarea
              className="input min-h-16 font-mono text-xs"
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
              placeholder="skl_..."
            />
          </div>

          <div>
            <label className="label">Metadata (JSON 对象，string 键值对)</label>
            <textarea
              className="input min-h-16 font-mono text-xs"
              value={metadataJson}
              onChange={(e) => setMetadataJson(e.target.value)}
            />
          </div>

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

class MasErrorLike extends Error {}
