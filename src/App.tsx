import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import FolderPicker from "./components/FolderPicker";
import OfficeView from "./components/OfficeView";
import SideMenu from "./components/SideMenu";
import ChatPanel from "./components/ChatPanel";
import AuditViewer from "./components/AuditViewer";
import SettingsPanel from "./components/SettingsPanel";
import DepDekHome from "./components/DepDekHome";

export interface SessionInfo {
  id: string;
  label: string;
  providerName: string;
  engine?: api.AgentEngine;
}

// Chat history is modelled as an ordered list of blocks per session.
export type ChatBlock =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | {
      id: number;
      kind: "tool";
      toolCallId: string;
      name: string;
      args: unknown;
      ok?: boolean;
      preview?: string;
    }
  | { id: number; kind: "error"; message: string }
  | { id: number; kind: "status"; text: string };

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  blocks: ChatBlock[];
}

const CONVERSATION_HISTORY_STORAGE_KEY = "depdek.agent-conversation-history.v1";

function loadConversationHistory(): Record<string, ConversationRecord[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CONVERSATION_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ConversationRecord[]>;
    return Object.fromEntries(Object.entries(parsed).map(([agentId, records]) => [
      agentId,
      Array.isArray(records) ? records.filter((record) => record && typeof record.id === "string" && Array.isArray(record.blocks)).slice(-30) : [],
    ]));
  } catch {
    return {};
  }
}

// Omit does not distribute over unions, so distribute it manually.
type ChatBlockInput = ChatBlock extends infer B
  ? B extends { id: number }
    ? Omit<B, "id">
    : never
  : never;

