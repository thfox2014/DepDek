import { useEffect, useRef, useState } from "react";
import type { ChatBlock, SessionInfo } from "../App";
import AgentTranscript from "./AgentTranscript";

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  chats: Record<string, ChatBlock[]>;
  running: Record<string, boolean>;
  onSelect: (id: string) => void;
  onSend: (id: string, text: string) => void;
  onAbort: (id: string) => void;
  onClose: (id: string) => void;
}

export default function ChatPanel({
  sessions,
  activeId,
  chats,
  running,
  onSelect,
  onSend,
  onAbort,
  onClose,
}: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const blocks = activeId ? chats[activeId] ?? [] : [];
  const isRunning = activeId ? Boolean(running[activeId]) : false;
  const activeLabel = sessions.find((session) => session.id === activeId)?.label ?? "Agent";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks.length, blocks[blocks.length - 1]]);

  const submit = () => {
    if (!activeId || !input.trim() || isRunning) return;
    onSend(activeId, input);
    setInput("");
  };

  if (sessions.length === 0) {
    return (
      <div className="chat-panel empty">
        <p className="hint">在左侧点击“新增会话”开始一个会话。</p>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="tabs">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`tab ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span>{s.label}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="messages" ref={scrollRef}>
        <AgentTranscript blocks={blocks} agentLabel={activeLabel} running={isRunning} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder={activeId ? `跟 ${activeLabel} 说…` : "先选一个会话"}
          disabled={!activeId}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {isRunning ? (
          <button onClick={() => activeId && onAbort(activeId)}>停下</button>
        ) : (
          <button className="primary" disabled={!activeId || !input.trim()} onClick={submit}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
