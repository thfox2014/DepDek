import { useState } from "react";
import type { ProviderConfig, Settings } from "../api";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
}

// Editable row: name key + config fields.
interface Row {
  name: string;
  config: ProviderConfig;
}

const toRows = (s: Settings): Row[] =>
  Object.entries(s.providers).map(([name, config]) => ({ name, config }));

const newConfig = (): ProviderConfig => ({ kind: "openai", api_key: "", model: "" });

export default function SettingsPanel({ settings, onSave, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>(toRows(settings));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const patchConfig = (i: number, patch: Record<string, string | undefined>) =>
    setRows((prev) =>
      prev.map((r, j) => (j === i ? { ...r, config: { ...r.config, ...patch } as ProviderConfig } : r)),
    );

  const changeKind = (i: number, kind: ProviderConfig["kind"]) => {
    const base = rows[i].config;
    const common = { api_key: base.kind === "openai-compatible" ? base.api_key ?? "" : base.api_key, model: base.model };
    let config: ProviderConfig;
    if (kind === "openai") {
      config = { kind, ...common, base_url: "base_url" in base ? base.base_url : undefined };
    } else if (kind === "anthropic") {
      config = { kind, api_key: common.api_key ?? "", model: common.model };
    } else {
      config = { kind, api_key: common.api_key || undefined, model: common.model, base_url: "" };
    }
    update(i, { config });
  };

  const save = async () => {
    const providers: Record<string, ProviderConfig> = {};
    for (const r of rows) {
      const name = r.name.trim();
      if (!name) continue;
      providers[name] = r.config;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...settings, providers });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          设置 — Providers
          <span>
            <button className="link" onClick={() => setRows((p) => [...p, { name: "", config: newConfig() }])}>
              添加 provider
            </button>
            <button className="link" onClick={() => setRows((p) => [...p, { name: "Local Ollama", config: { kind: "openai-compatible", api_key: "", model: "qwen3:8b", base_url: "http://127.0.0.1:11434/v1" } }])}>
              添加本地 Ollama
            </button>
          </span>
        </div>
        <div className="provider-list">
          {rows.length === 0 && <p className="hint">尚未配置任何 provider。</p>}
          {rows.map((row, i) => (
            <div key={i} className="provider-card">
              <div className="provider-row">
                <input
                  placeholder="显示名"
                  value={row.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
                <select
                  value={row.config.kind}
                  onChange={(e) => changeKind(i, e.target.value as ProviderConfig["kind"])}
                >
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                  <option value="openai-compatible">openai-compatible</option>
                </select>
                <button
                  className="link"
                  onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
                >
                  删除
                </button>
              </div>
              <div className="provider-row">
                <input
                  type="password"
                  placeholder={row.config.kind === "openai-compatible" ? "api_key（可选）" : "api_key"}
                  value={row.config.api_key ?? ""}
                  onChange={(e) => patchConfig(i, { api_key: e.target.value })}
                />
                <input
                  placeholder="model"
                  value={row.config.model}
                  onChange={(e) => patchConfig(i, { model: e.target.value })}
                />
              </div>
              {row.config.kind !== "anthropic" && (
                <div className="provider-row">
                  <input
                    placeholder={
                      row.config.kind === "openai-compatible"
                        ? "base_url（必填，如 http://localhost:11434/v1）"
                        : "base_url（可选）"
                    }
                    value={"base_url" in row.config ? row.config.base_url ?? "" : ""}
                    onChange={(e) => patchConfig(i, { base_url: e.target.value || undefined })}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={saving} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
