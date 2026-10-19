import { ArrowUp, Check, CircleNotch, Gear, LockKey, Microphone, Moon, SidebarSimple, Robot, ShieldCheck, SquaresFour, Stop, Sun, Tray, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentMetrics, ChatBlock, SessionInfo } from "../App";
import * as api from "../api";
import { APP_VERSION } from "../version";
import { followUpClues, ROOM_AGENT_ID, roomMembers, submitsChat } from "../lib/aiOsRoom";
import { isBuiltinProvider, providerAllowedForMode, providerEndpoint } from "../lib/aiOsSetup";
import { useAiOsConnectionMode } from "./AiOsConnectionContext";
import AiOsModelSetup from "./AiOsModelSetup";
import MarkdownText from "./MarkdownText";
import ToolProcessPanel from "./ToolProcessPanel";
import TreasurePanel, { type PhotoServices } from "./TreasurePanel";
import RoomProgressSummary from "./RoomProgressSummary";
import { photoQueryFromText, suggestTreasureScene, TREASURE_SCENES, type TreasureScene } from "../lib/treasure";
import WukongHead from "./WukongHead";
import useRoomVoice from "./useRoomVoice";
import jiahoLogo from "../assets/jiaho-boot-logo.png";
import "./ai-os-room.css";
import "./ai-os-entry.css";

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
  preview?: boolean;
};
const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
function initialTheme(): "light" | "dark" { try { return window.localStorage.getItem("jiaho.agent-room.theme") === "dark" ? "dark" : "light"; } catch { return "light"; } }
function Avatar({ id, mark, active = false, busy = false, listening = false }: { id: string; mark: string; active?: boolean; busy?: boolean; listening?: boolean }) {
  return <span className={`ai-room__avatar avatar-${id}`} aria-hidden="true">{id === ROOM_AGENT_ID ? <WukongHead active={active} busy={busy} listening={listening} /> : <span>{mark}</span>}</span>;
}

