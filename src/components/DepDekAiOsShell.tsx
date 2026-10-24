import { ArrowUp, CaretDown, Check, CircleNotch, FileText, FilmStrip, Gear, Images, ListChecks, LockKey, Microphone, Moon, Palette, SidebarSimple, Robot, ShieldCheck, Sparkle, SquaresFour, Stop, Sun, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentMetrics, ChatBlock, SessionInfo } from "../App";
import * as api from "../api";
import { APP_VERSION } from "../version";
import { followUpClues, ROOM_AGENT_ID, roomMembers, submitsChat } from "../lib/aiOsRoom";
import { isLocalProvider, providerAllowedForMode } from "../lib/aiOsSetup";
import { roomProviderFallback } from "../lib/roomModel";
import RoomModelConnection, { useRoomModelConnections, type ModelStatusService } from "./RoomModelConnection";
import RoomControlPopover from "./RoomControlPopover";
import { useAiOsConnectionMode } from "./AiOsConnectionContext";
import AiOsModelSetup from "./AiOsModelSetup";
import MarkdownText from "./MarkdownText";
import ToolProcessPanel from "./ToolProcessPanel";
import TreasurePanel, { type PhotoServices } from "./TreasurePanel";
import VideoPanel from "./VideoPanel";
import { suggestVideoScene, videoQueryFromText, VIDEO_SCENES, type VideoScene, type VideoServices } from "../lib/videoLibrary";
import DocumentsPanel from "./DocumentsPanel";
import NativeDocumentsPanel from "./NativeDocumentsPanel";
import type { DocumentServices } from "../lib/documentLibrary";
import RoomProgressSummary from "./RoomProgressSummary";
import { photoQueryFromText, suggestTreasureScene, TREASURE_SCENES, type TreasureScene } from "../lib/treasure";
import { DOCUMENT_SCENES, suggestDocumentScene, type DocumentExamples, type DocumentScene } from "../lib/documentScenes";
import WukongHead from "./WukongHead";
import WukongMomentPlayer from "./WukongMoment";
import useRoomVoice from "./useRoomVoice";
import jiahoLogo from "../assets/jiaho-boot-logo.png";
import "./ai-os-room.css";
import "./ai-os-entry.css";
import "./ai-os-modern.css";

type Props = {
  root: string; settings: api.Settings; sessions: SessionInfo[]; activeAgentId: string | null;
  chats: Record<string, ChatBlock[]>; running: Record<string, boolean>;
  agentMetrics?: Record<string, AgentMetrics>; teamTasks?: api.TeamTask[];
  onSelectAgent: (id: string) => void;
  onSend: (sessionId: string, text: string) => Promise<void>;
  onAbort: (sessionId: string) => Promise<void>;
  onCreateAgent: (label: string, providerName: string, id?: string, openWorkbench?: boolean) => Promise<void>;
  onSaveSettings: (settings: api.Settings) => Promise<void>;
  onCancelTask?: (id: string) => Promise<void>;
  onOpenHome: () => void;
  photoServices?: PhotoServices;
  initialTreasureScene?: TreasureScene;
  initialVideoScene?: VideoScene;
  videoServices?: VideoServices;
  initialDocumentScene?: DocumentScene;
  documentExamples?: DocumentExamples;
  documentServices?: DocumentServices;
  documentPreviewState?: "ready" | "empty" | "error";
  onDocumentSceneChange?: (scene: DocumentScene) => void;
  preview?: boolean;
  modelStatusService?: ModelStatusService;
};
const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
function initialTheme(): "light" | "dark" { try { return window.localStorage.getItem("jiaho.agent-room.theme") === "dark" ? "dark" : "light"; } catch { return "light"; } }
function initialAppearance(): "glass" | "pure" | "focus" { try { const value = window.localStorage.getItem("jiaho.agent-room.appearance"); return value === "pure" || value === "focus" ? value : "glass"; } catch { return "glass"; } }
function initialMoments(): boolean { try { return window.localStorage.getItem("jiaho.agent-room.moments") !== "off"; } catch { return true; } }
function initialCloudEnabled(): boolean { try { return window.localStorage.getItem("jiaho.agent-room.cloud-model") !== "off"; } catch { return true; } }
function Avatar({ id, mark, active = false, busy = false, listening = false }: { id: string; mark: string; active?: boolean; busy?: boolean; listening?: boolean }) {
  return <span className={`ai-room__avatar avatar-${id}`} aria-hidden="true">{id === ROOM_AGENT_ID ? <WukongHead active={active} busy={busy} listening={listening} /> : <span>{mark}</span>}</span>;
}

