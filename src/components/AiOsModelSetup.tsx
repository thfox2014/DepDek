import { ArrowRight, Check, CircleNotch, Cloud, Desktop, LockKey, PencilSimple, Plus, ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import logo from "../assets/jiaho-boot-logo.png";
import { isBuiltinProvider, isLocalProvider, providerAllowedForMode, providerEndpoint, saveSetupProvider, type SetupChoice, type SetupSelection, type SetupPort } from "../lib/aiOsSetup";

export type ModelSetupServices = SetupPort & { agentAnalyze: typeof api.agentAnalyze };
type Props = { modelReady?: boolean; language: string; agentId?: string; mode?: api.AiOsConnectionMode; variant?: "onboarding" | "room" | "wizard"; services?: ModelSetupServices; onBusyChange?: (busy: boolean) => void; onSaved?: () => Promise<void>; onReady: (selection: SetupSelection) => void | Promise<void> };

export default function AiOsModelSetup({ modelReady, language, agentId = "depdek-os-assistant", mode = "online", variant = "onboarding", services = api, onBusyChange, onSaved, onReady }: Props) {
  const [providers, setProviders] = useState<api.Settings["providers"]>({});
  const [choice, setChoice] = useState(modelReady ? "builtin" : "custom");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SetupSelection | null>(null);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const touched = useRef(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { let active = true; void services.settingsGet().then((settings) => {
    if (!active) return;
    setProviders(settings.providers);
    const current = settings.agents?.find((agent) => agent.id === agentId);
    if (!touched.current && current && Object.prototype.hasOwnProperty.call(settings.providers, current.provider_name) && providerAllowedForMode(settings.providers[current.provider_name], mode)) setChoice(`saved:${current.provider_name}`);
  }).catch(() => { if (active) setError("无法读取模型配置，请退出后重新登录。"); }); return () => { active = false; }; }, [agentId, mode, services]);

  const selected = choice.startsWith("saved:") ? providers[choice.slice(6)] : undefined;
  const editingProvider = editingName ? providers[editingName] : undefined;
  const editing = !!editingProvider;
  const editingFields = choice === "custom" || editing;
  const builtin = choice === "builtin" || !!selected && isBuiltinProvider(selected);
  const local = mode === "local" || builtin || (selected ? isLocalProvider(selected) : choice === "custom" && isLocalProvider({ kind: "openai-compatible", base_url: endpoint.trim(), model }));
  const destination = editing ? endpoint.trim() : choice === "custom" ? endpoint.trim() : selected ? providerEndpoint(selected) : "http://127.0.0.1:11435/v1";
  const invalidate = () => { setSaved(null); setTested(false); setError(""); };
  const choose = (value: string) => { touched.current = true; setChoice(value); setEditingName(null); setConsent(false); setApiKey(""); invalidate(); };
  const edit = (key: string, provider: api.ProviderConfig) => {
    touched.current = true; setChoice(`saved:${key}`); setEditingName(key); setName(key);
    setEndpoint(providerEndpoint(provider)); setModel(provider.model); setApiKey(""); setConsent(false); invalidate();
  };

  const save = async (test: boolean) => {
    if (inFlight.current) return;
    if (test && !builtin && !consent) { setError("测试前，请确认允许向下方显示的模型服务发送测试文本。"); return; }
    inFlight.current = true; setBusy(true); setError(""); setTested(false); setSaved(null);
    try {
      const selection: SetupChoice = choice === "builtin" ? { kind: "builtin" }
        : editingName ? { kind: "update", name: editingName, endpoint, model, apiKey }
        : choice === "custom" ? { kind: "custom", name, endpoint, model, apiKey }
        : { kind: "existing", name: choice.slice(6) };
      const stored = await saveSetupProvider(selection, services, language, agentId, mode);
      setApiKey(""); setEditingName(null); setSaved(stored); setProviders((current) => ({ ...current, [stored.name]: stored.provider })); setChoice(`saved:${stored.name}`);
      await onSaved?.();
      if (test) {
        try {
          const result = await services.agentAnalyze(stored.provider, "请只回复：连接成功。", "这是一次模型连接测试，请只返回简短文字，不调用任何工具。", "pi");
          if (!result.text.trim()) throw new Error("empty response");
          setTested(true);
        } catch { setError("配置已保存，但连接测试失败。请检查地址、模型 ID、API Key 和网络，再重试；也可以先继续配置。"); }
      }
      if (variant === "wizard" && !test) await onReady(stored);
    } catch (e) {
      // Never echo SDK/transport errors that could contain a submitted credential.
      const text = e instanceof Error ? e.message : "";
      setError(/^(请|远程|本地模式|显示名称|该模型|模型配置未|模型凭据未)/.test(text) ? text : "保存失败。请检查家庭空间和本机凭据服务，再重试。");
    } finally { inFlight.current = false; setBusy(false); }
  };

  return <section className={`jiaho-model-setup${variant !== "onboarding" ? " is-room" : ""}`}>
    {variant === "onboarding" && <div className="jiaho-model-setup__story">
      <span className="jiaho-entry__eyebrow">YOUR AI, YOUR CHOICE</span>
      <h1>先连接 AI，<br />再聊聊你的家。</h1>
      <p>一个随时可换的选择。<br />用本地助手开始，或连接你熟悉的大模型。</p>
      <img src={logo} alt="Jiaho 家合" />
      <div className="jiaho-model-setup__promise"><ShieldCheck size={22} /><span>由你选择，才会连接。<small>保存配置不会自动发送消息或家庭资料。</small></span></div>
    </div>}
    <div className="jiaho-model-setup__form">
      {variant === "onboarding" && <div className="jiaho-model-setup__step"><span>02 / 03</span><span>模型连接</span></div>}
      <h2>{variant === "wizard" ? "给悟空连接一个模型。" : "选择你的对话模型"}</h2><p>{mode === "local" ? "仅显示本机模型，地址请使用 127.0.0.1 或 ::1。" : "选择已有配置，或填入自己的模型。"}密钥加密保存，不回显。</p>
      <fieldset className="jiaho-model-setup__options" disabled={busy}>
        <legend className="jiaho-sr-only">模型来源</legend>
        {modelReady && <label className={choice === "builtin" ? "is-selected" : ""}>
          <input type="radio" name="model-source" checked={choice === "builtin"} onChange={() => choose("builtin")} />
          <Desktop size={23} /><span><b>家合本地助手</b><small>无需 API Key · 离线可用</small></span><em>{modelReady ? "本机已就绪" : "随系统启动"}</em>
        </label>}
        {Object.entries(providers).filter(([, provider]) => providerAllowedForMode(provider, mode)).map(([key, provider]) => <div className="jiaho-model-setup__saved-choice" key={key}>
          <label className={choice === `saved:${key}` ? "is-selected" : ""}>
            <input type="radio" name="model-source" checked={choice === `saved:${key}`} onChange={() => choose(`saved:${key}`)} />
            <Cloud size={23} /><span><b>{key}</b><small>{provider.model}</small></span><em>已保存</em>
          </label>
          {!isBuiltinProvider(provider) && <button type="button" className="jiaho-model-setup__edit" disabled={busy} aria-label={`编辑 ${key} 模型配置`} onClick={() => edit(key, provider)}><PencilSimple size={14} />编辑</button>}
        </div>)}
        <label className={choice === "custom" ? "is-selected" : ""}>
          <input type="radio" name="model-source" checked={choice === "custom"} onChange={() => choose("custom")} />
          <Plus size={23} /><span><b>{mode === "local" ? "连接本机模型" : "连接自己的大模型"}</b><small>OpenAI Chat Completions 兼容接口</small></span>
        </label>
      </fieldset>
      {editingFields ? <fieldset className="jiaho-model-setup__fields" disabled={busy}>
        <legend className="jiaho-sr-only">{editing ? "编辑已保存模型配置" : "自定义模型配置"}</legend>
        <label>显示名称{editing && <small>连接名称保持不变</small>}<input value={name} readOnly={editing} maxLength={64} autoComplete="off" placeholder="例如：我的云端模型" onChange={(e) => { setName(e.target.value); setConsent(false); invalidate(); }} /></label>
        <label>API 基础 URL{editingProvider?.kind === "anthropic" && <small>Anthropic 固定地址</small>}<input value={endpoint} type="url" readOnly={editingProvider?.kind === "anthropic"} autoComplete="off" placeholder={mode === "local" ? "http://127.0.0.1:11434/v1" : "https://你的模型服务/v1"} onChange={(e) => { setEndpoint(e.target.value); setConsent(false); invalidate(); }} /></label>
        <label>模型 ID<input value={model} maxLength={160} autoComplete="off" placeholder="填写服务商提供的模型 ID" onChange={(e) => { setModel(e.target.value); setConsent(false); invalidate(); }} /></label>
        <label>API Key <small>{editing ? "留空保留已保存密钥" : "本地服务可留空"}</small><input value={apiKey} type="password" autoComplete="new-password" spellCheck={false} placeholder={editing ? "输入新密钥以替换（不会回显旧密钥）" : "输入密钥，保存后不再回显"} onChange={(e) => { setApiKey(e.target.value); setConsent(false); invalidate(); }} /></label>
      </fieldset> : <div className="jiaho-model-setup__details"><span>{builtin ? "本机模型" : "模型服务地址"}</span><code>{destination}</code><small>{builtin ? "轻量配置助手，适合首次设置；可随时换成更强的模型。" : `${selected?.model ?? ""}${selected?.api_key ? " · API Key 已保存，不回显" : " · 未配置 API Key"}`}</small></div>}
      {!builtin && <label className="jiaho-model-setup__consent"><input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} /><span>允许向 <b>{destination || "上方配置的服务"}</b> 发送一条固定测试文本，不发送家庭文件。{!local && "非本机服务可能收费。"}不勾选也可以只保存配置。</span></label>}
      {!modelReady && <p className="jiaho-model-setup__hint">未检测到内置本地助手；{mode === "local" ? "请连接已启动的本机模型服务，或切换联网模式。" : "可连接本机服务或自己的云端模型。"}不会自动下载模型。</p>}
      <div className="jiaho-model-setup__security"><LockKey size={15} />API Key 通过现有本机加密凭据服务保存，不写入浏览器存储。</div>
      {error && <p className="jiaho-entry__error" role="alert">{error}</p>}
      {saved && <p className="jiaho-model-setup__saved" role="status"><Check size={17} />{tested ? "连接测试成功" : "配置已保存 · 尚未确认连接可用"}<span>{saved.name} · {saved.provider.model}</span></p>}
      <div className="jiaho-model-setup__actions">{variant !== "wizard" && <button disabled={busy} onClick={() => void save(false)}>{busy ? <CircleNotch className="jiaho-spin" size={16} /> : <Check size={16} />}{editing ? "保存修改" : "保存配置"}</button>}<button disabled={busy || !builtin && !consent} onClick={() => void save(true)}>{editing ? "保存并测试连接" : selected ? "重新测试连接" : variant === "wizard" ? "测试连接（可选）" : "保存并测试连接"}</button></div>
      {variant === "wizard" ? <button className="jiaho-entry__primary" disabled={busy} onClick={() => void save(false)}>{busy ? <CircleNotch className="jiaho-spin" size={18} /> : <>保存并继续<ArrowRight size={18} /></>}</button> : <button className="jiaho-entry__primary" disabled={busy || !saved} onClick={() => { if (saved) void onReady(saved); }}>{variant === "room" ? "完成，返回聊天" : "继续配置"}<ArrowRight size={18} /></button>}
    </div>
  </section>;
}
