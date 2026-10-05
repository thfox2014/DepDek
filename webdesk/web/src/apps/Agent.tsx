import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AgentChatMessage, type AgentId, type AgentProvider, type AgentProviderDraft, type AgentProviderProtocol, type AgentStatus } from "../api";
import Markdown from "../components/Markdown";
import WukongMosaic from "../components/WukongMosaic";

type ChatEntry = AgentChatMessage & { id: string; kind?: "error" };
type SpeechRecognitionResult = { 0: { transcript: string }; isFinal: boolean };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<SpeechRecognitionResult>; resultIndex: number }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const AGENTS: Array<{ id: AgentId; name: string; title: string; mark: string; line: string }> = [
  { id: "wukong", name: "悟空", title: "探索与统筹", mark: "悟", line: "眼明手快，陪你把问题拆开" },
  { id: "bajie", name: "八戒", title: "资料与执行", mark: "戒", line: "接住琐事，把事情办妥" },
  { id: "master", name: "师傅", title: "分析与指引", mark: "师", line: "先看清来路，再决定方向" },
  { id: "shaseng", name: "沙僧", title: "整理与守护", mark: "僧", line: "稳稳整理，不漏每个细节" },
];

const QUICK_PROMPTS = ["把这件事拆成几步", "还有什么需要我确认？", "帮我整理成待办草稿"];
const EMPTY_PROVIDER: AgentProviderDraft = {
  id: "", name: "", base_url: "https://api.example.com/v1", protocol: "openai-completions", model: "", api_key: "",
};
const GREETINGS: Record<AgentId, string> = {
  wukong: "嗨，我在。你可以把眼前的难题交给我，我们一起找条清楚、靠谱的路。",
  bajie: "来啦！零碎材料、文件和待办都可以交给我，我会先理顺，再把结果给你过目。",
  master: "别急，我们先把已知与未知分开。你告诉我现在最挂心的事，我陪你一起推敲。",
  shaseng: "我在这里。需要整理、归纳或核对的事情，慢慢说，我会稳妥地记下来。",
};

function makeEntry(role: ChatEntry["role"], content: string, kind?: ChatEntry["kind"]): ChatEntry {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content, kind };
}

function useSpeechRecognition(onText: (text: string) => void) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const toggle = () => {
    setError("");
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const speechWindow = window as Window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setError("当前浏览器不支持语音识别，请使用软键盘输入。");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).slice(event.resultIndex)
        .filter((result) => result.isFinal).map((result) => result[0]?.transcript ?? "").join("");
      if (transcript) onText(transcript);
    };
    recognition.onerror = (event) => {
      setError(event.error === "not-allowed" ? "麦克风权限未开放，请在浏览器地址栏允许使用麦克风。" : "语音识别暂时不可用，请改用键盘输入。");
      setRecording(false);
    };
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setRecording(true);
    } catch {
      setError("无法启动语音识别，请稍后重试。");
    }
  };
  useEffect(() => () => recognitionRef.current?.stop(), []);
  return { recording, error, toggle };
}

function PersonMark({ agent, small = false }: { agent: AgentId; small?: boolean }) {
  if (agent === "wukong") return <span className={`agent-room__wukong ${small ? "is-small" : ""}`}><WukongMosaic /></span>;
  const person = AGENTS.find((item) => item.id === agent)!;
  return <span className={`agent-room__mark agent-room__mark--${agent} ${small ? "is-small" : ""}`}>{person.mark}</span>;
}

