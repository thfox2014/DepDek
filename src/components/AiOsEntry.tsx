import { ArrowRight, Check, CircleNotch, Eye, EyeSlash, LockKey, PaperPlaneTilt, Sparkle } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
import { APP_VERSION } from "../version";
import logo from "../assets/jiaho-boot-logo.png";
import MarkdownText from "./MarkdownText";
import "./ai-os-entry.css";

type Welcome = {
  enabled: boolean; initialized: boolean; authenticated: boolean; configured: boolean;
  username: string | null; balance: number; grant_points: number; chat_cost: number; model_ready?: boolean;
  preferences?: { display_name: string; language: string; purpose: string };
};
type Message = { role: "user" | "assistant"; text: string };
const ERRORS: Record<string, string> = {
  LOGIN_FAILED: "账号或密码不正确，请再试一次。", LOGIN_RATE_LIMITED: "尝试次数较多，请稍等 30 秒再登录。",
  INVALID_INPUT: "请检查输入。账号用 3–32 位字母、数字、_ 或 -，密码至少 12 位。",
  CONFLICT: "这次操作已完成或内容已变化，请刷新后继续。", LOGIN_REQUIRED: "空间已锁定，请重新登录。",
  LOCAL_MODEL_UNAVAILABLE: "本地助手还在准备或暂时无法连接，这次积分已退回。你也可以先填写右侧配置。",
  MODEL_OUTCOME_UNKNOWN: "这次回复未能确认，请不要重复发送同一请求。可稍后发起新的对话。",
  CREDITS_EXHAUSTED: "配置体验积分已用完。你仍可手动完成配置，进入工作台连接自己的模型。",
  WELCOME_STORE_UNAVAILABLE: "无法打开本机账号数据，请检查用户目录空间与权限。",
  AUDIT_UNAVAILABLE: "操作记录暂时无法保存，请检查磁盘空间后重试。",
};
function message(error: unknown) { const code = String(error); return ERRORS[code] || "暂时无法完成操作，请重试。"; }

