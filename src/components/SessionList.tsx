import { useState } from "react";
import type { ProviderConfig } from "../api";
import type { SessionInfo } from "../App";
import { IconPlus } from "./icons";

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
  // 当前与 agent 连接的会话（工作台当前选中的会话）。
  const active = sessions.find((s) => s.id === activeId) ?? null;

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
      <div className={`session-current ${active ? "session-current--on" : ""}`}>
        <div className="session-current__head">
          <span className="session-current__title">当前会话</span>
          {active ? (
            <span className="session-current__badge">已连接</span>
          ) : (
            <span className="session-current__badge session-current__badge--off">未连接</span>
          )}
        </div>
        {active ? (
          <>
            <div className="session-current__label">{active.label}</div>
            <div className="session-current__meta">
              {active.providerName}
              {providers[active.providerName] ? ` · ${providers[active.providerName].model}` : ""}
              {active.engine === "deepseek-harness" ? " · Harness" : ""}
            </div>
          </>
        ) : (
          <div className="session-current__empty">尚未连接 agent，请新增会话或点击下方会话。</div>
        )}
      </div>

      <div className="session-toolbar">
        <button className="link session-toolbar__new" onClick={() => setCreating((v) => !v)}>
          <IconPlus />
          {creating ? "取消" : "新增会话"}
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