export default function Agent() {
  const [selected, setSelected] = useState<AgentId>("wukong");
  const [conversations, setConversations] = useState<Record<AgentId, ChatEntry[]>>({
    wukong: [], bajie: [], master: [], shaseng: [],
  });
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<AgentId | null>(null);
  const [notice, setNotice] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(298);
  const [resizing, setResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"harness" | "provider">("harness");
  const [modelDraft, setModelDraft] = useState("deepseek-v4-flash");
  const [harnessPath, setHarnessPath] = useState("/usr/local/bin/dsh");
  const [settingsNotice, setSettingsNotice] = useState("");
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState("");
  const [providerChoice, setProviderChoice] = useState("");
  const [providerDraft, setProviderDraft] = useState<AgentProviderDraft>({ ...EMPTY_PROVIDER });
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [activatingProvider, setActivatingProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [providerTestDraft, setProviderTestDraft] = useState("请用一句话确认模型连接正常。");
  const [providerTestReply, setProviderTestReply] = useState("");
  const [providerTestFailed, setProviderTestFailed] = useState(false);
  const [settingsNoticeKind, setSettingsNoticeKind] = useState<"info" | "success" | "error">("info");
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const selectedAgent = AGENTS.find((item) => item.id === selected)!;
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  const configuredProviders = providers.filter((provider) => provider.configured);
  const notifySettings = (message: string, kind: "info" | "success" | "error" = "info") => {
    setSettingsNotice(message);
    setSettingsNoticeKind(kind);
  };
  const messages = conversations[selected];
  const speech = useSpeechRecognition((transcript) => setDraft((current) => current ? `${current}${transcript}` : transcript));

  useEffect(() => {
    let active = true;
    api.agentStatus().then((value) => { if (active) setStatus(value); }).catch(() => {
      if (active) setStatus({ available: false, configured: false, engine: "deepseek-harness", model: "" });
    }).finally(() => { if (active) setLoadingStatus(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (status?.model) setModelDraft(status.model);
  }, [status?.model]);

  useEffect(() => {
    if (!settingsOpen) return;
    let active = true;
    api.agentProviders().then((result) => {
      if (!active) return;
      setProviders(result.providers);
      setActiveProviderId(result.active_id);
      setProviderChoice(result.active_id);
      const activeProvider = result.providers.find((provider) => provider.id === result.active_id);
      if (activeProvider) setModelDraft(activeProvider.model);
    }).catch((error) => {
      if (active) notifySettings(error instanceof Error ? error.message : "无法读取 Provider 配置", "error");
    });
    return () => { active = false; };
  }, [settingsOpen, settingsTab]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      if (!dragStart.current) return;
      setPanelWidth(Math.max(232, Math.min(430, dragStart.current.width + dragStart.current.x - event.clientX)));
    };
    const end = () => { setResizing(false); dragStart.current = null; };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.body.classList.add("agent-room-resizing");
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.body.classList.remove("agent-room-resizing");
    };
  }, [resizing]);

  const latestAssistant = [...messages].reverse().find((item) => item.role === "assistant");
  const interactionItems = useMemo(() => {
    if (!latestAssistant) return [];
    const lines = latestAssistant.content.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !/^#{1,3}\s/.test(line) && !/^```/.test(line));
    const candidates = lines.filter((line) => /^[-*+]\s|^\d+[.)、]\s/.test(line));
    const actionable = lines.filter((line) => /需要|请你|可以先|下一步|建议|确认|选择|补充|决定/.test(line));
    const source = candidates.length ? candidates : actionable.length ? actionable : lines;
    return source.slice(0, 4).map((line) => line.replace(/^([-*+]\s|\d+[.)、]\s)/, "").replace(/\*\*/g, "").slice(0, 150));
  }, [latestAssistant]);
  const needsInput = latestAssistant ? /需要|请你|确认|选择|补充|决定|授权/.test(latestAssistant.content) : false;
  const engineStatus = loadingStatus ? "正在连接" : status?.configured ? "已连接" : status?.available ? "待配置" : "未连接";

  const sendMessage = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    if (!consent) {
      setNotice("请先确认将本条消息及最近对话发送给当前 Agent 使用的模型。");
      return;
    }
    if (!status?.available || !status.configured) {
      setNotice("Agent 服务或模型尚未配置。可以继续编辑消息；连接并配置 DeepSeek Harness 后即可发送。");
      return;
    }
    const nextMessages = [...messages, makeEntry("user", message)];
    setConversations((current) => ({ ...current, [selected]: nextMessages }));
    setDraft("");
    setConsent(false);
    setNotice("");
    setBusy(selected);
    try {
      const history: AgentChatMessage[] = messages.filter((item) => item.role === "user" || item.role === "assistant")
        .slice(-8).map(({ role, content }) => ({ role, content }));
      const reply = await api.agentChat(selected, message, history);
      setConversations((current) => ({ ...current, [selected]: [...current[selected], makeEntry("assistant", reply.text)] }));
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setConversations((current) => ({ ...current, [selected]: [...current[selected], makeEntry("assistant", text, "error")] }));
    } finally {
      setBusy(null);
    }
  };

  const chooseFollowUp = (text: string) => {
    setDraft((current) => current ? `${current}\n${text}` : text);
    textareaRef.current?.focus();
  };
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    dragStart.current = { x: event.clientX, width: panelWidth };
    setResizing(true);
  };

  const editProvider = (provider?: AgentProvider) => {
    notifySettings("");
    setProviderFormOpen(true);
    setEditingProviderId(provider?.id ?? null);
    setProviderDraft(provider ? {
      id: provider.id,
      name: provider.name,
      base_url: provider.base_url,
      protocol: provider.protocol,
      model: provider.model,
      api_key: "",
    } : { ...EMPTY_PROVIDER });
  };

  const saveProvider = async () => {
    if (savingProvider) return;
    setSavingProvider(true);
    notifySettings("");
    try {
      const result = await api.saveAgentProvider(providerDraft);
      setProviders(result.providers);
      setActiveProviderId(result.active_id);
      setProviderChoice(result.active_id);
      setProviderDraft((current) => ({ ...current, api_key: "" }));
      setEditingProviderId(null);
      setProviderFormOpen(false);
      notifySettings(result.message, result.restart_ok ? "success" : "error");
      api.agentStatus().then(setStatus).catch(() => {});
    } catch (error) {
      notifySettings(error instanceof Error ? error.message : "Provider 保存失败", "error");
    } finally {
      setSavingProvider(false);
    }
  };

  const activateProvider = async (providerId: string) => {
    if (activatingProvider || !providerId || providerId === activeProviderId) return;
    setActivatingProvider(true);
    notifySettings("");
    setProviderTestReply("");
    try {
      const result = await api.activateAgentProvider(providerId);
      setProviders(result.providers);
      setActiveProviderId(result.active_id);
      setProviderChoice(result.active_id);
      const selectedProvider = result.providers.find((provider) => provider.id === result.active_id);
      if (selectedProvider) setModelDraft(selectedProvider.model);
      notifySettings(result.message, result.restart_ok ? "success" : "error");
      api.agentStatus().then(setStatus).catch(() => {});
    } catch (error) {
      notifySettings(error instanceof Error ? error.message : "无法切换 Harness 使用的 Provider", "error");
    } finally {
      setActivatingProvider(false);
    }
  };

  const testProviderConnection = async () => {
    if (testingProvider) return;
    if (!providerTestDraft.trim()) {
      notifySettings("先输入一条测试消息。", "error");
      return;
    }
    setTestingProvider(true);
    setProviderTestReply("");
    notifySettings("");
    try {
      const result = await api.agentChat("wukong", providerTestDraft.trim(), []);
      setProviderTestFailed(false);
      setProviderTestReply(`${result.provider_id || activeProviderId} · ${result.model}：${result.text}`.slice(0, 900));
    } catch (error) {
      setProviderTestFailed(true);
      setProviderTestReply(error instanceof Error ? error.message : "模型连通测试失败");
    } finally {
      setTestingProvider(false);
    }
  };

  return (
    <div className={`agent-room ${panelOpen ? "has-inspector" : "is-inspector-closed"} ${resizing ? "is-resizing" : ""}`} style={{ "--agent-panel-width": `${panelWidth}px` } as React.CSSProperties}>
      <aside className="agent-room__sidebar" aria-label="房间成员">
        <div className="agent-room__room-title"><span className="agent-room__room-icon">✦</span><div><b>西游协作室</b><small>一个房间 · 四位伙伴</small></div></div>
        <div className="agent-room__member-label">房间成员 <span>04</span></div>
        <nav className="agent-room__members" aria-label="选择 Agent">
          {AGENTS.map((agent) => {
            const selectedNow = selected === agent.id;
            const state = busy === agent.id ? "思考中" : loadingStatus ? "连接中" : status?.configured ? selectedNow ? "正在等你" : "随时待命" : status?.available ? "待配置" : "未连接";
            return <button key={agent.id} className={`agent-room__member ${selectedNow ? "is-selected" : ""}`} aria-current={selectedNow ? "page" : undefined} onClick={() => { setSelected(agent.id); setNotice(""); }}>
              <PersonMark agent={agent.id} />
              <span className="agent-room__member-copy"><b>{agent.name}</b><small>{agent.title}</small><em className={busy === agent.id ? "is-busy" : status?.configured ? "is-ready" : ""}><i />{state}</em></span>
              <span className="agent-room__unread" aria-label={`${conversations[agent.id].filter((entry) => entry.role === "assistant").length} 条回复`}>{conversations[agent.id].filter((entry) => entry.role === "assistant").length || "·"}</span>
            </button>;
          })}
        </nav>
        <div className="agent-room__sidebar-foot"><span className={`agent-room__service-dot ${status?.configured ? "is-ready" : ""}`} /><div><b>{engineStatus}</b><small>{status?.engine || "DeepSeek Harness"}{status?.model ? ` · ${status.model}` : ""}</small></div></div>
        <div className="agent-room__config-actions" aria-label="Agent 运行配置">
          <button onClick={() => { setSettingsTab("harness"); notifySettings(""); setSettingsOpen(true); }} aria-label="配置 Harness" title="Harness 配置"><span aria-hidden="true">⌘</span><small>Harness</small></button>
          <button onClick={() => { setSettingsTab("provider"); notifySettings(""); setSettingsOpen(true); }} aria-label="配置大模型 Provider" title="大模型 Provider"><span aria-hidden="true">✧</span><small>Provider</small></button>
        </div>
      </aside>

      <main className="agent-room__conversation">
        <header className="agent-room__header">
          <PersonMark agent={selected} small />
          <div className="agent-room__header-copy"><div className="agent-room__eyebrow">西游协作室 <span>·</span> 私人对话</div><h1>{selectedAgent.name}<small>{selectedAgent.title}</small></h1></div>
          <span className={`agent-room__connection ${status?.configured ? "is-online" : ""}`}><i />{busy === selected ? "正在思考" : engineStatus}</span>
        </header>

        <section className="agent-room__messages" ref={listRef} aria-label={`${selectedAgent.name}的对话`} aria-live="polite">
          <div className="agent-room__greeting"><div className="agent-room__greeting-orb"><PersonMark agent={selected} small /></div><span className="agent-room__greeting-time">刚刚</span><div><b>{selectedAgent.name}</b><p>{GREETINGS[selected]}</p><small>{selectedAgent.line}</small></div></div>
          {messages.map((entry) => <article key={entry.id} className={`agent-room__message ${entry.role === "user" ? "is-user" : ""} ${entry.kind === "error" ? "is-error" : ""}`}>
            {entry.role === "assistant" && <PersonMark agent={selected} small />}
            <div className="agent-room__bubble">{entry.role === "assistant" ? <Markdown>{entry.content}</Markdown> : <p>{entry.content}</p>}</div>
            {entry.role === "user" && <span className="agent-room__user-mark">我</span>}
          </article>)}
          {busy === selected && <div className="agent-room__thinking"><PersonMark agent={selected} small /><span><b>{selectedAgent.name}正在想</b><i /><i /><i /></span></div>}
        </section>

        {(notice || speech.error) && <div className="agent-room__notice" role="status">{notice || speech.error}</div>}
        <form className="agent-room__composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <div className="agent-room__consent"><label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>我同意将消息和最近对话发送给已配置的模型</span></label><span>语音可能经浏览器服务处理 · 不自动执行外部操作</span></div>
          <div className="agent-room__input-shell">
            <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={`和${selectedAgent.name}说说话…`} aria-label="输入消息" rows={2} />
            <div className="agent-room__input-actions"><button type="button" className={`agent-room__mic ${speech.recording ? "is-recording" : ""}`} aria-label={speech.recording ? "停止语音输入" : "开始语音输入（语音识别可能经浏览器服务处理）"} title="语音识别可能使用浏览器服务处理音频；结果只填入草稿" onClick={speech.toggle}><MicGlyph recording={speech.recording} /></button><button className="agent-room__send" aria-label="发送消息" disabled={!draft.trim() || busy !== null}><SendGlyph /></button></div>
          </div>
          <div className="agent-room__input-hint"><span>语音识别的文字只填入草稿，由你确认后发送</span><span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span></div>
        </form>
      </main>

      {panelOpen && <>
        <button className="agent-room__splitter" onPointerDown={startResize} onKeyDown={(event) => { if (event.key === "ArrowLeft") setPanelWidth((width) => Math.min(430, width + 16)); if (event.key === "ArrowRight") setPanelWidth((width) => Math.max(232, width - 16)); }} aria-label="拖动调整交互面板宽度" title="拖动调整面板宽度" />
        <aside className="agent-room__inspector" aria-label="对话交互面板">
          <header className="agent-room__inspector-head"><div><span className="agent-room__eyebrow">LIVE CONTEXT</span><h2>交互面板</h2></div><button className="agent-room__collapse" onClick={() => setPanelOpen(false)} aria-label="收起交互面板" title="收起面板">›</button></header>
          <section className={`agent-room__attention ${needsInput ? "needs-input" : ""}`}><span className="agent-room__attention-icon">{needsInput ? "!" : "✓"}</span><div><b>{needsInput ? "等你来决定" : latestAssistant ? "对话已更新" : "等你开个头"}</b><p>{needsInput ? "回复中可能包含需要你补充或确认的内容。" : latestAssistant ? "我把这轮对话里值得接着聊的部分放在这里。" : "你发起对话后，这里会整理跟进线索。"}</p></div></section>
          <section className="agent-room__inspector-section"><div className="agent-room__section-title"><b>本轮线索</b><span>{interactionItems.length ? `${interactionItems.length} 条` : "等待对话"}</span></div>
            {interactionItems.length ? <div className="agent-room__clues">{interactionItems.map((item, index) => <button key={`${index}-${item}`} className="agent-room__clue" onClick={() => chooseFollowUp(`关于“${item}”，`)}><i>{String(index + 1).padStart(2, "0")}</i><span>{item}</span><b>↗</b></button>)}</div> : <div className="agent-room__empty-clue"><span>✧</span><p>从对话中提取待确认事项、下一步和关键细节。点击线索可直接继续追问。</p></div>}
          </section>
          <section className="agent-room__inspector-section"><div className="agent-room__section-title"><b>继续聊</b><span>仅填入草稿</span></div><div className="agent-room__prompts">{QUICK_PROMPTS.map((prompt) => <button key={prompt} onClick={() => chooseFollowUp(prompt)}>{prompt}<span>＋</span></button>)}</div></section>
          <section className="agent-room__guardrail"><span>◇</span><p><b>由你掌握节奏</b><br />面板不会执行删除、发送、移动等操作；任何外部动作仍需你在对应应用中确认。</p></section>
          <footer className="agent-room__inspector-foot"><span className={`agent-room__service-dot ${status?.configured ? "is-ready" : ""}`} />{status?.configured ? `${status.engine} · ${status.model}` : "本地 Agent 服务未配置"}</footer>
        </aside>
      </>}
      {!panelOpen && <button className="agent-room__reopen" onClick={() => setPanelOpen(true)} aria-label="展开交互面板">‹<span>交互面板</span></button>}

      {settingsOpen && <div className="agent-config__scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="agent-config" role="dialog" aria-modal="true" aria-labelledby="agent-config-title">
          <header className="agent-config__head">
            <div><span className="agent-room__eyebrow">AGENT RUNTIME</span><h2 id="agent-config-title">执行与模型配置</h2><p>查看当前执行器，并生成服务端配置模板。</p></div>
            <button className="agent-config__close" onClick={() => setSettingsOpen(false)} aria-label="关闭配置">×</button>
          </header>
          <div className="agent-config__tabs" role="tablist" aria-label="配置类别">
            <button role="tab" aria-selected={settingsTab === "harness"} className={settingsTab === "harness" ? "is-active" : ""} onClick={() => setSettingsTab("harness")}>Harness 执行器</button>
            <button role="tab" aria-selected={settingsTab === "provider"} className={settingsTab === "provider" ? "is-active" : ""} onClick={() => setSettingsTab("provider")}>大模型 Provider</button>
          </div>
          {settingsNotice && <p className={`agent-config__notice is-${settingsNoticeKind}`} role={settingsNoticeKind === "error" ? "alert" : "status"}>{settingsNotice}</p>}
          {settingsTab === "harness" ? <div className="agent-config__content">
            <div className="agent-config__runtime-card"><span className="agent-config__runtime-icon">⌘</span><div><b>DeepSeek Harness</b><small>{status?.available ? "本机服务已连接" : "等待本机 Agent 服务"} · 受限执行配置</small></div><i className={status?.available ? "is-ready" : ""}>{status?.available ? "已接入" : "未连接"}</i></div>
            <p className="agent-config__note">当前 Webdesk 后台接入 DeepSeek Harness。执行器在服务器端启动，聊天页面不会获得文件、Shell 或外部工具权限。</p>
            <section className="agent-config__binding" aria-label="Harness 模型绑定">
              <div className="agent-config__binding-head"><b>执行器当前模型</b><span>DeepSeek Harness</span></div>
              <div className="agent-config__binding-row">
                <select aria-label="选择 Harness 使用的 Provider" value={providerChoice || activeProviderId} onChange={(event) => setProviderChoice(event.target.value)} disabled={activatingProvider || configuredProviders.length === 0}>
                  {!configuredProviders.length && <option value="">先在 Provider 页面保存模型</option>}
                  {configuredProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
                </select>
                <button onClick={() => void activateProvider(providerChoice || activeProviderId)} disabled={activatingProvider || !providerChoice || providerChoice === activeProviderId}>{activatingProvider ? "正在切换…" : "应用到执行器"}</button>
              </div>
              <small>切换后服务端会重启 Agent；西游房间里的新对话将使用所选模型。</small>
            </section>
            <section className="agent-config__test" aria-label="模型连通性测试">
              <div className="agent-config__test-head"><div><b>测试对话</b><small>消息将发给当前绑定模型；云端模型会产生少量 Token 用量。</small></div></div>
              <div className="agent-config__test-input"><input aria-label="模型测试消息" maxLength={500} value={providerTestDraft} onChange={(event) => setProviderTestDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void testProviderConnection(); } }} placeholder="输入一条简短测试消息" /><button onClick={() => void testProviderConnection()} disabled={testingProvider || activatingProvider || !activeProvider?.configured}>{testingProvider ? "正在请求…" : "发送测试消息"}</button></div>
              {providerTestReply && <div className={`agent-config__test-result ${providerTestFailed ? "is-error" : "is-success"}`} role={providerTestFailed ? "alert" : "status"}>{providerTestReply}</div>}
            </section>
            <label className="agent-config__field"><span>Harness 命令路径</span><input value={harnessPath} onChange={(event) => setHarnessPath(event.target.value)} spellCheck={false} /></label>
            <p className="agent-config__hint">将路径写入服务器的 <code>DEPDEK_DSH_COMMAND</code>，然后重启 <code>depdek-agent</code> 服务。</p>
            <button className="agent-config__copy" onClick={() => void copyRuntimeConfig()}><span>复制 Harness 配置模板</span><b>复制</b></button>
          </div> : <div className="agent-config__content">
            <div className="agent-config__runtime-card"><span className="agent-config__runtime-icon agent-config__runtime-icon--model">✧</span><div><b>{activeProvider?.name || "尚未选择模型 Provider"}</b><small>{activeProvider?.model || status?.model || "添加一个模型连接"} · {activeProviderId ? `当前绑定 ${activeProviderId}` : "未绑定到执行器"}</small></div><i className={activeProvider?.configured ? "is-ready" : ""}>{activeProvider?.configured ? "已配置" : "待配置"}</i></div>
            <p className="agent-config__note">保存后 Provider 会出现在列表中；点击“应用”可绑定到 DeepSeek Harness 执行器。密钥只写入服务端，不提供读取接口，也不会在保存后回显。</p>
            <div className="agent-provider-list" aria-label="已配置的模型 Provider">
              {providers.map((provider) => <div key={provider.id} className={`agent-provider-item ${provider.id === activeProviderId ? "is-active" : ""}`}>
                <span className="agent-provider-item__status" /><span className="agent-provider-item__copy"><b>{provider.name}</b><small>{provider.id} · {provider.model}</small></span><span className="agent-provider-item__badge">{provider.id === activeProviderId ? "执行中" : provider.configured ? "已保存" : "缺密钥"}</span>
                <span className="agent-provider-item__actions"><button onClick={() => provider.id === activeProviderId ? undefined : void activateProvider(provider.id)} disabled={!provider.configured || provider.id === activeProviderId || activatingProvider}>{provider.id === activeProviderId ? "当前执行器" : "应用"}</button><button onClick={() => editProvider(provider)}>编辑</button></span>
              </div>)}
              {!providers.length && <p className="agent-provider-empty">尚无已保存的 Provider。新增后将安全保存至设备。</p>}
            </div>
            <section className="agent-config__test" aria-label="模型连通性测试">
              <div className="agent-config__test-head"><div><b>测试当前执行模型</b><small>会通过 Harness 发送消息并产生相应 Token 用量。</small></div></div>
              <div className="agent-config__test-input"><input aria-label="模型测试消息" maxLength={500} value={providerTestDraft} onChange={(event) => setProviderTestDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void testProviderConnection(); } }} placeholder="输入一条简短测试消息" /><button onClick={() => void testProviderConnection()} disabled={testingProvider || activatingProvider || !activeProvider?.configured}>{testingProvider ? "正在请求…" : "发送测试消息"}</button></div>
              {providerTestReply && <div className={`agent-config__test-result ${providerTestFailed ? "is-error" : "is-success"}`} role={providerTestFailed ? "alert" : "status"}>{providerTestReply}</div>}
            </section>
            {providerFormOpen ? <div className="agent-provider-form">
              <div className="agent-provider-form__heading"><b>{editingProviderId ? "编辑 Provider" : "新增模型 Provider"}</b>{editingProviderId && <small>ID 固定；留空密钥表示保留现有密钥</small>}</div>
              <div className="agent-provider-form__grid">
                <label className="agent-config__field"><span>Provider ID</span><input value={providerDraft.id} disabled={editingProviderId !== null} onChange={(event) => setProviderDraft((current) => ({ ...current, id: event.target.value.toLowerCase() }))} placeholder="例如 openai-compatible" autoComplete="off" /></label>
                <label className="agent-config__field"><span>显示名称</span><input value={providerDraft.name} onChange={(event) => setProviderDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如 OpenAI" autoComplete="off" /></label>
                <label className="agent-config__field agent-provider-form__wide"><span>API 基础 URL</span><input value={providerDraft.base_url} onChange={(event) => setProviderDraft((current) => ({ ...current, base_url: event.target.value }))} placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="url" /></label>
                <label className="agent-config__field"><span>API 协议</span><select value={providerDraft.protocol} onChange={(event) => setProviderDraft((current) => ({ ...current, protocol: event.target.value as AgentProviderProtocol }))}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
                <label className="agent-config__field"><span>模型 ID</span><input value={providerDraft.model} onChange={(event) => setProviderDraft((current) => ({ ...current, model: event.target.value }))} placeholder="例如 deepseek-v4-flash" spellCheck={false} autoComplete="off" /></label>
                <label className="agent-config__field agent-provider-form__wide"><span>API Key {editingProviderId ? "（可选，替换时填写）" : ""}</span><input type="password" value={providerDraft.api_key} onChange={(event) => setProviderDraft((current) => ({ ...current, api_key: event.target.value }))} placeholder={editingProviderId ? "留空保留已保存的密钥" : "仅本次提交，不会保存到浏览器"} autoComplete="new-password" spellCheck={false} /></label>
              </div>
              <div className="agent-provider-form__actions"><button className="agent-provider-cancel" onClick={() => { setProviderFormOpen(false); setProviderDraft({ ...EMPTY_PROVIDER }); setEditingProviderId(null); }}>取消</button><button className="agent-provider-save" disabled={savingProvider || !providerDraft.id.trim() || !providerDraft.name.trim() || !providerDraft.model.trim() || !providerDraft.base_url.trim() || (!editingProviderId && !providerDraft.api_key)} onClick={() => void saveProvider()}>{savingProvider ? "安全保存中…" : "保存并启用"}</button></div>
            </div> : <button className="agent-config__copy" onClick={() => editProvider()}><span>添加模型 Provider</span><b>＋ 新增</b></button>}
            <div className="agent-config__security"><span>盾</span><p>管理员登录后由专用配置服务保存密钥；Webdesk 不直接写密钥文件，不提供读取接口。保存成功后密钥立即从表单清空。</p></div>
          </div>}
        </section>
      </div>}
    </div>
  );

  async function copyRuntimeConfig() {
    const model = modelDraft.trim() || "deepseek-v4-flash";
    const command = harnessPath.trim() || "/usr/local/bin/dsh";
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(model)) {
      notifySettings("模型 ID 仅支持字母、数字、点、下划线和短横线。", "error");
      return;
    }
    if (/[\r\n=]/.test(command)) {
      notifySettings("Harness 路径不能包含换行或等号。", "error");
      return;
    }
    const template = [
      "# /etc/depdek/agent.env — 在设备本机安全编辑后重启 depdek-agent",
      `DEPDEK_DSH_COMMAND=${command}`,
      `DEPDEK_AGENT_MODEL=${model}`,
      "# DEEPSEEK_API_KEY=仅在受保护的服务器环境中填写，不要粘贴到网页或聊天中",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(template);
      notifySettings("配置模板已复制。请在服务器受保护的环境文件中应用并重启 depdek-agent。", "success");
    } catch {
      notifySettings("浏览器未授予剪贴板权限；请检查本机 /etc/depdek/agent.env 配置。", "error");
    }
  }
}

function MicGlyph({ recording }: { recording: boolean }) {
  return recording ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8" /></svg>;
}

function SendGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.2 18-3.7-7.1L3 10.2 21 3Z" /><path d="M10.1 13.9 15 9" /></svg>;
}
