import type { ProviderConfig } from "../api";
import type { ChatBlock, SessionInfo } from "../App";
import SessionList from "./SessionList";

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  providers: Record<string, ProviderConfig>;
  chats: Record<string, ChatBlock[]>;
  /** 进入某个会话的聊天工作台。 */
  onSelect: (id: string) => void;
  /** 新增会话（创建后停留在本视图，仅更新当前会话）。 */
  onCreate: (label: string, providerName: string) => Promise<void>;
  onClose: (id: string) => void;
  onOpenSettings: () => void;
}

export default function SessionsView({
  sessions,
  activeId,
  providers,
  chats,
  onSelect,
  onCreate,
  onClose,
  onOpenSettings,
}: Props) {
  const active = sessions.find((s) => s.id === activeId) ?? null;
  const previewBlocks = activeId
    ? (chats[activeId] ?? []).filter(
        (b) => b.kind === "user" || b.kind === "assistant" || b.kind === "error",
      )
    : [];
  const lastBlocks = previewBlocks.slice(-3).reverse();

  return (
    <div className="dd-sessions">
      <div className="dd-view-head">
        <div><div className="dd-eyebrow">SESSIONS / AGENT 连接</div><h1>会话</h1></div>
        <span>管理 agent 会话：新建、切换，并查看当前与 agent 连接的会话。</span>
      </div>
      <div className="dd-sessions-body">
        <div className="dd-sessions-side">
          <SessionList
            sessions={sessions}
            activeId={activeId}
            providers={providers}
            onSelect={onSelect}
            onCreate={onCreate}
            onClose={onClose}
            onOpenSettings={onOpenSettings}
          />
        </div>
        <section className="dd-sessions-preview">
          {active ? (
            <>
              <div className="dd-sessions-preview__head">
                <div>
                  <b>{active.label}</b>
                  <span className="dd-sessions-preview__badge">已连接 agent</span>
                </div>
                <button className="dd-sessions-preview__enter" onClick={() => onSelect(active.id)}>
                  进入聊天
                </button>
              </div>
              <p className="dd-sessions-preview__meta">
                {active.providerName}
                {providers[active.providerName] ? ` · ${providers[active.providerName].model}` : ""}
                {active.engine === "deepseek-harness" ? " · DeepSeek Harness" : ""}
              </p>
              {lastBlocks.length > 0 ? (
                <div className="dd-sessions-preview__history">
                  {lastBlocks.map((b) => (
                    <div key={b.id} className={`dd-sessions-preview__msg dd-sessions-preview__msg--${b.kind}`}>
                      <span>{b.kind === "user" ? "你" : b.kind === "error" ? "错误" : "Agent"}</span>
                      <p>{(b.kind === "assistant" || b.kind === "user") ? b.text : b.message}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="dd-sessions-preview__empty">
                  该会话还没有对话，点击「进入聊天」开始。
                </div>
              )}
            </>
          ) : (
            <div className="dd-sessions-preview__empty dd-sessions-preview__empty--big">
              尚未连接 agent。<br />点击左侧「新增会话」创建，或在列表中点击已有会话。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