/** AI-OS now opens the Wukong room; the old terminal-colored shell is retired. */
export default function DepDekAiOsShell({ root, settings, sessions, activeAgentId, chats, running, agentMetrics = {}, teamTasks = [], onSelectAgent, onSend, onAbort, onCreateAgent, onSaveSettings, onCancelTask, onOpenHome, photoServices, initialTreasureScene, initialVideoScene, videoServices, initialDocumentScene, documentExamples, documentServices, documentPreviewState, onDocumentSceneChange, preview = false, modelStatusService }: Props) {
  const connectionMode = useAiOsConnectionMode();
  const members = roomMembers(settings), selected = members.find((person) => person.id === activeAgentId) ?? members[0];
  const agent = settings.agents?.find((item) => item.id === selected.id);
  const providerName = agent?.provider_name ?? "", provider = settings.providers[providerName];
  const engine = agent?.engine ?? "pi", isRunning = Boolean(running[selected.id]);
  const blocks = chats[selected.id] ?? [];
  const hasDialogue = blocks.some((block) => block.kind === "user" || block.kind === "assistant");
  const [momentsEnabled, setMomentsEnabled] = useState(initialMoments);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cloudEnabled, setCloudEnabled] = useState(initialCloudEnabled);
  const cloudAllowed = connectionMode === "online" && cloudEnabled;
  const connection = useRoomModelConnections(settings, providerName, connectionMode, cloudAllowed, preview ? modelStatusService : undefined);
  const manualProvider = useRef("");
  const fallbackAttempt = useRef("");
  const draft = drafts[selected.id] ?? "", setDraft = (text: string) => setDrafts((items) => ({ ...items, [selected.id]: text }));
  const [theme, setTheme] = useState(initialTheme), [appearance, setAppearance] = useState(initialAppearance);
  const [popover, setPopover] = useState<"appearance" | "runtime" | null>(null);
  const [panelOpen, setPanelOpen] = useState(Boolean(initialTreasureScene || initialDocumentScene || initialVideoScene)), [panelWidth, setPanelWidth] = useState(320);
  const [settingsOpen, setSettingsOpen] = useState(false), [saving, setSaving] = useState(false), [notice, setNotice] = useState("");
  const [cards, setCards] = useState<api.ApprovalCard[]>([]), [acting, setActing] = useState("");
  const [treasureOpen, setTreasureOpen] = useState(Boolean(initialTreasureScene)), [treasureScene, setTreasureScene] = useState<TreasureScene>(initialTreasureScene ?? "memory");
  const [photoProgress, setPhotoProgress] = useState<string[]>([]), [photoQuery, setPhotoQuery] = useState("");
  const [documentsOpen, setDocumentsOpen] = useState(Boolean(initialDocumentScene)), [documentScene, setDocumentScene] = useState<DocumentScene>(initialDocumentScene ?? "find");
  const [documentProgress, setDocumentProgress] = useState<string[]>([]);
  const [videosOpen, setVideosOpen] = useState(Boolean(initialVideoScene)), [videoScene, setVideoScene] = useState<VideoScene>(initialVideoScene ?? "memory");
  const [videoProgress, setVideoProgress] = useState<string[]>([]), [videoQuery, setVideoQuery] = useState("");
  const documents = documentsOpen && selected.id === ROOM_AGENT_ID;
  const videos = videosOpen && !documents && selected.id === ROOM_AGENT_ID;
  const treasure = treasureOpen && !documents && !videos && selected.id === ROOM_AGENT_ID;
  const collection = treasure || videos || documents;
  const recentUser = [...blocks].reverse().find((block): block is Extract<ChatBlock, { kind: "user" }> => block.kind === "user");
  const suggestion = suggestTreasureScene(recentUser?.text ?? "");
  const documentSuggestion = suggestDocumentScene(recentUser?.text ?? "");
  const videoSuggestion = suggestVideoScene(recentUser?.text ?? "");
  const input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null), room = useRef<HTMLElement>(null), frame = useRef<number>();
  const sending = useRef(false), selectedRef = useRef(selected.id); selectedRef.current = selected.id;
  const voice = useRoomVoice(selected.id, (id, text) => {
    setDrafts((items) => ({ ...items, [id]: `${items[id] ? `${items[id]} ` : ""}${text}` }));
    if (selectedRef.current === id) input.current?.focus();
  }, setNotice);
  const modelAllowed = !!provider && providerAllowedForMode(provider, connectionMode);
  const agreed = modelAllowed && (isLocalProvider(provider) ? connection.states[providerName]?.state !== "unavailable" : cloudAllowed);
  const cloudChecked = cloudAllowed && (!provider || !isLocalProvider(provider) || connection.states[providerName]?.state === "unavailable");
  const needsCloudProvider = cloudChecked && (!provider || isLocalProvider(provider)) && !Object.values(settings.providers).some((value) => !isLocalProvider(value));

  useEffect(() => { try { window.localStorage.setItem("jiaho.agent-room.theme", theme); } catch { /* appearance only */ } }, [theme]);
  useEffect(() => { try { window.localStorage.setItem("jiaho.agent-room.appearance", appearance); } catch { /* appearance only */ } }, [appearance]);
  useEffect(() => { try { window.localStorage.setItem("jiaho.agent-room.moments", momentsEnabled ? "on" : "off"); } catch { /* appearance only */ } }, [momentsEnabled]);
  useEffect(() => { try { window.localStorage.setItem("jiaho.agent-room.cloud-model", cloudEnabled ? "on" : "off"); } catch { /* preference only; never credentials */ } }, [cloudEnabled]);
  useEffect(() => {
    if (!agent || saving || isRunning || manualProvider.current && manualProvider.current === providerName) return;
    const next = roomProviderFallback(settings, providerName, connectionMode, connection.states, cloudAllowed);
    const attempt = `${selected.id}:${providerName}:${next}`;
    if (!next || next === providerName || fallbackAttempt.current === attempt) return;
    fallbackAttempt.current = attempt;
    void changeConfig({ provider_name: next });
  }, [settings, providerName, selected.id, saving, isRunning, connectionMode, connection.states, cloudAllowed]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [selected.id, blocks.length, blocks[blocks.length - 1], isRunning]);
  useEffect(() => {
    if (selected.id !== ROOM_AGENT_ID) return;
    if (videoSuggestion) {
      setVideosOpen(true); setDocumentsOpen(false); setTreasureOpen(false);
      if (typeof window === "undefined" || window.innerWidth >= 1100) setPanelOpen(true);
      const query = videoQueryFromText(recentUser?.text ?? "");
      if (query !== undefined) setVideoQuery(query);
      return;
    }
    if (documentSuggestion && !suggestion) {
      setDocumentsOpen(true); setTreasureOpen(false); setVideosOpen(false);
      if (typeof window === "undefined" || window.innerWidth >= 1100) setPanelOpen(true);
      return;
    }
    if (!suggestion) return;
    setDocumentsOpen(false); setVideosOpen(false);
    setTreasureOpen(true);
    if (typeof window === "undefined" || window.innerWidth >= 1100) setPanelOpen(true);
    const query = photoQueryFromText(recentUser?.text ?? "");
    if (query !== undefined) setPhotoQuery(query);
  }, [recentUser?.id, selected.id]);
  useEffect(() => {
    if (!native()) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void api.onApprovalEvent(({ card }) => { if (!disposed) setCards((items) => [card, ...items.filter((item) => item.id !== card.id)]); }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => {});
    void api.approvalList().then(({ cards: loaded }) => { if (!disposed) setCards((current) => [...current, ...loaded.filter((item) => !current.some((saved) => saved.id === item.id))]); }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  useEffect(() => {
    if (!settingsOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = room.current?.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSettingsOpen(false); }
      if (event.key !== "Tab" || !dialog) return;
      const nodes = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter((node) => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else room.current?.querySelector<HTMLButtonElement>('.ai-room__runtime-control .ai-room__control-trigger')?.focus();
    };
  }, [settingsOpen]);

  const send = async () => {
    const text = draft.trim();
    if (!text || isRunning || saving || !provider || !agreed || sending.current) return;
    if (!native() && !preview) { setNotice("这里是界面预览，请在原生 AI-OS 中发送消息。"); return; }
    sending.current = true; setNotice(""); setDraft("");
    try { if (!sessions.some((item) => item.id === selected.id)) await onCreateAgent(selected.name, providerName, selected.id, false); await onSend(selected.id, text); }
    catch (error) { setDrafts((items) => ({ ...items, [selected.id]: text })); setNotice(String(error)); }
    finally { sending.current = false; }
  };
  const changeConfig = async (patch: Partial<api.SavedAgent>) => {
    if (!agent || saving || isRunning) return;
    setSaving(true); setNotice("");
    try { await onSaveSettings({ ...settings, agents: settings.agents?.map((item) => item.id === agent.id ? { ...item, ...patch } : item) }); }
    catch { setNotice("未能更新 Agent 配置，请重试。"); } finally { setSaving(false); }
  };
  const chooseProvider = (name: string) => {
    manualProvider.current = name;
    if (settings.providers[name]) setCloudEnabled(!isLocalProvider(settings.providers[name]));
    void changeConfig({ provider_name: name });
  };
  const toggleCloud = (enabled: boolean) => {
    setCloudEnabled(enabled); manualProvider.current = ""; fallbackAttempt.current = "";
    const match = Object.entries(settings.providers).find(([name, config]) => enabled
      ? !isLocalProvider(config)
      : isLocalProvider(config) && connection.states[name]?.state === "available");
    if (match && match[0] !== providerName) void changeConfig({ provider_name: match[0] });
    if (!enabled && !match) setNotice("公域大模型已暂停；本地模型暂不可用，可以随时重新勾选。");
    else setNotice("");
  };
  const decide = async (card: api.ApprovalCard, decision: "approve" | "deny") => {
    if (acting) return; setActing(card.id); setNotice("");
    try { const result = await api.approvalDecide(card.id, decision); setCards((items) => items.map((item) => item.id === card.id ? result.card : item)); }
    catch { setNotice("未能提交确认，操作可能已失效，请刷新后检查。"); } finally { setActing(""); }
  };
  const activity = blocks.filter((block): block is Extract<ChatBlock, { kind: "status" }> => block.kind === "status").slice(-2);
  const latest = [...blocks].reverse().find((block): block is Extract<ChatBlock, { kind: "assistant" }> => block.kind === "assistant");
  const clues = followUpClues(latest?.text ?? ""), pending = cards.filter((card) => card.session_id === selected.id && card.status === "pending");
  const tasks = teamTasks.filter((task) => task.from_session_id === selected.id || task.to_session_id === selected.id).slice(0, 6);
  useEffect(() => { if (pending.length && !collection) setPanelOpen(true); }, [pending.length, collection]);
  useEffect(() => {
    if (!panelOpen || popover || settingsOpen) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPanelOpen(false); room.current?.querySelector<HTMLButtonElement>('.ai-room__panel-toggle')?.focus(); } };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [panelOpen, popover, settingsOpen]);
  const messages: ReactNode[] = []; let tools: Extract<ChatBlock, { kind: "tool" }>[] = [];
  const flush = () => { if (tools.length && !collection) messages.push(<ToolProcessPanel key={`tools-${tools[0].id}`} blocks={tools} />); tools = []; };
  for (const block of blocks) {
    if (block.kind === "status") continue;
    if (block.kind === "tool") { tools.push(block); continue; }
    flush(); messages.push(<article key={block.id} className={`ai-room__message is-${block.kind}`}><small>{block.kind === "user" ? "你" : block.kind === "error" ? "执行未完成" : selected.name}</small>{block.kind === "assistant" ? <MarkdownText markdown={block.text} /> : <p>{block.kind === "error" ? block.message : block.text}</p>}</article>);
  }
  flush();
  const useDraft = (text: string) => { setDraft(text); input.current?.focus(); };
  const chooseScene = (scene: TreasureScene) => { setVideosOpen(false); setDocumentsOpen(false); setTreasureScene(scene); setTreasureOpen(true); setPanelOpen(true); };
  const chooseVideoScene = (scene: VideoScene) => { setVideoScene(scene); setVideosOpen(true); setDocumentsOpen(false); setTreasureOpen(false); setPanelOpen(true); };
  const chooseDocumentScene = (scene: DocumentScene) => { setVideosOpen(false); setDocumentScene(scene); setDocumentsOpen(true); setTreasureOpen(false); setPanelOpen(true); if (preview) onDocumentSceneChange?.(scene); };

  const momentPlayer = selected.id === ROOM_AGENT_ID ? <WukongMomentPlayer enabled={momentsEnabled} paused={isRunning || voice.recording || voice.transcribing || !!draft || saving || settingsOpen || pending.length > 0 || !!popover} contextKey={`${root}:${selected.id}:${collection ? "collection" : "chat"}`} timeline={scroll} welcome={!hasDialogue ? <Avatar id={selected.id} mark={selected.mark} active listening={voice.recording} /> : undefined} /> : null;

  return <main ref={room} className={`ai-room ai-room--modern ${!hasDialogue ? "is-welcome" : ""} ${panelOpen ? "" : "is-panel-collapsed"} ${collection ? "has-treasure" : ""} ${documents ? "has-documents" : ""} ${videos ? "has-videos" : ""}`} data-theme={theme} data-appearance={appearance} style={{ "--room-panel": documents ? "min(50vw, 740px)" : videos ? "min(50vw, 760px)" : treasure ? "min(50vw, 760px)" : `${panelWidth}px` } as CSSProperties}>
    <header className="ai-room__topbar">
      <button className="ai-room__brand" aria-label="家合首页" onClick={() => { onSelectAgent(ROOM_AGENT_ID); setTreasureOpen(false); setDocumentsOpen(false); setVideosOpen(false); setPanelOpen(false); }}><img src={jiahoLogo} alt="家合 Jiaho" /><b>家合</b></button>
      {(hasDialogue || collection) ? <div className="ai-room__context"><Avatar id={selected.id} mark={selected.mark} active busy={isRunning} listening={voice.recording} /><h1>{selected.name}</h1>{collection && <span>{documents ? "资料" : videos ? "视频" : "相册"}</span>}{isRunning && <CircleNotch size={14} className="room-spin" aria-label="正在处理" />}</div> : <h1 className="ai-room__sr-only">家合 AI-OS</h1>}
      <div className="ai-room__head-actions">
        {preview && <span className="ai-room__preview-badge" title="隔离界面预览，不连接模型或家庭资料">预览</span>}
        <RoomControlPopover label="外观" open={popover === "appearance"} onToggle={() => setPopover((value) => value === "appearance" ? null : "appearance")} onClose={() => setPopover(null)} trigger={<Palette size={20} />}>
          <div className="ai-room__theme-options" role="group" aria-label="明暗模式"><button aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Sun size={16} />浅色</button><button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Moon size={16} />深色</button></div>
          <div className="ai-room__appearance-options" role="group" aria-label="界面材质">{([{ id: "glass", label: "轻透" }, { id: "pure", label: "纯净" }, { id: "focus", label: "专注" }] as const).map((item) => <button key={item.id} aria-pressed={appearance === item.id} onClick={() => setAppearance(item.id)}><span className={`ai-room__swatch is-${item.id}`} />{item.label}{appearance === item.id && <Check size={15} />}</button>)}</div>
          <button className="ai-room__motion-toggle" aria-label={momentsEnabled ? "关闭悟空动效" : "开启悟空动效"} aria-pressed={momentsEnabled} onClick={() => setMomentsEnabled((value) => !value)}><Sparkle size={17} weight={momentsEnabled ? "fill" : "regular"} /><span>悟空动效</span><span>{momentsEnabled ? "开" : "关"}</span></button>
          <div className="ai-room__mobile-actions"><button aria-label="执行器与模型" disabled={saving || isRunning} onClick={() => { setPopover(null); setSettingsOpen(true); }}><Gear size={19} /></button><button aria-label="打开工作台" onClick={onOpenHome}><SquaresFour size={19} /></button><button aria-label="锁定空间" onClick={() => void api.aiOsLogout().then(() => window.location.reload()).catch(() => setNotice("未能锁定空间，请重试。"))}><LockKey size={19} /></button></div>
        </RoomControlPopover>
        <button className="ai-room__panel-toggle" aria-label={`${panelOpen ? "收起操作面板" : "展开操作面板"}${pending.length ? `，${pending.length} 项待确认` : ""}`} aria-expanded={panelOpen} title="操作面板" onClick={() => setPanelOpen((value) => !value)}><SidebarSimple size={20} />{pending.length > 0 && <span>{pending.length}</span>}</button>
      </div>
    </header>
    <aside className="ai-room__sidebar" aria-label="Agent 列表">
      <nav className="ai-room__members" aria-label="伙伴与资料">{members.map((person) => {
        const config = settings.agents?.find((item) => item.id === person.id), busy = Boolean(running[person.id]);
        return <button key={person.id} className={`ai-room__member ${selected.id === person.id && !collection ? "is-selected" : ""}`} aria-current={selected.id === person.id && !collection ? "page" : undefined} aria-label={`${person.name} · ${person.role}`} title={`${person.name} · ${busy ? "正在处理" : config && settings.providers[config.provider_name] ? "家庭资料管家" : "待配置"}`} data-tip={person.name} onClick={() => { if (voice.recording) void voice.stop(); onSelectAgent(person.id); setTreasureOpen(false); setDocumentsOpen(false); setVideosOpen(false); setNotice(""); }}><Avatar id={person.id} mark={person.mark} active={selected.id === person.id} busy={busy} /><span className="ai-room__member-copy"><b>{person.name}</b></span></button>;
      })}<button className={`ai-room__treasure-link ${treasure ? "is-selected" : ""}`} aria-label="相册" aria-current={treasure ? "page" : undefined} title="相册 · 照片与我们的故事" data-tip="相册" onClick={() => { onSelectAgent(ROOM_AGENT_ID); setVideosOpen(false); setDocumentsOpen(false); setTreasureOpen(true); setPanelOpen(true); }}><Images size={25} /><span>相册</span></button><button className={`ai-room__treasure-link ${videos ? "is-selected" : ""}`} aria-label="视频" aria-current={videos ? "page" : undefined} title="视频 · 有声有色的回忆" data-tip="视频" onClick={() => { onSelectAgent(ROOM_AGENT_ID); setDocumentsOpen(false); setTreasureOpen(false); setVideosOpen(true); setPanelOpen(true); }}><FilmStrip size={25} /><span>视频</span></button><button className={`ai-room__treasure-link ${documents ? "is-selected" : ""}`} aria-label="资料" aria-current={documents ? "page" : undefined} title="资料 · 找得到，收得好，用得上" data-tip="资料" onClick={() => { onSelectAgent(ROOM_AGENT_ID); setVideosOpen(false); setTreasureOpen(false); setDocumentsOpen(true); setPanelOpen(true); }}><FileText size={25} /><span>资料</span></button></nav>
      <div className="ai-room__sidebar-actions"><button onClick={onOpenHome} aria-label="打开工作台" title="打开工作台" data-tip="工作台"><SquaresFour size={19} /></button><button onClick={() => setSettingsOpen(true)} disabled={saving || isRunning} aria-label="执行器与模型" title="执行器与模型" data-tip="设置"><Gear size={19} /></button><button aria-label="锁定空间" title="锁定空间" data-tip="锁定" onClick={() => void api.aiOsLogout().then(() => window.location.reload()).catch(() => setNotice("未能锁定空间，请重试。"))}><LockKey size={19} /></button></div>
    </aside>
    <section className="ai-room__conversation" aria-label="聊天区域">
      <div className="ai-room__messages" ref={scroll} aria-label={`${selected.name}的对话`}>
        {!hasDialogue && <div className="ai-room__empty">{momentPlayer}<h2>{documents ? "找得到，也收得好。" : videos ? "让时光，再放一遍。" : treasure ? "想重温，哪一刻？" : "今天，想做点什么？"}</h2></div>}
        {messages}{hasDialogue && momentPlayer}{isRunning && <div className="ai-room__thinking" role="status"><CircleNotch className="room-spin" size={16} />{selected.name}正在想…</div>}
        {treasure && <section className="treasure-scenes" aria-label="选择照片场景"><div>{TREASURE_SCENES.map((scene) => <button key={scene.id} aria-pressed={treasureScene === scene.id} className={treasureScene === scene.id ? "is-selected" : ""} title={scene.hint} onClick={() => chooseScene(scene.id)}><b>{scene.title}{suggestion === scene.id && <em>建议</em>}</b></button>)}</div></section>}
        {videos && <section className="treasure-scenes video-scenes" aria-label="选择视频场景"><div>{VIDEO_SCENES.map((scene) => <button key={scene.id} aria-pressed={videoScene === scene.id} className={videoScene === scene.id ? "is-selected" : ""} title={scene.hint} onClick={() => chooseVideoScene(scene.id)}><b>{scene.title}{videoSuggestion === scene.id && <em>建议</em>}</b></button>)}</div></section>}
        {documents && <section className="treasure-scenes document-scenes" aria-label="选择资料场景"><div>{DOCUMENT_SCENES.map((scene) => <button key={scene.id} aria-pressed={documentScene === scene.id} className={documentScene === scene.id ? "is-selected" : ""} title={scene.hint} onClick={() => chooseDocumentScene(scene.id)}><b>{scene.title}{documentSuggestion === scene.id && <em>建议</em>}</b></button>)}</div></section>}
        {collection && pending.length > 0 && <button className="ai-room__approval-reminder" onClick={() => { setTreasureOpen(false); setDocumentsOpen(false); setVideosOpen(false); setPanelOpen(true); }}>{pending.length} 项操作待你确认 · 打开操作面板</button>}
      </div>
      <div className="ai-room__composer-area">
        {collection ? <RoomProgressSummary blocks={blocks} local={documents ? documentProgress : videos ? videoProgress : photoProgress} running={isRunning} /> : activity.length > 0 && <div className="ai-room__activity" aria-label="处理进度" aria-live="polite">{activity.map((item) => <div key={item.id}><i />{item.text}</div>)}</div>}
        {notice && <p className="ai-room__notice" role="status">{notice}</p>}
        <div className="ai-room__input">
          <textarea ref={input} rows={2} aria-label={`和${selected.name}聊天`} title="Enter 发送 · Shift + Enter 换行" placeholder={voice.recording ? "正在聆听，停止后文字会填入草稿…" : `把想做的事，交给${selected.name}…`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (submitsChat(event.key, event.shiftKey, event.nativeEvent.isComposing)) { event.preventDefault(); void send(); } }} />
          <div className="ai-room__input-toolbar">
            <RoomControlPopover label="模型与执行器" title={`${providerName || "选择模型"}${provider ? ` · ${provider.model}` : ""}`} className="ai-room__runtime-control" open={popover === "runtime"} onToggle={() => setPopover((value) => value === "runtime" ? null : "runtime")} onClose={() => setPopover(null)} trigger={<><Robot size={15} /><span>{!provider ? "选择模型" : isLocalProvider(provider) ? "本地" : "公域"}</span><CaretDown size={11} /></>}>
              <RoomModelConnection settings={settings} providerName={providerName} states={connection.states} cloudEnabled={cloudAllowed} onRefresh={connection.refresh} />
              <div className="ai-room__selectors"><label><span>执行器</span><select aria-label="当前 Agent 执行器" value={engine} disabled={isRunning || saving || !agent} onChange={(event) => void changeConfig({ engine: event.target.value as api.AgentEngine })}><option value="pi">Pi Agent</option><option value="deepseek-harness">DeepSeek Harness</option></select></label><label><span>模型</span><select aria-label="当前 Agent 模型" value={providerName} disabled={isRunning || saving || !agent} onChange={(event) => chooseProvider(event.target.value)}>{!providerName && <option value="">选择模型</option>}{Object.entries(settings.providers).map(([name, config]) => <option key={name} value={name} disabled={!providerAllowedForMode(config, connectionMode)}>{name} · {config.model}{!providerAllowedForMode(config, connectionMode) ? "（本地模式不可用）" : ""}</option>)}</select></label></div>
              <details className="ai-room__usage"><summary>用量</summary><p>{agentMetrics[selected.id]?.completedRuns ?? 0} 次完成 · {agentMetrics[selected.id]?.tokenUsageKnown ? `${agentMetrics[selected.id].reportedTokens.toLocaleString()} Token` : "用量未上报"}</p></details>
              <button className="ai-room__configure" disabled={saving || isRunning} onClick={() => { setPopover(null); setSettingsOpen(true); }}><Gear size={15} />执行器与模型</button>
            </RoomControlPopover>
            <div className="ai-room__input-actions"><button type="button" aria-label={voice.recording ? "停止录音并识别" : "语音输入"} title="语音在本机识别，文字先填入草稿" className={voice.recording ? "is-recording" : ""} disabled={voice.transcribing} onClick={() => voice.recording ? void voice.stop() : void voice.start()}>{voice.transcribing ? <CircleNotch className="room-spin" size={19} /> : voice.recording ? <Stop size={19} /> : <Microphone size={19} />}</button>{isRunning ? <button aria-label="停止回复" onClick={() => void onAbort(selected.id)}><Stop size={18} weight="fill" /></button> : <button className="ai-room__send" aria-label="发送消息" disabled={!draft.trim() || saving || !provider || !agreed || voice.transcribing} onClick={() => void send()}><ArrowUp size={20} weight="bold" /></button>}</div>
          </div>
        </div>
        <label className="ai-room__consent"><input type="checkbox" checked={cloudChecked} disabled={connectionMode === "local" || saving || isRunning} onChange={(event) => toggleCloud(event.target.checked)} /><span>使用公域大模型<small>{connectionMode === "local" ? "本地模式下不启用" : "仅在点击发送后提交对话，家庭文件不会自动上传"}</small></span></label>
        {(!provider || needsCloudProvider) && <button className="ai-room__setup-link" onClick={() => setSettingsOpen(true)}>{needsCloudProvider ? "连接一个公域大模型，再开始聊天 →" : "先配置一个大模型，再开始聊天 →"}</button>}
        {provider && !modelAllowed && <p className="ai-room__notice">本地模式：请在模型配置中选择本机服务</p>}
        {!hasDialogue && !collection && <div className="ai-room__starters" aria-label="快速开始"><button onClick={() => useDraft("找照片：海边")}><Images size={16} />找照片</button><button onClick={() => useDraft("帮我整理一份资料清单")}><FileText size={16} />理资料</button><button onClick={() => useDraft("帮我理清今天最重要的事")}><ListChecks size={16} />做计划</button></div>}
      </div>
    </section>
    {videos ? <VideoPanel key={`videos:${root}:${selected.id}`} hidden={!panelOpen} scene={videoScene} query={videoQuery} services={preview ? videoServices : undefined} onScene={chooseVideoScene} onQuery={setVideoQuery} onProgress={setVideoProgress} onOpenHome={onOpenHome} onClose={() => setPanelOpen(false)} chatMessage={recentUser} /> : documents ? preview && documentExamples ? <DocumentsPanel key={`documents:${root}:${selected.id}`} hidden={!panelOpen} scene={documentScene} examples={documentExamples} initialState={documentPreviewState} onAsk={useDraft} onProgress={setDocumentProgress} onOpenHome={onOpenHome} onClose={() => setPanelOpen(false)} /> : <NativeDocumentsPanel key={`native-documents:${root}:${selected.id}`} hidden={!panelOpen} scene={documentScene} service={preview ? documentServices : undefined} chatMessage={recentUser} onAsk={useDraft} onProgress={setDocumentProgress} onOpenHome={onOpenHome} onClose={() => setPanelOpen(false)} /> : treasure ? <TreasurePanel key={`${root}:${selected.id}`} hidden={!panelOpen} scene={treasureScene} query={photoQuery} services={photoServices} onScene={chooseScene} onProgress={setPhotoProgress} onOpenHome={onOpenHome} onQuery={setPhotoQuery} chatMessage={recentUser} /> : panelOpen && <aside className="ai-room__inspector" aria-label="操作面板">
      <div className="ai-room__resize" role="separator" aria-label="调整操作面板宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); setPanelWidth((value) => Math.min(440, value + 20)); } if (event.key === "ArrowRight") { event.preventDefault(); setPanelWidth((value) => Math.max(280, value - 20)); } }} onPointerDown={(event) => {
        const element = event.currentTarget, start = event.clientX, width = panelWidth; let next = width;
        element.setPointerCapture(event.pointerId);
        element.onpointermove = (move) => { next = Math.max(280, Math.min(440, width + start - move.clientX)); if (frame.current) cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => room.current?.style.setProperty("--room-panel", `${next}px`)); };
        const finish = () => { if (frame.current) cancelAnimationFrame(frame.current); setPanelWidth(next); element.onpointermove = null; element.onpointerup = null; element.onpointercancel = null; };
        element.onpointerup = finish; element.onpointercancel = finish;
      }} />
      <header><h2>操作面板</h2><button aria-label="关闭操作面板" onClick={() => setPanelOpen(false)}><X size={18} /></button></header>
      <div className="ai-room__inspector-scroll">
        {(pending.length > 0 || isRunning) && <section className="ai-room__attention"><span><ShieldCheck size={22} /></span><div><b>{pending.length ? `${pending.length} 项操作等你确认` : `${selected.name}正在处理`}</b>{pending.length > 0 && <p>先查看操作范围，再决定是否允许。</p>}</div></section>}
        {pending.length > 0 && <section className="ai-room__panel-section"><h3>待确认操作</h3>{pending.map((card) => <article className="ai-room__approval" key={card.id}><b>{card.title}</b><p>{card.summary}</p><details><summary>查看操作详情</summary><pre>{JSON.stringify(card.preview, null, 2)}</pre></details><div><button disabled={!!acting} onClick={() => void decide(card, "deny")}>拒绝</button><button disabled={!!acting} onClick={() => void decide(card, "approve")}><Check size={14} />允许本次操作</button></div></article>)}</section>}
        <section className="ai-room__panel-section"><h3>本轮线索</h3>{clues.length ? clues.map((text, index) => <button className="ai-room__clue" key={text} title="点击仅填入草稿" onClick={() => useDraft(`关于「${text}」，请进一步说明。`)}><span>{String(index + 1).padStart(2, "0")}</span><b>{text}</b><span>↗</span></button>) : <div className="ai-room__panel-empty"><ListChecks size={30} /><p>暂无待办</p></div>}</section>
        {tasks.length > 0 && <section className="ai-room__panel-section"><h3>协作任务</h3>{tasks.map((task) => <article className="ai-room__task" key={task.id}><small>{task.from_label} → {task.to_label} · {{ queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消" }[task.status]}</small><p>{task.instruction}</p>{(task.status === "queued" || task.status === "running") && onCancelTask && <button onClick={() => void onCancelTask(task.id).catch(() => setNotice("未能取消任务，请重试。"))}>取消任务</button>}</article>)}</section>}
        <section className="ai-room__panel-section"><h3>接下来</h3>{["把刚才的内容整理成清单", "还有哪些地方需要我确认？"].map((text) => <button className="ai-room__prompt" key={text} onClick={() => useDraft(text)}>{text}<span>＋</span></button>)}</section>
        <details className="ai-room__panel-section ai-room__connection"><summary>当前连接</summary><b>{provider?.model ?? "尚未配置模型"}</b><p>{engine === "deepseek-harness" ? "DeepSeek Harness" : "Pi Agent"} · {providerName || "请选择 Provider"}</p><small title={root}>{root}</small><button onClick={onOpenHome}>打开完整工作台 ↗</button></details>
      </div><footer><LockKey size={13} />文件与外部操作仍受原有权限和审批约束</footer>
    </aside>}
    <footer className="ai-room__app-footer"><span>AI-OS <small>v{APP_VERSION}</small></span><span title={root}>{connectionMode === "local" ? "本地模式" : "联网模式"}</span></footer>
    {panelOpen && <button className="ai-room__drawer-scrim" aria-label="收起面板，返回聊天" onClick={() => setPanelOpen(false)} />}
    {settingsOpen && <div className="ai-room__modal-backdrop"><section className="ai-room__model-dialog" role="dialog" aria-modal="true" aria-label={`配置${selected.name}的模型`}><header><div><b>{selected.name} · 模型连接</b><small>保存到本机加密凭据服务</small></div><button aria-label="关闭模型配置" onClick={() => setSettingsOpen(false)}><X size={20} /></button></header><div className="jiaho-entry"><AiOsModelSetup variant="room" mode={connectionMode} agentId={selected.id} language="zh-CN" onSaved={async () => onSaveSettings(await api.settingsGet())} onReady={() => { setSettingsOpen(false); setNotice("模型配置已保存。实际可用性以连接测试或对话结果为准。"); }} /></div></section></div>}
  </main>;
}
