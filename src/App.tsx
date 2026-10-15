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
import DepDekAiOsShell from "./components/DepDekAiOsShell";
import MediaViewer from "./components/MediaViewer";

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

export interface AgentMetrics {
  completedRuns: number;
  reportedTokens: number;
  tokenUsageKnown: boolean;
}

const PREVIEW_TEAM_TASKS: api.TeamTask[] = [
  {
    id: "tsk_previewrun01",
    kind: "delegate",
    status: "running",
    from_session_id: "tanvis",
    from_label: "Tanvis",
    to_session_id: "doc-manager",
    to_label: "文档管家",
    instruction: "把最近的会议纪要整理成三段摘要，并标出还没闭环的承诺。",
    depth: 1,
    chain: ["tanvis", "doc-manager"],
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-14T10:01:00.000Z",
  },
  {
    id: "tsk_previewdone1",
    kind: "message",
    status: "done",
    from_session_id: "doc-manager",
    from_label: "文档管家",
    to_session_id: "photo-manager",
    to_label: "照片管家",
    instruction: "上周旅行照片大概有多少张？不用打开原图。",
    depth: 1,
    chain: ["doc-manager", "photo-manager"],
    created_at: "2026-10-14T09:40:00.000Z",
    updated_at: "2026-10-14T09:42:00.000Z",
    result_preview: "按文件名匹配到 4 张，都在 photos/trip 下面。",
  },
];

function upsertTeamTask(current: api.TeamTask[], task: api.TeamTask): api.TeamTask[] {
  const index = current.findIndex((item) => item.id === task.id);
  const next = index >= 0 ? current.map((item) => item.id === task.id ? task : item) : [task, ...current];
  return next.slice(0, 50);
}

const CONVERSATION_HISTORY_STORAGE_KEY = "depdek.agent-conversation-history.v1";
const AGENT_METRICS_STORAGE_KEY = "depdek.agent-metrics.v1";
const agentOsMode = import.meta.env.VITE_DEPDEK_OS === "1";

const INITIAL_PROVIDER_NAME = "DeepSeek";
const ALL_DEFAULT_SKILLS: api.AgentSkill[] = ["documents", "photos", "music", "videos", "mail", "memory"];
const INITIAL_DEEPSEEK_PROVIDER: api.ProviderConfig = {
  kind: "openai-compatible",
  model: "deepseek-flash",
  base_url: "https://api.deepseek.com",
};

const INITIAL_AGENTS: api.SavedAgent[] = [
  { id: "tanvis", label: "Tanvis", provider_name: INITIAL_PROVIDER_NAME, config_dir: "agents/tanvis", enabled_skills: ["documents", "photos", "music", "videos", "mail", "memory"] },
  { id: "doc-manager", label: "文档管家", provider_name: INITIAL_PROVIDER_NAME, config_dir: "agents/doc-manager", enabled_skills: ["documents", "memory"] },
  { id: "photo-manager", label: "照片管家", provider_name: INITIAL_PROVIDER_NAME, config_dir: "agents/photo-manager", enabled_skills: ["photos", "memory"] },
  { id: "music-player", label: "音乐助手", provider_name: INITIAL_PROVIDER_NAME, config_dir: "agents/music-player", enabled_skills: ["music", "videos", "memory"] },
  { id: "video-player", label: "视频助手", provider_name: INITIAL_PROVIDER_NAME, config_dir: "agents/video-player", enabled_skills: ["videos", "music", "memory"] },
];