export default function App() {
  const [booted, setBooted] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [settings, setSettings] = useState<api.Settings>({ providers: {} });
  const [showSettings, setShowSettings] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"home" | "office" | "workbench">("home");
  const [showDock, setShowDock] = useState(true);
  const [chats, setChats] = useState<Record<string, ChatBlock[]>>({});
  const [conversationHistory, setConversationHistory] = useState<Record<string, ConversationRecord[]>>(loadConversationHistory);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const blockId = useRef(1);

  const nextId = () => blockId.current++;

  useEffect(() => {
    try {
      window.localStorage.setItem(CONVERSATION_HISTORY_STORAGE_KEY, JSON.stringify(conversationHistory));
    } catch {
      // A full browser quota must not block the live Agent session.
    }
  }, [conversationHistory]);

  const pushBlock = (sid: string, block: ChatBlockInput) => {
    setChats((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []), { ...block, id: nextId() } as ChatBlock],
    }));
  };

  // ---- bootstrap: settings + restored vault root + saved agent sessions ------
  const bootstrapped = useRef(false);
  useEffect(() => {
    // StrictMode double-invokes effects in dev; restoring sessions must run once.
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        // Browser-only UX preview: Tauri commands are unavailable in Vite,
        // so provide a clearly local sample Home for visual/product QA.
        if (!("__TAURI_INTERNALS__" in window)) {
          setSettings({
            providers: {
              "Local Qwen": {
                kind: "openai-compatible",
                model: "qwen3:8b",
                base_url: "http://127.0.0.1:11434/v1",
              },
            },
          });
          setRoot("~/DepDek-Home · 浏览器 UX 预览");
          return;
        }
        const s = await api.settingsGet().catch(() => ({ providers: {} }) as api.Settings);
        setSettings(s);
        // Recreate saved agent sessions (same config, fresh conversation).
        const restored: SessionInfo[] = [];
        for (const a of s.agents ?? []) {
          const provider = s.providers[a.provider_name];
          if (!provider) continue;
          try {
            await api.agentCreateSession(a.id, provider, a.system_prompt, a.engine);
            restored.push({ id: a.id, label: a.label, providerName: a.provider_name, engine: a.engine });
          } catch {
            // Sidecar unavailable; skip this session.
          }
        }
        setSessions(restored);
        // The Rust side auto-restores settings.last_root on startup.
        const r = await api.vaultGetRoot().catch(() => null);
        setRoot(r);
      } finally {
        setBooted(true);
      }
    })();
  }, []);

  // ---- agent streaming events ----------------------------------------------
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const markHarnessEvent = (sid: string) => {
      setChats((prev) => {
        const blocks = prev[sid] ?? [];
        if (blocks.some((block) => block.kind === "status" && block.text.includes("DeepSeek Harness"))) return prev;
        return {
          ...prev,
          [sid]: [...blocks, { id: nextId(), kind: "status", text: "引擎已确认：DeepSeek Harness · dsh --profile headless" }],
        };
      });
    };
    api
      .onAgentEvent((ev) => {
        const sid = ev.session_id;
        switch (ev.type) {
          case "progress":
            pushBlock(sid, { kind: "status", text: String(ev.data.message ?? "正在处理…") });
            break;
          case "text_delta": {
            if (ev.data.engine === "deepseek-harness") markHarnessEvent(sid);
            const delta = String(ev.data.delta ?? "");
            setChats((prev) => {
              const blocks = prev[sid] ?? [];
              const last = blocks[blocks.length - 1];
              if (last && last.kind === "assistant") {
                return {
                  ...prev,
                  [sid]: [...blocks.slice(0, -1), { ...last, text: last.text + delta }],
                };
              }
              return {
                ...prev,
                [sid]: [...blocks, { id: nextId(), kind: "assistant", text: delta }],
              };
            });
            break;
          }
          case "tool_call_start":
            pushBlock(sid, {
              kind: "tool",
              toolCallId: String(ev.data.tool_call_id ?? ""),
              name: String(ev.data.name ?? ""),
              args: ev.data.args,
            });
            break;
          case "tool_call_end": {
            const toolCallId = String(ev.data.tool_call_id ?? "");
            setChats((prev) => ({
              ...prev,
              [sid]: (prev[sid] ?? []).map((b) =>
                b.kind === "tool" && b.toolCallId === toolCallId
                  ? {
                      ...b,
                      ok: Boolean(ev.data.ok),
                      preview: String(ev.data.result_preview ?? ""),
                    }
                  : b,
              ),
            }));
            break;
          }
          case "message_complete":
            if (ev.data.engine === "deepseek-harness") markHarnessEvent(sid);
            setRunning((r) => ({ ...r, [sid]: false }));
            break;
          case "error":
            setRunning((r) => ({ ...r, [sid]: false }));
            pushBlock(sid, { kind: "error", message: String(ev.data.message ?? "未知错误") });
            break;
        }
      })
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ---- actions ---------------------------------------------------------------
  const pickRoot = async () => {
    setRootError(null);
    try {
      const sel = await open({ directory: true });
      if (typeof sel !== "string") return;
      const normalized = await api.vaultSetRoot(sel);
      setRoot(normalized);
      // Persist last_root so the Rust side can restore it next launch.
      const current = await api.settingsGet().catch(() => ({ providers: {} }) as api.Settings);
      const next = { ...current, last_root: normalized };
      await api.settingsSet(next);
      setSettings(next);
    } catch (e) {
      setRootError(String(e));
    }
  };

  const createSession = async (label: string, providerName: string, requestedId?: string, openWorkbench = true, requestedEngine?: api.AgentEngine) => {
    const provider = settings.providers[providerName];
    if (!provider) throw new Error(`provider "${providerName}" 不存在`);
    const id = requestedId?.trim() || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = settings.agents?.find((agent) => agent.id === id);
    if (existing && sessions.some((session) => session.id === id)) {
      setActiveId(id);
      if (openWorkbench) setView("workbench");
      return;
    }
    const engine = requestedEngine ?? existing?.engine;
    await api.agentCreateSession(id, provider, existing?.system_prompt, engine);
    setSessions((prev) => prev.some((session) => session.id === id) ? prev : [...prev, { id, label: label || id, providerName, engine }]);
    setActiveId(id);
    if (openWorkbench) setView("workbench");
    // Persist the agent config so it is restored on next launch.
    const next: api.Settings = {
      ...settings,
      agents: existing
        ? (settings.agents ?? []).map((agent) => agent.id === id ? { ...agent, label: label || agent.label, provider_name: providerName, ...(engine ? { engine } : {}) } : agent)
        : [...(settings.agents ?? []), { id, label: label || id, provider_name: providerName, ...(engine ? { engine } : {}), ...(id === "tanvis" ? { config_dir: "agents/tanvis" } : {}) }],
    };
    await api.settingsSet(next).catch(() => {});
    setSettings(next);
  };

  const enterWorkbench = (sid: string) => {
    setActiveId(sid);
    setView("workbench");
  };

  const startNewConversation = async (sid: string) => {
    const session = sessions.find((item) => item.id === sid);
    const agent = settings.agents?.find((item) => item.id === sid);
    const provider = agent ? settings.providers[agent.provider_name] : session ? settings.providers[session.providerName] : undefined;
    if (!session || !provider) throw new Error("当前 Agent 配置不完整，无法新建会话");
    setRunning((current) => ({ ...current, [sid]: false }));
    setChats((current) => ({ ...current, [sid]: [] }));
    try { await api.agentAbort(sid); } catch { /* 当前没有运行中的请求也可以继续新建。 */ }
    try { await api.agentClose(sid); } catch { /* sidecar 重启后可能已经没有旧会话。 */ }
    await api.agentCreateSession(sid, provider, agent?.system_prompt, agent?.engine ?? session.engine);
  };

  const closeSession = async (sid: string) => {
    try {
      await api.agentClose(sid);
    } catch {
      // Session may already be gone on the sidecar; remove it locally anyway.
    }
    setSessions((prev) => prev.filter((s) => s.id !== sid));
    setChats((prev) => {
      const next = { ...prev };
      delete next[sid];
      return next;
    });
    setActiveId((prev) => (prev === sid ? null : prev));
    // Drop the persisted config as well, or it would be restored next launch.
    const next: api.Settings = {
      ...settings,
      agents: (settings.agents ?? []).filter((a) => a.id !== sid),
    };
    await api.settingsSet(next).catch(() => {});
    setSettings(next);
  };

  const send = async (sid: string, text: string) => {
    if (!text.trim()) return;
    pushBlock(sid, { kind: "user", text });
    setRunning((r) => ({ ...r, [sid]: true }));
    const compressMatch = text.trim().match(/^\/compress(?:\s+(.+))?$/i);
    if (compressMatch) {
      const path = (compressMatch[1] ?? ".").trim().replace(/^['"]|['"]$/g, "") || ".";
      const toolCallId = `builtin-compress-${Date.now()}`;
      pushBlock(sid, { kind: "tool", toolCallId, name: "compress", args: { path } });
      try {
        const result = await api.vaultCompress(path);
        setChats((prev) => ({
          ...prev,
          [sid]: (prev[sid] ?? []).map((block) =>
            block.kind === "tool" && block.toolCallId === toolCallId
              ? { ...block, ok: true, preview: `已生成 ${result.archive}（${result.files} 个文件，${result.bytes} 字节）` }
              : block,
          ),
        }));
      } catch (e) {
        setChats((prev) => ({
          ...prev,
          [sid]: (prev[sid] ?? []).map((block) =>
            block.kind === "tool" && block.toolCallId === toolCallId
              ? { ...block, ok: false, preview: String(e) }
              : block,
          ),
        }));
      } finally {
        setRunning((r) => ({ ...r, [sid]: false }));
      }
      return;
    }
    try {
      await api.agentSend(sid, text);
    } catch (e) {
      setRunning((r) => ({ ...r, [sid]: false }));
      pushBlock(sid, { kind: "error", message: String(e) });
    }
  };

  const abort = async (sid: string) => {
    try {
      await api.agentAbort(sid);
    } catch (e) {
      pushBlock(sid, { kind: "error", message: String(e) });
    }
    setRunning((r) => ({ ...r, [sid]: false }));
  };

  const saveSettings = async (next: api.Settings) => {
    await api.settingsSet(next);
    setSettings(next);
    // Apply updated Agent Team prompt/provider settings to already-open
    // sessions immediately. The one-shot Tanvis analysis reads vault files on
    // demand; persistent chats need a fresh session to receive new prompts.
    for (const session of sessions) {
      const agent = next.agents?.find((item) => item.id === session.id);
      const provider = agent ? next.providers[agent.provider_name] : undefined;
      if (!agent || !provider) continue;
      const previous = settings.agents?.find((item) => item.id === session.id);
      if (previous?.provider_name === agent.provider_name && previous?.system_prompt === agent.system_prompt && previous?.engine === agent.engine) continue;
      try {
        await api.agentClose(session.id);
        await api.agentCreateSession(session.id, provider, agent.system_prompt, agent.engine);
      } catch {
        // The session can be recreated on the next launch if the sidecar is
        // temporarily unavailable; settings remain saved in the meantime.
      }
    }
  };

  // ---- render ---------------------------------------------------------------
  if (!booted) {
    return <div className="boot">加载中…</div>;
  }
  if (!root) {
    return (
      <div className="folder-picker-page">
        <FolderPicker onPick={pickRoot} error={rootError} />
      </div>
    );
  }
  return (
    <div className="app">
      {view === "home" ? (
        <DepDekHome
          root={root}
          providerCount={Object.keys(settings.providers).length}
          sessionCount={sessions.length}
          providers={settings.providers}
          settings={settings}
          conversationHistory={conversationHistory}
          sessions={sessions}
          activeAgentId={activeId}
          chats={chats}
          running={running}
          onSelectAgent={setActiveId}
          onSendAgent={send}
          onAbortAgent={abort}
          onNewConversation={startNewConversation}
          onConversationHistoryChange={setConversationHistory}
          onEnterAgent={enterWorkbench}
          onCloseAgent={closeSession}
          onCreateAgent={createSession}
          onSaveAgentSettings={saveSettings}
          onOpenSettings={() => setShowSettings(true)}
          onPickRoot={pickRoot}
        />
      ) : (
        <>
          <header className="topbar">
            <button className="topbar__back" onClick={() => setView(view === "workbench" ? "office" : "home")}>
              {view === "workbench" ? "← 返回 Agent Team" : "← 返回 DepDek"}
            </button>
            <span className="topbar__brand">DepDek · Agent Team</span>
            <span className="topbar__path" title={root}>{root}</span>
            {rootError && <span className="error-text">{rootError}</span>}
            <div className="topbar__actions">
              {view === "workbench" && (
                <button
                  className={`topbar__dock-toggle${showDock ? " topbar__dock-toggle--on" : ""}`}
                  onClick={() => setShowDock((v) => !v)}
                  title={showDock ? "隐藏扩展坞" : "显示扩展坞"}
                >
                  扩展坞
                </button>
              )}
              <button onClick={pickRoot}>更换 Home</button>
              <button onClick={() => setShowSettings(true)}>设置</button>
            </div>
          </header>
          {view === "office" ? (
        <OfficeView
          sessions={sessions}
          running={running}
          chats={chats}
          providers={settings.providers}
          settings={settings}
          conversationHistory={conversationHistory}
          onEnter={enterWorkbench}
          onCreate={createSession}
          onSaveSettings={saveSettings}
          onOpenSettings={() => setShowSettings(true)}
          onSend={send}
          onAbort={abort}
          onNewConversation={startNewConversation}
          onConversationHistoryChange={setConversationHistory}
        />
          ) : (
        <div className={`main${showDock ? "" : " main--dock-hidden"}`}>
          <aside className="left">
            <SideMenu
              sessions={sessions}
              activeId={activeId}
              providers={settings.providers}
              onSelect={setActiveId}
              onCreate={createSession}
              onClose={closeSession}
              onOpenSettings={() => setShowSettings(true)}
            />
          </aside>
          <section className="center">
            <ChatPanel
              sessions={sessions}
              activeId={activeId}
              chats={chats}
              running={running}
              onSelect={setActiveId}
              onSend={send}
              onAbort={abort}
              onClose={closeSession}
            />
          </section>
          {showDock && (
            <aside className="dock">
              <div className="dock__header">
                <span className="dock__title">扩展坞</span>
                <button
                  className="dock__close"
                  onClick={() => setShowDock(false)}
                  title="隐藏扩展坞"
                >
                  ×
                </button>
              </div>
              <div className="dock__body">
                <AuditViewer />
              </div>
            </aside>
          )}
        </div>
          )}
        </>
      )}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
