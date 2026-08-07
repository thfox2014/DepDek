import { useEffect, useRef, useState } from "react";
import type { ChatBlock, SessionInfo } from "../App";

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

const summarize = (v: unknown, max = 120) => {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
};

function ToolBlock({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const status =
    block.ok === undefined ? "执行中…" : block.ok ? "成功" : "失败";
  return (
    <details className={`tool-block ${block.ok === false ? "failed" : ""}`}>
      <summary>
        <span className="tool-name">{block.name}</span>
        <span className="tool-args">{summarize(block.args)}</span>
        <span className="tool-status">{status}</span>
      </summary>
      {block.preview !== undefined && <pre>{block.preview}</pre>}
    </details>
  );
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
        <p className="hint">在左侧点击“新建 agent”开始一个会话。</p>
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
        {blocks.map((b) => {
          switch (b.kind) {
            case "user":
              return (
                <div key={b.id} className="msg user">
                  {b.text}
                </div>
              );
            case "assistant":
              return (
                <div key={b.id} className="msg assistant">
                  {b.text}
                </div>
              );
            case "tool":
              return <ToolBlock key={b.id} block={b} />;
            case "error":
              return (
                <div key={b.id} className="msg error-text">
                  {b.message}
                </div>
              );
            case "status":
              return (
                <div key={b.id} className="msg status">
                  {b.text}
                </div>
              );
          }
        })}
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder={activeId ? "输入消息，Enter 发送，Shift+Enter 换行" : "请选择一个会话标签"}
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
          <button onClick={() => activeId && onAbort(activeId)}>中止</button>
        ) : (
          <button className="primary" disabled={!activeId || !input.trim()} onClick={submit}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