export default function AiOsEntry({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Welcome | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [name, setName] = useState("我的家");
  const [language, setLanguage] = useState("zh-CN");
  const [purpose, setPurpose] = useState("family");
  const scroll = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    setError("");
    try { setStatus(await invoke<Welcome>("ai_os_status")); }
    catch { setError("无法连接本机登录服务，请在 Jiaho AI-OS 应用内打开，或重试连接。"); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  const login = async (event: FormEvent) => {
    event.preventDefault(); if (!status || busy) return;
    if (!status.initialized && password !== repeat) { setError("两次输入的密码不一致。"); return; }
    setBusy(true); setError("");
    try {
      const next = await invoke<Welcome>(status.initialized ? "ai_os_login" : "ai_os_register", { username, password });
      setPassword(""); setRepeat(""); setStatus(next);
      const fresh = await invoke<Welcome>("ai_os_status"); setStatus(fresh);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const send = async (text: string) => {
    if (!text.trim() || busy || !status) return;
    setBusy(true); setError(""); setDraft("");
    setMessages((items) => [...items, { role: "user", text }]);
    try {
      const result = await invoke<{ reply: string; balance: number }>("ai_os_chat", { operationId: crypto.randomUUID(), prompt: text });
      setMessages((items) => [...items, { role: "assistant", text: result.reply }]);
      setStatus((current) => current ? { ...current, balance: result.balance, model_ready: true } : current);
    } catch (e) { setError(message(e)); await invoke<Welcome>("ai_os_status").then(setStatus).catch(() => {}); }
    finally { setBusy(false); }
  };
  const finish = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try {
      const settings = await api.settingsGet();
      if (settings.last_root) await api.vaultSetRoot(settings.last_root);
      else await api.vaultInitHome();
      if (!Object.keys(settings.providers).length) {
        const provider = "Jiaho 本地助手";
        await api.settingsSet({ ...settings, providers: { [provider]: { kind: "openai-compatible", base_url: "http://127.0.0.1:11435/v1", model: "jiaho-setup" } }, agents: [{ id: "depdek-os-assistant", label: "家合助手", provider_name: provider, engine: "pi", system_prompt: language === "en" ? "You are Jiaho, a helpful family AI setup assistant. Reply in English." : "你是家合，一个亲切可靠的家庭 AI 配置助手，请用简体中文交流。", enabled_skills: [] }] });
      }
      setStatus(await invoke<Welcome>("ai_os_complete", { displayName: name.trim(), language, purpose }));
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  if (status && (!status.enabled || status.authenticated && status.configured)) return <>{children}</>;
  const initial = status && !status.initialized;
  return <main className={`jiaho-entry ${status?.authenticated ? "jiaho-entry--setup" : ""}`}>
    <div className="jiaho-entry__apricot" aria-hidden="true" /><div className="jiaho-entry__mint" aria-hidden="true" />
    <header className="jiaho-entry__header"><span>家合 <small>家庭 AI 中心</small></span><span>AI-OS <small>v{APP_VERSION}</small></span></header>
    {!status || !status.authenticated ? <section className="jiaho-entry__welcome">
      <div className="jiaho-entry__brand"><img src={logo} alt="Jiaho 家合" /><p>让 AI，走进每个家。</p><span>家的资料、记忆与日常，在这里相聚。</span></div>
      <div className="jiaho-entry__account">
        {!status ? <><h1>你的家，正在准备。</h1><p>{error || "正在连接本机空间…"}</p>{error ? <button onClick={() => void refresh()}>重新连接</button> : <CircleNotch size={24} className="jiaho-spin" />}</> : <>
          <span className="jiaho-entry__eyebrow">{initial ? "HELLO, JIAHO" : "WELCOME HOME"}</span>
          <h1>{initial ? <>给你的家，<br />一个智能的开始。</> : "欢迎回家。"}</h1>
          <p>{initial ? "先创建你的本机账号，配置助手会陪你完成接下来的设置。" : "登录你的家庭空间，继续上一次的生活。"}</p>
          {initial && <div className="jiaho-entry__gift"><Sparkle size={19} weight="fill" /><span>首次登录即送 <b>{status.grant_points.toLocaleString()}</b> 配置积分</span></div>}
          <form onSubmit={(e) => void login(e)}>
            <label>账号<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" required /></label>
            <label>密码<div className="jiaho-entry__password"><input type={visible ? "text" : "password"} autoComplete={initial ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} minLength={initial ? 12 : 1} maxLength={1024} placeholder={initial ? "至少 12 位，设置你自己的密码" : "输入你的密码"} required /><button type="button" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeSlash size={20} /> : <Eye size={20} />}</button></div></label>
            {initial && <label>确认密码<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder="再输入一次密码" required /></label>}
            {error && <p className="jiaho-entry__error" role="alert">{error}</p>}
            <button className="jiaho-entry__primary" disabled={busy} type="submit">{busy ? <CircleNotch className="jiaho-spin" size={20} /> : <>{initial ? "创建账号，开启我的家" : "登录我的空间"}<ArrowRight size={19} /></>}</button>
          </form>
          <p className="jiaho-entry__private"><LockKey size={15} />本机账号 · 数据由你掌握</p>
        </>}
      </div>
    </section> : <section className="jiaho-entry__configuration">
      <div className="jiaho-entry__assistant">
        <div className="jiaho-entry__assistant-heading"><img src={logo} alt="Jiaho" /><div><span className="jiaho-entry__eyebrow">LET'S MAKE IT YOURS</span><h1>一起把家，安顿好。</h1></div></div>
        <p className="jiaho-entry__intro">我是你的本地配置助手。说说你的需要，我们从最有用的一步开始。</p>
        <div className="jiaho-entry__conversation" ref={scroll} aria-live="polite">
          {!messages.length && <><p>账号已经准备好了，<b>{status.grant_points.toLocaleString()} 配置积分</b>也已到账。你可以问我，也可以直接填写右侧的偏好。</p><div className="jiaho-entry__suggestions">{["第一次使用，我应该先配置什么？", "我想整理家里的照片，怎么开始？", "怎样连接我自己的云端 AI？"].map((text) => <button key={text} disabled={busy} onClick={() => void send(text)}>{text}<ArrowRight size={16} /></button>)}</div></>}
          {messages.map((item, i) => <div key={i} className={`jiaho-entry__message is-${item.role}`}><small>{item.role === "user" ? "你" : "家合助手"}</small><MarkdownText markdown={item.text} /></div>)}
          {busy && <div className="jiaho-entry__thinking"><CircleNotch size={16} className="jiaho-spin" />正在本机想一想…</div>}
        </div>
        {error && <p className="jiaho-entry__error" role="alert">{error}</p>}
        <form className="jiaho-entry__composer" onSubmit={(e) => { e.preventDefault(); void send(draft); }}><textarea aria-label="向配置助手提问" placeholder="告诉我，你想让 AI 帮家里做些什么？" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} disabled={busy} /><button type="submit" disabled={busy || !draft.trim()} aria-label="发送"><PaperPlaneTilt size={23} /></button></form>
        <div className="jiaho-entry__usage"><span><i />本地 AI · 每次 {status.chat_cost} 积分</span><span>剩余 <b>{status.balance.toLocaleString()}</b> 积分</span></div>
      </div>
      <form className="jiaho-entry__preferences" onSubmit={(e) => void finish(e)}>
        <span className="jiaho-entry__eyebrow">YOUR FIRST SPACE</span><h2>让这里，更像你的家。</h2><p>以后可以随时调整。</p>
        <label>怎么称呼这个空间<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required /></label>
        <label>助手交流语言<select value={language} onChange={(e) => setLanguage(e.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <fieldset><legend>你想先从哪里开始？</legend>{[["family", "家庭资料与日常"], ["photos", "照片与家庭记忆"], ["documents", "文档与个人工作"]].map(([value, label]) => <label className="jiaho-entry__choice" key={value}><input type="radio" value={value} checked={purpose === value} onChange={() => setPurpose(value)} /><span>{label}</span>{purpose === value && <Check size={18} />}</label>)}</fieldset>
        <div className="jiaho-entry__local"><span className="jiaho-entry__eyebrow">已为你准备</span><p><Check size={16} />本机账号与家庭空间</p><p><Check size={16} />{status.grant_points.toLocaleString()} 配置体验积分</p><p><span className={`jiaho-entry__model-dot ${status.model_ready ? "is-ready" : ""}`} />{status.model_ready ? "默认本地 AI 已连接" : "本地 AI 启动中，可先完成配置"}</p><button type="button" onClick={() => void refresh()} disabled={busy}>刷新模型状态</button></div>
        <button type="submit" className="jiaho-entry__primary" disabled={busy || !name.trim()}>保存，进入我的家<ArrowRight size={18} /></button>
      </form>
    </section>}
    <footer className="jiaho-entry__footer"><span>AI, at home.</span><span>你的空间 · 你的选择</span></footer>
  </main>;
}
