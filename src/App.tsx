import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import FolderPicker from "./components/FolderPicker";
import OfficeView from "./components/OfficeView";
import SideMenu from "./components/SideMenu";
import ChatPanel from "./components/ChatPanel";
import AuditViewer from "./components/AuditViewer";
import SettingsPanel from "./components/SettingsPanel";

export interface SessionInfo {
  id: string;
  label: string;
  providerName: string;
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
  const [view, setView] = useState<"office" | "workbench">("office");
  const [showDock, setShowDock] = useState(true);
  const [chats, setChats] = useState<Record<string, ChatBlock[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const blockId = useRef(1);

  const nextId = () => blockId.current++;

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
        const s = await api.settingsGet().catch(() => ({ providers: {} }) as api.Settings);
        setSettings(s);
        // Recreate saved agent sessions (same config, fresh conversation).
        const restored: SessionInfo[] = [];
        for (const a of s.agents ?? []) {
          const provider = s.providers[a.provider_name];
          if (!provider) continue;
          try {
            await api.agentCreateSession(a.id, provider, a.system_prompt);
            restored.push({ id: a.id, label: a.label, providerName: a.provider_name });
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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    api
      .onAgentEvent((ev) => {
        const sid = ev.session_id;
        switch (ev.type) {
          case "text_delta": {
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
            setRunning((r) => ({ ...r, [sid]: false }));
            pushBlock(sid, { kind: "status", text: `完成（${String(ev.data.stop_reason ?? "")}）` });
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

  const createSession = async (label: string, providerName: string) => {
    const provider = settings.providers[providerName];
    if (!provider) throw new Error(`provider "${providerName}" 不存在`);
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await api.agentCreateSession(id, provider);
    setSessions((prev) => [...prev, { id, label: label || id, providerName }]);
    setActiveId(id);
    setView("workbench");
    // Persist the agent config so it is restored on next launch.
    const next: api.Settings = {
      ...settings,
      agents: [...(settings.agents ?? []), { id, label: label || id, provider_name: providerName }],
    };
    await api.settingsSet(next).catch(() => {});
    setSettings(next);
  };

  const enterWorkbench = (sid: string) => {
    setActiveId(sid);
    setView("workbench");
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
      <header className="topbar">
        {view === "workbench" && (
          <button className="topbar__back" onClick={() => setView("office")}>
            ← 返回办公室
          </button>
        )}
        <span className="topbar__brand">Agent Workbench</span>
        <span className="topbar__path" title={root}>
          {root}
        </span>
        {rootError && <span className="error-text">{rootError}</span>}
        <div className="topbar__actions">
          {view === "workbench" && (
            <button
              className={`topbar__dock-toggle${showDock ? " topbar__dock-toggle--on" : ""}`}
              onClick={() => setShowDock((v) => !v)}
              title={showDock ? "隐藏扩展坞" : "显示扩展坞"}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
                <rect x="11" y="4" width="2.5" height="8" rx="0.8" fill="currentColor" opacity={showDock ? 1 : 0.25} />
              </svg>
              扩展坞
            </button>
          )}
          <button onClick={pickRoot}>更换文件夹</button>
          <button onClick={() => setShowSettings(true)}>设置</button>
        </div>
      </header>
      {view === "office" ? (
        <OfficeView
          sessions={sessions}
          running={running}
          chats={chats}
          providers={settings.providers}
          onEnter={enterWorkbench}
          onCreate={createSession}
          onOpenSettings={() => setShowSettings(true)}
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
