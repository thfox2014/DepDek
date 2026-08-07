import { useState } from "react";
import type { ProviderConfig } from "../api";
import type { SessionInfo } from "../App";

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  providers: Record<string, ProviderConfig>;
  onSelect: (id: string) => void;
  onCreate: (label: string, providerName: string) => Promise<void>;
  onClose: (id: string) => void;
  onOpenSettings: () => void;
}

export default function SessionList({
  sessions,
  activeId,
  providers,
  onSelect,
  onCreate,
  onClose,
  onOpenSettings,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [providerName, setProviderName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const providerNames = Object.keys(providers);

  const submit = async () => {
    const name = providerName || providerNames[0];
    if (!name) {
      setError("请先在设置中配置 provider");
      return;
    }
    setError(null);
    try {
      await onCreate(label.trim(), name);
      setCreating(false);
      setLabel("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="session-list">
      <div className="panel-title">
        会话
        <button className="link" onClick={() => setCreating((v) => !v)}>
          新建 agent
        </button>
      </div>
      {creating && (
        <div className="session-create">
          <input
            placeholder="会话名称"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {providerNames.length > 0 ? (
            <select value={providerName || providerNames[0]} onChange={(e) => setProviderName(e.target.value)}>
              {providerNames.map((n) => (
                <option key={n} value={n}>
                  {n}（{providers[n].model}）
                </option>
              ))}
            </select>
          ) : (
            <p className="hint">
              尚无 provider，请先<button className="link" onClick={onOpenSettings}>配置</button>
            </p>
          )}
          <button className="primary" onClick={submit}>
            创建
          </button>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
      <div className="session-items">
        {sessions.length === 0 && <p className="hint">暂无会话</p>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-label">{s.label}</span>
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
            >
              关闭
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
