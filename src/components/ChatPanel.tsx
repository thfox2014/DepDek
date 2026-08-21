import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatBlock, SessionInfo } from "../App";
import MarkdownText from "./MarkdownText";
import ToolProcessPanel from "./ToolProcessPanel";

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
        {(() => {
          const rendered: ReactNode[] = [];
          let tools: Extract<ChatBlock, { kind: "tool" }>[] = [];
          const flushTools = () => {
            if (tools.length) rendered.push(<ToolProcessPanel key={`tools-${tools[0].id}`} blocks={tools} />);
            tools = [];
          };
          blocks.forEach((b) => {
            if (b.kind === "tool") {
              tools.push(b);
              return;
            }
            flushTools();
            rendered.push((() => {
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
                  <MarkdownText markdown={b.text} />
                </div>
              );
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
            })());
          });
          flushTools();
          return rendered;
        })()}
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