function loadAgentMetrics(): Record<string, AgentMetrics> {
  try {
    const raw = window.localStorage.getItem(AGENT_METRICS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, AgentMetrics> : {};
    return Object.fromEntries(Object.entries(parsed).map(([id, item]) => [id, {
      completedRuns: Math.max(0, Number(item.completedRuns) || 0),
      reportedTokens: Math.max(0, Number(item.reportedTokens) || 0),
      tokenUsageKnown: Boolean(item.tokenUsageKnown),
    }]));
  } catch { return {}; }
}

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
  // In AI-OS mode the voice shell is the entry point; DepDekHome (the desktop
  // main page) is one button away. On macOS/Windows the shell is not used.
  const [osView, setOsView] = useState<"shell" | "home">("shell");
  const [showDock, setShowDock] = useState(true);
  const [chats, setChats] = useState<Record<string, ChatBlock[]>>({});
  const [conversationHistory, setConversationHistory] = useState<Record<string, ConversationRecord[]>>(loadConversationHistory);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [teamTasks, setTeamTasks] = useState<api.TeamTask[]>([]);
  const [agentMetrics, setAgentMetrics] = useState<Record<string, AgentMetrics>>(loadAgentMetrics);
  const [mediaFile, setMediaFile] = useState<{ path: string; mime: string; dataUrl: string } | null>(null);
  const [mediaLoading, setMediaLoading] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const blockId = useRef(1);

  // Per-agent snapshots already written to the vault; identical snapshots skip
  // the debounced writer. Conversation history persistence (contract 6.2): the
  // authoritative copy is `agent/<id>/conversations.json` in the vault.
  const lastPersistedRef = useRef<Record<string, string>>({});
  const persistTimer = useRef<number | null>(null);

  const nextId = () => blockId.current++;

  // Crash cache (immediate, cheap) + debounced vault write (800ms). localStorage
  // is NOT the source of truth anymore — it only survives a hard crash until the
  // next vault write happens.
  useEffect(() => {
    try {
      window.localStorage.setItem(CONVERSATION_HISTORY_STORAGE_KEY, JSON.stringify(conversationHistory));
    } catch {
      // A full browser quota must not block the live Agent session.
    }
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      const entries = Object.entries(conversationHistory).filter(([, records]) => records.length > 0);
      if (entries.length === 0) return;
      for (const [agentId, records] of entries) {
        let serialized: string;
        try {
          serialized = JSON.stringify(records);
        } catch {
          continue;
        }
        if (lastPersistedRef.current[agentId] === serialized) continue;
        lastPersistedRef.current[agentId] = serialized;
        void api.conversationWrite(agentId, serialized).catch(() => {
          // Vault/sidecar temporarily unavailable: the crash cache still holds
          // this snapshot and the next conversation change retries the write.
        });
      }
    }, 800);
    return () => {
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
    };
  }, [conversationHistory]);

  // Restore history from the vault on boot; localStorage acts only as a crash
  // cache fallback (and is synced back up to the vault by the debounced writer).
  const restoreConversationHistory = async (agentIds: string[]) => {
    const local = loadConversationHistory();
    const merged: Record<string, ConversationRecord[]> = {};
    const fromVault = new Set<string>();
    for (const agentId of agentIds) {
      let records: ConversationRecord[] | null = null;
      try {
        const content = await api.conversationRead(agentId);
        if (content) {
          const parsed = JSON.parse(content) as unknown;
          if (Array.isArray(parsed)) {
            records = parsed
              .filter((r) => r && typeof r.id === "string" && Array.isArray(r.blocks))
              .slice(-30);
          }
        }
      } catch {
        // Vault unavailable: fall back to the crash cache below.
      }
      if (records && records.length) {
        merged[agentId] = records;
        fromVault.add(agentId);
      } else if (local[agentId]?.length) {
        merged[agentId] = local[agentId];
      }
    }
    // Sessions that only exist in the crash cache (agent removed from settings).
    for (const [agentId, records] of Object.entries(local)) {
      if (!merged[agentId] && records.length) merged[agentId] = records;
    }
    setConversationHistory((prev) => (Object.keys(merged).length ? { ...prev, ...merged } : prev));
    // Vault-loaded snapshots are already persisted; crash-cache fallbacks stay
    // unseeded so the debounced writer syncs them up to the vault.
    for (const [agentId, records] of Object.entries(merged)) {
      if (fromVault.has(agentId)) {
        lastPersistedRef.current[agentId] = JSON.stringify(records);
      } else {
        delete lastPersistedRef.current[agentId];
      }
    }
  };

  useEffect(() => {
    try { window.localStorage.setItem(AGENT_METRICS_STORAGE_KEY, JSON.stringify(agentMetrics)); }
    catch { /* Metrics are helpful, but must never block the live session. */ }
  }, [agentMetrics]);

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
        // Browser-only UX preview: Tauri commands are unavailable in Vite, so
        // settings come from the standalone agent service (they live in the
        // local data folder). When that service is not running, fall back to
        // the embedded sample Home for visual/product QA.
        if (!("__TAURI_INTERNALS__" in window)) {
          const fromService = await api.settingsGet().catch(() => null);
          const served = Boolean(
            fromService &&
              (Object.keys(fromService.providers ?? {}).length > 0 || (fromService.agents ?? []).length > 0),
          );
          const preview: api.Settings =
            served && fromService
              ? fromService
              : { providers: { [INITIAL_PROVIDER_NAME]: INITIAL_DEEPSEEK_PROVIDER }, agents: INITIAL_AGENTS };
          setSettings(preview);
          setRoot(preview.last_root || "~/DepDek-Home · 浏览器 UX 预览");
          if (!served) setTeamTasks(PREVIEW_TEAM_TASKS);
          await restoreConversationHistory((preview.agents ?? []).map((a) => a.id));
          return;
        }
        const loaded = await api.settingsGet().catch(() => ({ providers: {} }) as api.Settings);
        const existingDeepSeekName = (agentOsMode ? Object.keys(loaded.providers)[0] : undefined) ?? Object.entries(loaded.providers).find(([name, config]) =>
          name.toLocaleLowerCase().includes("deepseek") || (config.kind === "openai-compatible" && config.base_url.toLocaleLowerCase().includes("deepseek")),
        )?.[0];
        const providerName = existingDeepSeekName ?? INITIAL_PROVIDER_NAME;
        const needsProvider = !existingDeepSeekName;
        const hasLegacyAgents = Boolean(loaded.agents?.length && loaded.agents.some((agent) => !agent.enabled_skills));
        const nextSettings: api.Settings = {
          ...loaded,
          providers: needsProvider ? { ...loaded.providers, [INITIAL_PROVIDER_NAME]: INITIAL_DEEPSEEK_PROVIDER } : loaded.providers,
          agents: loaded.agents?.length ? loaded.agents.map((agent) => ({ ...agent, enabled_skills: agent.enabled_skills ?? ALL_DEFAULT_SKILLS })) : INITIAL_AGENTS.map((agent) => ({ ...agent, provider_name: providerName })),
        };
        if (needsProvider || !loaded.agents?.length || hasLegacyAgents) await api.settingsSet(nextSettings).catch(() => {});
        setSettings(nextSettings);
        // Recreate saved agent sessions (same config, fresh conversation).
        const restored: SessionInfo[] = [];
        for (const a of nextSettings.agents ?? []) {
          const provider = nextSettings.providers[a.provider_name];
          if (!provider) continue;
          try {
            await api.agentCreateSession(a.id, provider, a.system_prompt, a.engine, a.enabled_skills, a.label, a.config_dir);
            restored.push({ id: a.id, label: a.label, providerName: a.provider_name, engine: a.engine });
          } catch {
            // Sidecar unavailable; skip this session.
          }
        }
        setSessions(restored);
        // The Rust side auto-restores settings.last_root on startup.
        let r = await api.vaultGetRoot().catch(() => null);
        if (agentOsMode && !r) r = nextSettings.last_root ? await api.vaultSetRoot(nextSettings.last_root) : await api.vaultInitHome();
        setRoot(r);
        // Restore conversation history from the vault (localStorage is only a
        // crash-cache fallback and gets synced back up by the debounced writer).
        await restoreConversationHistory((nextSettings.agents ?? []).map((a) => a.id));
      } catch (error) {
        setRootError(String(error));
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
            if (ev.data.phase === "team_task" || ev.data.phase === "team_result") {
              setRunning((current) => ({ ...current, [sid]: true }));
            }
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
            if (String(ev.data.name ?? "") === "open_media") {
              const path = String((ev.data.args as { path?: unknown } | undefined)?.path ?? "");
              if (path) {
                setMediaError(null);
                setMediaLoading(path);
                void api.vaultReadBinary(path).then((file) => {
                  setMediaFile({ path, mime: file.mime, dataUrl: "data:" + file.mime + ";base64," + file.data_base64 });
                  setMediaError(null);
                }).catch((error) => setMediaError(String(error))).finally(() => setMediaLoading(null));
              }
            }
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
            setAgentMetrics((current) => {
              const previous = current[sid] ?? { completedRuns: 0, reportedTokens: 0, tokenUsageKnown: false };
              const usage = ev.data.usage as { total?: unknown } | undefined;
              const total = Number(usage?.total);
              const hasUsage = Number.isFinite(total) && total >= 0;
              const completed = ev.data.stop_reason !== "aborted";
              return { ...current, [sid]: {
                completedRuns: previous.completedRuns + (completed ? 1 : 0),
                reportedTokens: previous.reportedTokens + (hasUsage ? total : 0),
                tokenUsageKnown: previous.tokenUsageKnown || hasUsage,
              } };
            });
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

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void api.teamList().then((result) => {
      if (!disposed) setTeamTasks(result.tasks ?? []);
    }).catch(() => undefined);
    void api.onTeamEvent((event) => {
      if (!event.task) return;
      setTeamTasks((current) => upsertTeamTask(current, event.task));
      if (event.task.status === "running") {
        setRunning((current) => ({ ...current, [event.task.to_session_id]: true }));
      }
      if (event.task.status === "done" || event.task.status === "failed" || event.task.status === "cancelled") {
        setRunning((current) => ({ ...current, [event.task.to_session_id]: false }));
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || sessions.length === 0) return;
    const agents = sessions.map((session) => {
      const saved = settings.agents?.find((agent) => agent.id === session.id);
      return { id: session.id, label: saved?.label || session.label };
    });
    void api.teamRoster(agents).catch(() => undefined);
  }, [sessions, settings.agents]);

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

  const createSession = async (label: string, providerName: string, requestedId?: string, openWorkbench = true, requestedEngine?: api.AgentEngine, requestedSkills?: api.AgentSkill[]) => {
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
    const enabledSkills: api.AgentSkill[] = requestedSkills ?? existing?.enabled_skills ?? (id.startsWith("doc-") ? ["documents", "memory"] : id.startsWith("photo-") ? ["photos", "memory"] : id.startsWith("music-") ? ["music", "videos", "memory"] : id.startsWith("video-") ? ["videos", "music", "memory"] : ALL_DEFAULT_SKILLS);
    await api.agentCreateSession(id, provider, existing?.system_prompt, engine, enabledSkills, label || existing?.label || id, existing?.config_dir);
    setSessions((prev) => prev.some((session) => session.id === id) ? prev : [...prev, { id, label: label || id, providerName, engine }]);
    setActiveId(id);
    if (openWorkbench) setView("workbench");
    // Persist the agent config so it is restored on next launch.
    const next: api.Settings = {
      ...settings,
      agents: existing
        ? (settings.agents ?? []).map((agent) => agent.id === id ? { ...agent, label: label || agent.label, provider_name: providerName, enabled_skills: enabledSkills, ...(engine ? { engine } : {}) } : agent)
        : [...(settings.agents ?? []), { id, label: label || id, provider_name: providerName, enabled_skills: enabledSkills, ...(engine ? { engine } : {}), ...(id === "tanvis" ? { config_dir: "agents/tanvis" } : {}) }],
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
        await api.agentCreateSession(sid, provider, agent?.system_prompt, agent?.engine ?? session.engine, agent?.enabled_skills, agent?.label ?? session.label, agent?.config_dir);
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

  const cancelTeamTask = async (taskId: string) => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setTeamTasks((current) => current.map((task) => task.id === taskId && (task.status === "queued" || task.status === "running")
        ? { ...task, status: "cancelled", updated_at: new Date().toISOString(), error: "已在预览中取消" }
        : task));
      return;
    }
    const result = await api.teamCancel(taskId);
    if (result.task) setTeamTasks((current) => upsertTeamTask(current, result.task));
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
      if (previous?.provider_name === agent.provider_name && previous?.system_prompt === agent.system_prompt && previous?.engine === agent.engine && previous?.config_dir === agent.config_dir && JSON.stringify(previous?.enabled_skills ?? []) === JSON.stringify(agent.enabled_skills ?? [])) continue;
      try {
        await api.agentClose(session.id);
        await api.agentCreateSession(session.id, provider, agent.system_prompt, agent.engine, agent.enabled_skills, agent.label, agent.config_dir);
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
    if (agentOsMode) {
      return <div className="os-boot-failure"><div><b>DepDek Home 尚未准备好</b><p>{rootError ?? "正在初始化个人数据空间…"}</p><button className="primary" onClick={() => void api.vaultInitHome().then(setRoot).catch((error) => setRootError(String(error)))}>重试</button></div></div>;
    }
    return (
      <div className="folder-picker-page">
        <FolderPicker onPick={pickRoot} error={rootError} />
      </div>
    );
  }
  return (
    <div className="app">
      {agentOsMode && osView === "shell" ? (
        <DepDekAiOsShell
          root={root}
          settings={settings}
          sessions={sessions}
          activeAgentId={activeId}
          chats={chats}
          running={running}
          onSend={send}
          onAbort={abort}
          onCreateAgent={createSession}
          onSaveSettings={saveSettings}
          onOpenHome={() => {
            setView("home");
            setOsView("home");
          }}
        />
      ) : view === "home" ? (
        <DepDekHome
          root={root}
          providerCount={Object.keys(settings.providers).length}
          sessionCount={sessions.length}
          agentMetrics={agentMetrics}
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
          onOpenShell={agentOsMode ? () => { setView("home"); setOsView("shell"); } : undefined}
          teamTasks={teamTasks}
          onCancelTeamTask={cancelTeamTask}
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
      <MediaViewer path={mediaFile?.path ?? null} mime={mediaFile?.mime} dataUrl={mediaFile?.dataUrl} loadingPath={mediaLoading} error={mediaError} onClose={() => { setMediaFile(null); setMediaError(null); }} />
    </div>
  );
}