/** AI-OS now opens the Wukong room; the old terminal-colored shell is retired. */
export default function DepDekAiOsShell({ root, settings, sessions, activeAgentId, chats, running, agentMetrics = {}, teamTasks = [], onSelectAgent, onSend, onAbort, onCreateAgent, onSaveSettings, onCancelTask, onOpenHome, photoServices, initialTreasureScene, preview = false }: Props) {
  const connectionMode = useAiOsConnectionMode();
  const members = roomMembers(settings), selected = members.find((person) => person.id === activeAgentId) ?? members[0];
  const agent = settings.agents?.find((item) => item.id === selected.id);
  const providerName = agent?.provider_name ?? "", provider = settings.providers[providerName];
  const engine = agent?.engine ?? "pi", isRunning = Boolean(running[selected.id]);
  const blocks = chats[selected.id] ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [consents, setConsents] = useState<Record<string, string>>({});
  const draft = drafts[selected.id] ?? "", setDraft = (text: string) => setDrafts((items) => ({ ...items, [selected.id]: text }));
  const [theme, setTheme] = useState(initialTheme), [panelOpen, setPanelOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1100), [panelWidth, setPanelWidth] = useState(320);
  const [settingsOpen, setSettingsOpen] = useState(false), [saving, setSaving] = useState(false), [notice, setNotice] = useState("");
  const [cards, setCards] = useState<api.ApprovalCard[]>([]), [acting, setActing] = useState("");
  const [treasureOpen, setTreasureOpen] = useState(Boolean(initialTreasureScene)), [treasureScene, setTreasureScene] = useState<TreasureScene>(initialTreasureScene ?? "memory");
  const [photoProgress, setPhotoProgress] = useState<string[]>([]), [photoQuery, setPhotoQuery] = useState("");
  const treasure = treasureOpen && selected.id === ROOM_AGENT_ID;
  const recentUser = [...blocks].reverse().find((block): block is Extract<ChatBlock, { kind: "user" }> => block.kind === "user");
  const suggestion = suggestTreasureScene(recentUser?.text ?? "");
  const input = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null), room = useRef<HTMLElement>(null), frame = useRef<number>();
  const sending = useRef(false), selectedRef = useRef(selected.id); selectedRef.current = selected.id;
  const voice = useRoomVoice(selected.id, (id, text) => {
    setDrafts((items) => ({ ...items, [id]: `${items[id] ? `${items[id]} ` : ""}${text}` }));
    if (selectedRef.current === id) input.current?.focus();
  }, setNotice);
  const target = provider ? `${providerName}:${providerEndpoint(provider)}:${provider.model}` : "";
  const modelAllowed = !!provider && providerAllowedForMode(provider, connectionMode);
  const agreed = modelAllowed && (isBuiltinProvider(provider) || consents[selected.id] === target);

  useEffect(() => { try { window.localStorage.setItem("jiaho.agent-room.theme", theme); } catch { /* appearance only */ } }, [theme]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [selected.id, blocks.length, blocks[blocks.length - 1], isRunning]);
  useEffect(() => {
    if (!suggestion || selected.id !== ROOM_AGENT_ID) return;
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
    const dialog = room.current?.querySelector<HTMLElement>('[role="dialog"]');
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
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
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
  const decide = async (card: api.ApprovalCard, decision: "approve" | "deny") => {
    if (acting) return; setActing(card.id); setNotice("");
    try { const result = await api.approvalDecide(card.id, decision); setCards((items) => items.map((item) => item.id === card.id ? result.card : item)); }
    catch { setNotice("未能提交确认，操作可能已失效，请刷新后检查。"); } finally { setActing(""); }
  };
  const activity = blocks.filter((block): block is Extract<ChatBlock, { kind: "status" }> => block.kind === "status").slice(-2);
  const latest = [...blocks].reverse().find((block): block is Extract<ChatBlock, { kind: "assistant" }> => block.kind === "assistant");
  const clues = followUpClues(latest?.text ?? ""), pending = cards.filter((card) => card.session_id === selected.id && card.status === "pending");
  const tasks = teamTasks.filter((task) => task.from_session_id === selected.id || task.to_session_id === selected.id).slice(0, 6);
  const messages: ReactNode[] = []; let tools: Extract<ChatBlock, { kind: "tool" }>[] = [];
  const flush = () => { if (tools.length && !treasure) messages.push(<ToolProcessPanel key={`tools-${tools[0].id}`} blocks={tools} />); tools = []; };
  for (const block of blocks) {
    if (block.kind === "status") continue;
    if (block.kind === "tool") { tools.push(block); continue; }
    flush(); messages.push(<article key={block.id} className={`ai-room__message is-${block.kind}`}><small>{block.kind === "user" ? "你" : block.kind === "error" ? "执行未完成" : selected.name}</small>{block.kind === "assistant" ? <MarkdownText markdown={block.text} /> : <p>{block.kind === "error" ? block.message : block.text}</p>}</article>);
  }
  flush();
  const useDraft = (text: string) => { setDraft(text); input.current?.focus(); };
  const chooseScene = (scene: TreasureScene) => { setTreasureScene(scene); setTreasureOpen(true); setPanelOpen(true); };

  return <main ref={room} className={`ai-room ${panelOpen ? "" : "is-panel-collapsed"} ${treasure ? "has-treasure" : ""}`} data-theme={theme} style={{ "--room-panel": treasure ? "min(58vw, 820px)" : `${panelWidth}px` } as CSSProperties}>
    <aside className="ai-room__sidebar" aria-label="Agent 列表">
      <header className="ai-room__brand"><img src={jiahoLogo} alt="家合 Jiaho" /><div><b>家合</b><small>家庭资料管家</small></div></header>
      <div className="ai-room__nav-title">你的伙伴 <span>{members.length.toString().padStart(2, "0")}</span></div>
      <nav className="ai-room__members" aria-label="选择 Agent">{members.map((person) => {
        const config = settings.agents?.find((item) => item.id === person.id), busy = Boolean(running[person.id]), metric = agentMetrics[person.id];
        return <button key={person.id} className={`ai-room__member ${selected.id === person.id && !treasure ? "is-selected" : ""}`} aria-current={selected.id === person.id && !treasure ? "page" : undefined} aria-label={`${person.name} · ${person.role}`} title={`${person.name} · ${person.role}`} onClick={() => { if (voice.recording) void voice.stop(); onSelectAgent(person.id); setTreasureOpen(false); setNotice(""); }}><Avatar id={person.id} mark={person.mark} active={selected.id === person.id} busy={busy} /><span className="ai-room__member-copy"><b>{person.name}</b><small>{person.role}</small><em><i className={busy ? "is-busy" : ""} />{busy ? "正在处理" : config && settings.providers[config.provider_name] ? "待命" : "待配置"}</em><small>{metric?.completedRuns ?? 0} 次完成 · {metric?.tokenUsageKnown ? `${metric.reportedTokens.toLocaleString()} Token` : "用量未上报"}</small></span></button>;
      })}<button className={`ai-room__treasure-link ${treasure ? "is-selected" : ""}`} aria-current={treasure ? "page" : undefined} title="悟空的宝箱 · 相册" onClick={() => { onSelectAgent(ROOM_AGENT_ID); setTreasureOpen(true); setPanelOpen(true); }}><Tray size={23} /><span>宝箱<small>照片与我们的故事</small></span></button></nav>
      <div className="ai-room__sidebar-foot"><span>{connectionMode === "local" ? "本地模式" : "联网模式"} · {engine === "deepseek-harness" ? "DeepSeek Harness" : "Pi Agent"}</span><small>{provider?.model ?? "尚未选择模型"}</small>{provider && !modelAllowed && <small>当前模型受本地模式限制</small>}</div>
      <div className="ai-room__sidebar-actions"><button onClick={() => setSettingsOpen(true)} disabled={saving || isRunning} title="执行器与模型"><Gear size={17} /><span>执行器与模型</span></button><button onClick={onOpenHome} title="打开工作台"><SquaresFour size={17} /><span>工作台</span></button><button title="锁定空间" onClick={() => void invoke("ai_os_logout").then(() => window.location.reload()).catch(() => setNotice("未能锁定空间，请重试。"))}><LockKey size={17} /><span>锁定空间</span></button></div>
      <footer className="ai-room__version">Jiaho AI-OS <span>v{APP_VERSION}</span></footer>
    </aside>
    <section className="ai-room__conversation" aria-label="聊天区域">
      <header className="ai-room__header"><Avatar id={selected.id} mark={selected.mark} active busy={isRunning} listening={voice.recording} /><div><span>{treasure ? `宝箱 · ${TREASURE_SCENES.find((scene) => scene.id === treasureScene)?.title}` : selected.role}</span><h1>{selected.name}<small><i className={isRunning ? "is-busy" : ""} />{isRunning ? "正在处理" : provider ? "模型已配置" : "待配置"}</small></h1></div><div className="ai-room__head-actions"><button aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"} onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button><button aria-label={panelOpen ? "收起操作面板" : "展开操作面板"} aria-expanded={panelOpen} onClick={() => setPanelOpen((value) => !value)}><SidebarSimple size={18} /></button></div></header>
      <div className="ai-room__messages" ref={scroll} aria-label={`${selected.name}的对话`}>
        {!blocks.some((block) => block.kind === "user" || block.kind === "assistant") && <div className="ai-room__empty"><Avatar id={selected.id} mark={selected.mark} active listening={voice.recording} /><span>{treasure ? "A PLACE FOR YOUR MEMORIES" : "YOUR EVERYDAY COMPANION"}</span><h2>{treasure ? "想找回哪一刻？" : selected.greeting}</h2><p>{treasure ? "找一张照片，留下一个瞬间，或者把成长的故事慢慢串起来。" : selected.hint}</p><div className="ai-room__starters">{(treasure ? ["找照片：海边", "帮我挑选值得保留的照片", "把孩子 0 到 18 岁的照片串成成长影片"] : ["帮我理清今天最重要的事", "把这个想法拆成可执行步骤", "帮我整理一份资料清单"]).map((text) => <button key={text} onClick={() => useDraft(text)}>{text}<span>↗</span></button>)}</div></div>}
        {messages}{isRunning && <div className="ai-room__thinking" role="status"><CircleNotch className="room-spin" size={16} />{selected.name}正在想…</div>}
        {treasure && <section className="treasure-scenes" aria-label="选择照片场景"><span>{suggestion ? "这次，可以这样继续" : "你想怎样打开这段回忆？"}</span><div>{TREASURE_SCENES.map((scene) => <button key={scene.id} aria-pressed={treasureScene === scene.id} className={treasureScene === scene.id ? "is-selected" : ""} onClick={() => chooseScene(scene.id)}><b>{scene.title}{suggestion === scene.id && <em>建议</em>}</b><small>{scene.hint}</small></button>)}</div></section>}
        {treasure && pending.length > 0 && <button className="ai-room__approval-reminder" onClick={() => { setTreasureOpen(false); setPanelOpen(true); }}>{pending.length} 项操作待你确认 · 打开操作面板</button>}
      </div>
      <div className="ai-room__composer-area">
        {treasure ? <RoomProgressSummary blocks={blocks} local={photoProgress} running={isRunning} /> : activity.length > 0 && <div className="ai-room__activity" aria-label="处理进度" aria-live="polite">{activity.map((item) => <div key={item.id}><i />{item.text}</div>)}</div>}
        {notice && <p className="ai-room__notice" role="status">{notice}</p>}
        {!treasure && <div className="ai-room__selectors"><label><Robot size={14} /><select aria-label="当前 Agent 执行器" value={engine} disabled={isRunning || saving || !agent} onChange={(event) => void changeConfig({ engine: event.target.value as api.AgentEngine })}><option value="pi">Pi Agent</option><option value="deepseek-harness">DeepSeek Harness</option></select></label><select aria-label="当前 Agent 模型" value={providerName} disabled={isRunning || saving || !agent} onChange={(event) => void changeConfig({ provider_name: event.target.value })}>{!providerName && <option value="">选择模型</option>}{Object.entries(settings.providers).map(([name, config]) => <option key={name} value={name}>{name} · {config.model}</option>)}</select></div>}
        <div className="ai-room__input"><textarea ref={input} rows={2} aria-label={`和${selected.name}聊天`} placeholder={voice.recording ? "正在聆听，停止后文字会填入草稿…" : `和${selected.name}说说你想做什么…`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (submitsChat(event.key, event.shiftKey, event.nativeEvent.isComposing)) { event.preventDefault(); void send(); } }} /><div className="ai-room__input-actions"><button type="button" aria-label={voice.recording ? "停止录音并识别" : "语音输入"} className={voice.recording ? "is-recording" : ""} disabled={voice.transcribing} onClick={() => voice.recording ? void voice.stop() : void voice.start()}>{voice.transcribing ? <CircleNotch className="room-spin" size={19} /> : voice.recording ? <Stop size={19} /> : <Microphone size={19} />}</button>{isRunning ? <button aria-label="停止回复" onClick={() => void onAbort(selected.id)}><Stop size={18} weight="fill" /></button> : <button className="ai-room__send" aria-label="发送消息" disabled={!draft.trim() || saving || !provider || !agreed || voice.transcribing} onClick={() => void send()}><ArrowUp size={20} weight="bold" /></button>}</div></div>
        {!provider ? <button className="ai-room__setup-link" onClick={() => setSettingsOpen(true)}>先配置一个大模型，再开始聊天 →</button> : !isBuiltinProvider(provider) ? <label className="ai-room__consent"><input type="checkbox" checked={agreed} onChange={(event) => setConsents((items) => ({ ...items, [selected.id]: event.target.checked ? target : "" }))} />同意将本次对话发送给 {providerName}</label> : null}
        <div className="ai-room__input-hint"><span>{provider && !modelAllowed ? "本地模式：请在模型配置中选择本机服务" : "语音在本机识别，文字先填入草稿"}</span><span>Enter 发送 · Shift + Enter 换行</span></div>
      </div>
    </section>
    {treasure ? <TreasurePanel key={`${root}:${selected.id}`} hidden={!panelOpen} scene={treasureScene} query={photoQuery} services={photoServices} onScene={chooseScene} onProgress={setPhotoProgress} onOpenHome={onOpenHome} onQuery={setPhotoQuery} chatMessage={recentUser} /> : panelOpen && <aside className="ai-room__inspector" aria-label="操作面板">
      <div className="ai-room__resize" role="separator" aria-label="调整操作面板宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); setPanelWidth((value) => Math.min(440, value + 20)); } if (event.key === "ArrowRight") { event.preventDefault(); setPanelWidth((value) => Math.max(280, value - 20)); } }} onPointerDown={(event) => {
        const element = event.currentTarget, start = event.clientX, width = panelWidth; let next = width;
        element.setPointerCapture(event.pointerId);
        element.onpointermove = (move) => { next = Math.max(280, Math.min(440, width + start - move.clientX)); if (frame.current) cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => room.current?.style.setProperty("--room-panel", `${next}px`)); };
        const finish = () => { if (frame.current) cancelAnimationFrame(frame.current); setPanelWidth(next); element.onpointermove = null; element.onpointerup = null; element.onpointercancel = null; };
        element.onpointerup = finish; element.onpointercancel = finish;
      }} />
      <header><div><span>LIVE CONTEXT</span><h2>操作面板</h2></div><button aria-label="关闭操作面板" onClick={() => setPanelOpen(false)}><X size={18} /></button></header>
      <div className="ai-room__inspector-scroll">
        <section className="ai-room__attention"><span><ShieldCheck size={22} /></span><div><b>{pending.length ? `${pending.length} 项操作等你确认` : isRunning ? `${selected.name}正在处理` : "由你掌握节奏"}</b><p>{pending.length ? "先查看操作范围，再决定是否允许。" : "需要补充、确认和继续处理的内容，会出现在这里。"}</p></div></section>
        {pending.length > 0 && <section className="ai-room__panel-section"><h3>待确认操作</h3>{pending.map((card) => <article className="ai-room__approval" key={card.id}><b>{card.title}</b><p>{card.summary}</p><details><summary>查看操作详情</summary><pre>{JSON.stringify(card.preview, null, 2)}</pre></details><div><button disabled={!!acting} onClick={() => void decide(card, "deny")}>拒绝</button><button disabled={!!acting} onClick={() => void decide(card, "approve")}><Check size={14} />允许本次操作</button></div></article>)}</section>}
        <section className="ai-room__panel-section"><h3>本轮线索 <small>点击仅填入草稿</small></h3>{clues.length ? clues.map((text, index) => <button className="ai-room__clue" key={text} onClick={() => useDraft(`关于「${text}」，请进一步说明。`)}><span>{String(index + 1).padStart(2, "0")}</span><b>{text}</b><span>↗</span></button>) : <div className="ai-room__panel-empty"><span>✧</span><p>聊起来之后，<br />这里会整理值得继续追问的线索。</p></div>}</section>
        {tasks.length > 0 && <section className="ai-room__panel-section"><h3>协作任务</h3>{tasks.map((task) => <article className="ai-room__task" key={task.id}><small>{task.from_label} → {task.to_label} · {{ queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消" }[task.status]}</small><p>{task.instruction}</p>{(task.status === "queued" || task.status === "running") && onCancelTask && <button onClick={() => void onCancelTask(task.id).catch(() => setNotice("未能取消任务，请重试。"))}>取消任务</button>}</article>)}</section>}
        <section className="ai-room__panel-section"><h3>接下来</h3>{["把刚才的内容整理成清单", "还有哪些地方需要我确认？"].map((text) => <button className="ai-room__prompt" key={text} onClick={() => useDraft(text)}>{text}<span>＋</span></button>)}</section>
        <section className="ai-room__panel-section ai-room__connection"><h3>当前连接</h3><b>{provider?.model ?? "尚未配置模型"}</b><p>{engine === "deepseek-harness" ? "DeepSeek Harness" : "Pi Agent"} · {providerName || "请选择 Provider"}</p><small title={root}>{root}</small><button onClick={onOpenHome}>打开完整工作台 ↗</button></section>
      </div><footer><LockKey size={13} />文件与外部操作仍受原有权限和审批约束</footer>
    </aside>}
    {settingsOpen && <div className="ai-room__modal-backdrop"><section className="ai-room__model-dialog" role="dialog" aria-modal="true" aria-label={`配置${selected.name}的模型`}><header><div><b>{selected.name} · 模型连接</b><small>保存到本机加密凭据服务</small></div><button aria-label="关闭模型配置" onClick={() => setSettingsOpen(false)}><X size={20} /></button></header><div className="jiaho-entry"><AiOsModelSetup variant="room" mode={connectionMode} agentId={selected.id} language="zh-CN" onSaved={async () => onSaveSettings(await api.settingsGet())} onReady={() => { setSettingsOpen(false); setNotice("模型配置已保存。实际可用性以连接测试或对话结果为准。"); }} /></div></section></div>}
  </main>;
}
