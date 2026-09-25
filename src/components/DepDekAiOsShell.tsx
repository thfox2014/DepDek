import { ArrowUp, Check, CircleNotch, Database, Gear, Microphone, ShieldCheck, Sparkle, Stop, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatBlock, SessionInfo } from "../App";
import * as api from "../api";

type Props = {
  root: string;
  settings: api.Settings;
  sessions: SessionInfo[];
  activeAgentId: string | null;
  chats: Record<string, ChatBlock[]>;
  running: Record<string, boolean>;
  onSend: (sessionId: string, text: string) => Promise<void>;
  onAbort: (sessionId: string) => Promise<void>;
  onCreateAgent: (label: string, providerName: string, id?: string, openWorkbench?: boolean) => Promise<void>;
  onSaveSettings: (settings: api.Settings) => Promise<void>;
};

const AGENT_ID = "depdek-os-assistant";
const PROVIDER_NAME = "DepDek 模型";

function encodePcmWav(samples: Float32Array, sampleRate: number): string {
  const targetRate = 16_000;
  const count = Math.floor(samples.length * targetRate / sampleRate);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
  };
  writeText(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); writeText(8, "WAVE");
  writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, "data"); view.setUint32(40, count * 2, true);
  for (let index = 0; index < count; index++) {
    const position = index * sampleRate / targetRate;
    const left = Math.floor(position);
    const fraction = position - left;
    const a = samples[Math.min(left, samples.length - 1)] ?? 0;
    const b = samples[Math.min(left + 1, samples.length - 1)] ?? a;
    const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function providerFields(provider?: api.ProviderConfig) {
  if (!provider) return { endpoint: "http://127.0.0.1:11434/v1", model: "qwen3:8b", apiKey: "" };
  if (provider.kind === "openai-compatible") return { endpoint: provider.base_url, model: provider.model, apiKey: provider.api_key ?? "" };
  if (provider.kind === "openai") return { endpoint: provider.base_url ?? "https://api.openai.com/v1", model: provider.model, apiKey: provider.api_key };
  return { endpoint: "https://api.anthropic.com", model: provider.model, apiKey: provider.api_key };
}

export default function DepDekAiOsShell({ root, settings, sessions, activeAgentId, chats, running, onSend, onAbort, onCreateAgent, onSaveSettings }: Props) {
  const [draft, setDraft] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(!Object.keys(settings.providers).length);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const recordingRef = useRef(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  const providerName = Object.keys(settings.providers)[0] ?? PROVIDER_NAME;
  const currentProvider = settings.providers[providerName];
  const sessionId = sessions.find((session) => session.id === AGENT_ID)?.id ?? AGENT_ID;
  const activeSessionId = activeAgentId === AGENT_ID ? AGENT_ID : sessionId;
  const currentSession = sessions.find((session) => session.id === activeSessionId);
  const isRunning = Boolean(running[activeSessionId]);
  const blocks = chats[activeSessionId] ?? [];

  useEffect(() => {
    const fields = providerFields(currentProvider);
    setEndpoint(fields.endpoint);
    setModel(fields.model);
    setApiKey(fields.apiKey);
  }, [providerName]);

  useEffect(() => () => {
    recordingRef.current = false;
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioRef.current?.close();
  }, []);

  const saveProvider = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setVoiceError("浏览器页面仅用于界面预览；请在 DepDek AI-OS 桌面端保存模型连接。");
      return undefined;
    }
    const normalizedEndpoint = endpoint.trim().replace(/\/$/, "");
    if (!normalizedEndpoint || !model.trim()) {
      setVoiceError("请填写模型服务地址和模型名称。");
      return;
    }
    setSaving(true);
    setVoiceError("");
    try {
      const provider: api.ProviderConfig = {
        kind: "openai-compatible",
        base_url: normalizedEndpoint,
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      };
      await onSaveSettings({
        ...settings,
        providers: { ...settings.providers, [PROVIDER_NAME]: provider },
      });
      setSettingsOpen(false);
      return provider;
    } catch (error) {
      setVoiceError(String(error));
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const sendDraft = async () => {
    const text = draft.trim();
    if (!text || isRunning || !settings.providers[PROVIDER_NAME] && !currentProvider) return;
    if (!("__TAURI_INTERNALS__" in window)) {
      setVoiceError("浏览器页面仅用于界面预览；请在 DepDek AI-OS 桌面端发送消息。");
      return;
    }
    setDraft("");
    setVoiceError("");
    try {
      let provider = settings.providers[PROVIDER_NAME] ?? currentProvider;
      if (!provider) {
        const updatedProvider = await saveProvider();
        if (!updatedProvider) return;
        provider = updatedProvider;
      }
      if (!provider) return;
      const agents = settings.agents ?? [];
      const saved = agents.find((agent) => agent.id === AGENT_ID);
      const next: api.Settings = {
        ...settings,
        providers: { ...settings.providers, [PROVIDER_NAME]: provider },
        agents: saved
          ? agents.map((agent) => agent.id === AGENT_ID ? { ...agent, label: "DepDek AI", provider_name: PROVIDER_NAME } : agent)
          : [...agents, { id: AGENT_ID, label: "DepDek AI", provider_name: PROVIDER_NAME }],
      };
      await onSaveSettings(next);
      if (!currentSession) await onCreateAgent("DepDek AI", PROVIDER_NAME, AGENT_ID, false);
      await onSend(AGENT_ID, text);
    } catch (error) {
      setDraft(text);
      setVoiceError(String(error));
    }
  };

  const stopAndTranscribe = async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    const audio = audioRef.current;
    const sampleRate = audio?.sampleRate ?? 16_000;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setRecording(false);
    await audio?.close().catch(() => undefined);
    audioRef.current = null;
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!length) {
      setVoiceError("没有收到录音，请检查麦克风权限后重试。");
      return;
    }
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
    setTranscribing(true);
    setVoiceError("");
    try {
      const transcript = await api.voiceTranscribe(encodePcmWav(samples, sampleRate));
      if (!transcript.trim()) setVoiceError("没有听清，请再说一次。");
      else setDraft((previous) => previous ? `${previous}${previous.endsWith(" ") ? "" : " "}${transcript}` : transcript);
      inputRef.current?.focus();
    } catch (error) {
      setVoiceError(String(error));
    } finally {
      setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (recording || transcribing) return;
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext({ sampleRate: 16_000 });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      chunksRef.current = [];
      processor.onaudioprocess = (event) => {
        if (!recordingRef.current) return;
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        event.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      streamRef.current = stream;
      audioRef.current = context;
      processorRef.current = processor;
      recordingRef.current = true;
      setRecording(true);
      timeoutRef.current = window.setTimeout(() => { void stopAndTranscribe(); }, 30_000);
    } catch (error) {
      setVoiceError(`无法启动麦克风：${String(error)}`);
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendDraft();
    }
  };

  return (
    <main className="os-shell">
      <header className="os-topbar">
        <div className="os-brand-mark"><Sparkle size={18} weight="fill" /></div>
        <div className="os-brand-name">DepDek <span>AI-OS</span></div>
        <div className="os-topbar-center"><span className="os-live-dot" /> 本地工作台已就绪</div>
        <button className="os-settings-button" onClick={() => setSettingsOpen((open) => !open)} aria-label="模型连接设置"><Gear size={19} /></button>
      </header>

      <div className="os-layout">
        <aside className="os-rail">
          <button className="os-rail-item os-rail-item--active" aria-label="AI Shell"><Sparkle size={20} weight="fill" /></button>
          <div className="os-rail-divider" />
          <div className="os-rail-caption">数据</div>
          <div className="os-rail-vault"><Database size={18} /><span>Home</span></div>
          <div className="os-rail-spacer" />
          <div className="os-rail-avatar">D</div>
        </aside>

        <section className="os-main">
          <div className="os-main-scroll">
            <div className="os-greeting"><span>DEPDek · PERSONAL WORKSPACE</span><h1>你好，<em>今天想完成什么？</em></h1><p>用自然语言描述目标，DepDek 会和你一起拆解下一步。</p></div>

            {settingsOpen && <section className="os-connect-card">
              <div className="os-connect-heading"><div><b>连接你的 AI</b><span>支持 Ollama 等 OpenAI 兼容接口</span></div><button className="os-icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭连接设置"><X size={17} /></button></div>
              <div className="os-connect-fields">
                <label>服务地址<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:11434/v1" /></label>
                <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="qwen3:8b" /></label>
                <label>访问密钥 <small>可留空</small><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="本地服务通常不需要" autoComplete="new-password" /></label>
                <button className="os-save-button" disabled={saving} onClick={() => void saveProvider()}>{saving ? <CircleNotch className="os-spin" size={16} /> : <Check size={16} />} 保存连接</button>
              </div>
              <div className="os-secret-note"><ShieldCheck size={14} /> 云服务密钥保存在当前用户的应用设置中；本地 Ollama 无需密钥。</div>
            </section>}

            {blocks.length > 0 && <div className="os-conversation" aria-live="polite">
              {blocks.map((block) => <article key={block.id} className={`os-message os-message--${block.kind}`}>
                {block.kind === "user" && <div className="os-message-label">你</div>}
                {block.kind === "assistant" && <div className="os-message-label"><Sparkle size={14} weight="fill" /> DepDek AI</div>}
                {block.kind === "error" && <div className="os-message-label">执行未完成</div>}
                {block.kind === "tool" && <div className="os-message-label">本地动作 · {block.name}</div>}
                {block.kind === "status" && <div className="os-message-label">状态</div>}
                <div className="os-message-text">{block.kind === "error" ? block.message : block.kind === "tool" ? block.preview ?? "正在处理…" : block.text}</div>
              </article>)}
              {isRunning && <div className="os-thinking"><span /><span /><span /> 正在整理思路</div>}
            </div>}

            {blocks.length === 0 && !settingsOpen && <div className="os-suggestions">
              <button onClick={() => setDraft("帮我梳理今天最重要的三件事")}>整理今天的重点 <span>↗</span></button>
              <button onClick={() => setDraft("帮我把一个想法拆成可执行步骤")}>把想法变成步骤 <span>↗</span></button>
            </div>}
          </div>

          <div className="os-composer-wrap">
            {voiceError && <div className="os-inline-error">{voiceError}</div>}
            <div className={`os-composer${recording ? " os-composer--recording" : ""}`}>
              <textarea ref={inputRef} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onInputKeyDown} placeholder={recording ? "正在聆听…点击停止后会先识别并显示文字" : "说出或输入你想做的事…"} aria-label="输入给 DepDek AI 的内容" />
              <div className="os-composer-actions">
                <div className="os-composer-hint">录音在本机识别 · 回填后由你确认发送</div>
                <div className="os-composer-buttons">
                  <button className={`os-mic-button${recording ? " os-mic-button--active" : ""}`} disabled={transcribing} onClick={() => recording ? void stopAndTranscribe() : void startRecording()} aria-label={recording ? "结束录音并识别" : "开始语音输入"} title={recording ? "结束并识别" : "开始语音输入"}>
                    {recording ? <Stop size={18} weight="fill" /> : transcribing ? <CircleNotch className="os-spin" size={18} /> : <Microphone size={19} />}
                  </button>
                  <button className="os-send-button" disabled={!draft.trim() || isRunning || transcribing || !settings.providers[PROVIDER_NAME] && !currentProvider} onClick={() => void sendDraft()} aria-label="发送"><ArrowUp size={19} weight="bold" /></button>
                </div>
              </div>
            </div>
            {isRunning && <button className="os-stop-run" onClick={() => void onAbort(activeSessionId)}>停止当前回复</button>}
          </div>
        </section>

        <aside className="os-context">
          <div className="os-context-heading">工作台 <span>01</span></div>
          <div className="os-context-card os-home-card"><div className="os-context-icon"><Database size={17} /></div><div><b>DepDek Home</b><small>个人数据空间</small></div><i /></div>
          <div className="os-context-path" title={root}>{root}</div>
          <div className="os-context-rule" />
          <div className="os-context-heading">安全状态</div>
          <div className="os-security-row"><ShieldCheck size={17} /><div><b>本机边界</b><small>录音与文件保留在本机</small></div></div>
          <div className="os-security-row"><Sparkle size={17} /><div><b>{currentProvider?.model ?? "尚未连接模型"}</b><small>{currentProvider?.kind === "openai-compatible" && currentProvider.base_url.includes("127.0.0.1") ? "本地模型服务" : currentProvider ? "已配置模型服务" : "点击设置开始配置"}</small></div></div>
          <div className="os-context-bottom"><span className="os-live-dot" /> Agent Shell <small>预览版</small></div>
        </aside>
      </div>
    </main>
  );
}
