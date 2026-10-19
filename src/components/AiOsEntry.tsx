import { ArrowLeft, ArrowRight, Check, CircleNotch, Cloud, Desktop, Eye, EyeSlash, Gear, Globe, LockKey, SlidersHorizontal, UserCircle, WifiHigh } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
import { APP_VERSION } from "../version";
import logo from "../assets/jiaho-boot-logo.png";
import AiOsModelSetup, { type ModelSetupServices } from "./AiOsModelSetup";
import { AiOsConnectionContext } from "./AiOsConnectionContext";
import { providerAllowedForMode, type SetupSelection } from "../lib/aiOsSetup";
import { useWelcomeNetwork } from "./useWelcomeNetwork";
import BitBayAccountSetup, { type BitBayServices } from "./BitBayAccountSetup";
import "./ai-os-entry.css";
import "./ai-os-wizard.css";

export type WelcomeServices = {
  aiOsStatus: typeof api.aiOsStatus; aiOsLogin: typeof api.aiOsLogin;
  aiOsSetConnectionMode: typeof api.aiOsSetConnectionMode;
  aiOsNetworkStatus: typeof api.aiOsNetworkStatus; aiOsOpenNetworkSettings: typeof api.aiOsOpenNetworkSettings;
  aiOsComplete: typeof api.aiOsComplete;
} & ModelSetupServices & BitBayServices;
type Step = "network" | "account" | "model" | "mode";
const STEPS = [
  { id: "network", label: "网络", hint: "检查联网状态", icon: WifiHigh },
  { id: "account", label: "账户", hint: "BitBay 邮箱注册", icon: UserCircle },
  { id: "model", label: "大模型", hint: "保存并测试连接", icon: Desktop },
  { id: "mode", label: "工作模式", hint: "联网或本地", icon: SlidersHorizontal },
] as const;
const ERRORS: Record<string, string> = {
  LOGIN_FAILED: "账号或密码不正确，请再试一次。", LOGIN_RATE_LIMITED: "尝试次数较多，请稍等 30 秒再登录。",
  INVALID_INPUT: "请检查输入。账号用 3–32 位字母、数字、_ 或 -，密码至少 12 位。",
  CONFLICT: "操作已完成或内容已变化，请重新打开应用后检查。", LOGIN_REQUIRED: "空间已锁定，请重新登录。",
  WELCOME_STORE_UNAVAILABLE: "无法保存本机配置，请检查用户目录空间与权限。",
  AUDIT_UNAVAILABLE: "操作记录暂时无法保存，请检查磁盘空间。",
  LOCAL_MODE_PROVIDER_DENIED: "当前为本地模式，请选择数值回环地址的本机模型。",
  CONNECTION_MODE_LOCKED: "工作区已经启动。请重新启动应用后，在登录页切换模式。",
  NETWORK_SETTINGS_UNAVAILABLE: "无法打开系统网络设置，请从操作系统中手动打开。",
};
function message(error: unknown) { return ERRORS[String(error)] || "暂时无法完成，请重试。"; }

/** A small real setup flow; no speculative LLM configuration reports. */
export default function AiOsEntry({ children, services = api }: { children: ReactNode; services?: WelcomeServices }) {
  const [status, setStatus] = useState<api.AiOsStatus | null>(null), [step, setStep] = useState<Step>("network");
  const [mode, setMode] = useState<api.AiOsConnectionMode>("online"), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [modelBusy, setModelBusy] = useState(false), [accountBusy, setAccountBusy] = useState(false);
  const [username, setUsername] = useState("admin"), [password, setPassword] = useState(""), [repeat, setRepeat] = useState(""), [visible, setVisible] = useState(false);
  const [name, setName] = useState("我的家"), [language, setLanguage] = useState("zh-CN"), [purpose, setPurpose] = useState("family");
  const [pendingSelection, setPendingSelection] = useState<SetupSelection | null>(null);
  const touchedMode = useRef(false), operation = useRef(false);
  const locked = busy || modelBusy || accountBusy, authenticated = Boolean(status?.authenticated), initial = Boolean(status && !status.initialized);
  const networkState = useWelcomeNetwork(services, Boolean(status?.enabled && step === "network" && !(authenticated && status?.configured)));
  const { network, busy: networkBusy, error: networkError } = networkState;
  const acceptStatus = (next: api.AiOsStatus, nextStep?: Step) => {
    setStatus(next);
    if (!touchedMode.current) setMode(next.connection_mode ?? "online");
    if (next.preferences) { setName(next.preferences.display_name || "我的家"); setLanguage(next.preferences.language || "zh-CN"); setPurpose(next.preferences.purpose || "family"); }
    if (nextStep) setStep(nextStep);
    else if (next.authenticated) setStep("network");
  };
  const refresh = async () => {
    setError("");
    try { acceptStatus(await services.aiOsStatus()); }
    catch { setError("无法连接本机服务，请在家合原生应用内打开。"); }
  };
  useEffect(() => {
    let active = true;
    void services.aiOsStatus().then((next) => { if (active) acceptStatus(next); }).catch(() => { if (active) setError("无法连接本机服务，请在家合原生应用内打开。"); });
    return () => { active = false; };
  }, [services]);

  const changeMode = async (next: api.AiOsConnectionMode) => {
    if (next === mode || operation.current || locked) return;
    touchedMode.current = true; setError("");
    if (!authenticated) { setMode(next); return; }
    operation.current = true; setBusy(true);
    try { const saved = await services.aiOsSetConnectionMode(next); setMode(saved.connection_mode ?? next); setStatus((old) => ({ ...old!, ...saved })); }
    catch (e) { setError(message(e)); } finally { setBusy(false); operation.current = false; }
  };
  const login = async (event: FormEvent) => {
    event.preventDefault(); if (!status || operation.current || locked) return;
    if (initial && password !== repeat) { setError("两次输入的密码不一致。"); return; }
    operation.current = true; setBusy(true); setError("");
    try {
      await services.aiOsLogin(username, password, initial);
      setPassword(""); setRepeat("");
      // Apply an explicit pre-login choice before allowing the workspace to mount.
      if (touchedMode.current) await services.aiOsSetConnectionMode(mode);
      acceptStatus(await services.aiOsStatus(), "account");
    } catch (e) { setError(message(e)); } finally { setBusy(false); operation.current = false; }
  };
  const acceptPlatformAccount = async (next: api.AiOsStatus) => {
    acceptStatus(next, "account");
    if (touchedMode.current) {
      try { acceptStatus(await services.aiOsSetConnectionMode(mode), "account"); }
      catch (e) { setError(message(e)); }
    }
  };
  const prepareMode = async (selection: SetupSelection) => {
    if (operation.current || !status) return;
    if (!providerAllowedForMode(selection.provider, mode)) { setError(ERRORS.LOCAL_MODE_PROVIDER_DENIED); return; }
    setPendingSelection(selection); setError(""); setStep("mode");
  };
  const finish = async () => {
    if (operation.current || !status || !pendingSelection) return;
    operation.current = true; setBusy(true); setError("");
    try {
      const saved = await services.settingsGet();
      if (!saved.providers[pendingSelection.name] || !providerAllowedForMode(saved.providers[pendingSelection.name], mode)) { setError("模型配置已变化，请返回上一步重新保存。"); return; }
      const savedMode = await services.aiOsSetConnectionMode(mode);
      const next = await services.aiOsComplete(name.trim() || "我的家", language, purpose);
      setStatus({ ...savedMode, ...next });
      setMode(savedMode.connection_mode ?? next.connection_mode ?? mode);
    } catch (e) { setError(message(e)); } finally { setBusy(false); operation.current = false; }
  };
  const goto = (next: Step) => {
    if (locked || (!authenticated && next !== "account" && next !== "network")) return;
    setStep(next); setError("");
  };

  if (status && (!status.enabled || status.authenticated && status.configured)) return <AiOsConnectionContext.Provider value={status.connection_mode ?? mode}>{children}</AiOsConnectionContext.Provider>;
  return <main className="jiaho-entry jiaho-wizard">
    <header className="jiaho-wizard__header"><div className="jiaho-wizard__brand"><img src={logo} alt="家合 Jiaho" /><span>家合<small>家庭 AI 中心</small></span></div>
      <div className="jiaho-wizard__default-mode"><Cloud size={17} /><span>默认联网模式</span><small>第 4 步可调整</small></div>
      <span className="jiaho-wizard__version">AI-OS <small>v{APP_VERSION}</small></span>
    </header>
    <div className="jiaho-wizard__layout">
      <aside className="jiaho-wizard__rail"><span className="jiaho-entry__eyebrow">WELCOME TO JIAHO</span><h1>四步，<br />准备好你的家。</h1><p>先确认网络，再配置账户与模型。<br />最后选择家合的工作方式。</p><nav aria-label="初始配置步骤">{STEPS.map(({ id, label, hint, icon: Icon }, index) => <button key={id} aria-current={step === id ? "step" : undefined} className={step === id ? "is-current" : ""} disabled={locked || (!authenticated && id !== "account" && id !== "network")} onClick={() => goto(id)}><span className="jiaho-wizard__step-icon"><Icon size={20} /></span><span><b>{label}</b><small>{hint}</small></span><em>0{index + 1}</em></button>)}</nav><div className="jiaho-wizard__privacy"><LockKey size={15} /><span>空间数据保存在本机，密钥加密保存。<br />模型只在你主动测试或提问时调用。</span></div></aside>
      <section className="jiaho-wizard__panel" aria-label="配置内容">
        <div className="jiaho-wizard__panel-label"><span>0{STEPS.findIndex((item) => item.id === step) + 1} / 04</span><span>{mode === "local" ? "本机 AI · 不使用云端 Provider" : "联网 AI · 可选云端或本机模型"}</span></div>
        {error && <p className="jiaho-entry__error" role="alert">{error}</p>}
        {step === "account" ? <>
          <h2>用邮箱，连接 BitBay。</h2><p className="jiaho-wizard__description">使用邮箱注册 BitBay 平台账户。这是你的在线身份，与本机空间账户分开。</p>
          <BitBayAccountSetup status={status} services={services} onReady={acceptPlatformAccount} onBusyChange={setAccountBusy} />
          {!status ? <div className="jiaho-wizard__loading"><CircleNotch className="jiaho-spin" size={23} />正在读取本机配置…<button onClick={() => void refresh()}>重试连接</button></div> : authenticated ? <>
            <div className="jiaho-wizard__account-ready"><div><UserCircle size={28} /><span><b>{status.username}</b><small>已登录 · 本机账户</small></span><Check size={19} /></div><label>空间名称<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label><label>交流语言<select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label></div>
            {!status.bitbay && <p className="jiaho-wizard__hint">本机空间已解锁，尚未关联 BitBay。可先配置本机模型。</p>}
            <button className="jiaho-entry__primary" onClick={() => goto("model")}>继续配置大模型<ArrowRight size={18} /></button>
          </> : <details className="jiaho-wizard__local-account"><summary>{initial ? "暂不连接平台？先建立本机空间" : "已有本机空间？解锁继续"}</summary><p className="jiaho-wizard__hint">仅用于保护这台设备上的 Home，不会注册 BitBay 平台账户。</p><form className="jiaho-wizard__account-form" onSubmit={(event) => void login(event)}>
            <label>本机账号或邮箱<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={initial ? 32 : 254} pattern={initial ? "[A-Za-z0-9_-]+" : undefined} required disabled={locked} /></label>
            <label>密码<div className="jiaho-entry__password"><input type={visible ? "text" : "password"} autoComplete={initial ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={initial ? 12 : 1} maxLength={1024} placeholder={initial ? "至少 12 位" : "输入本机账户密码"} required disabled={locked} /><button type="button" disabled={locked} aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeSlash size={18} /> : <Eye size={18} />}</button></div></label>
            {initial && <label>确认密码<input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} required disabled={locked} /></label>}
            {initial && <p className="jiaho-wizard__gift">首次创建，赠送 {status.grant_points.toLocaleString()} 本地配置体验积分。</p>}
            <button className="jiaho-entry__primary" type="submit" disabled={locked}>{busy ? <CircleNotch className="jiaho-spin" size={18} /> : <>{initial ? "仅创建本机空间" : "解锁本机空间"}<ArrowRight size={18} /></>}</button>
          </form></details>}
        </> : step === "network" ? <>
          <h2>先连接你的网络。</h2><p className="jiaho-wizard__description">打开即检查联网状态，无需先登录账户。未联网时会打开系统 Wi-Fi 设置，连接后返回这里即可重新检测。</p>
          <section className={`jiaho-wizard__connectivity is-${!network && networkError ? "error" : networkBusy || !network ? "checking" : network.connectivity}`} aria-label="联网状态" role="status" aria-live="polite" aria-busy={networkBusy}>
            <span className="jiaho-wizard__connectivity-icon">{networkBusy ? <CircleNotch className="jiaho-spin" size={27} /> : network?.connectivity === "online" && !networkError ? <Check size={27} /> : <WifiHigh size={27} />}</span>
            <div><b>{networkBusy ? "正在查找网络…" : !network && networkError ? "检测暂不可用" : network?.connectivity === "online" ? "已联网" : network?.connectivity === "offline" ? "未联网，请连接 Wi-Fi" : network ? "尚未确认联网" : "准备检查网络…"}</b><p>{networkBusy ? "正在检测 BitBay 公共接口是否可达，不发送账号资料。" : network?.connectivity === "online" ? "BitBay 公共接口已连通，可以继续配置邮箱账户。" : network?.connectivity === "limited" ? "已发现网络接口，但 BitBay 公共接口暂不可达。可能是平台暂不可用，也可检查 Wi-Fi 认证、代理或网络限制。" : "请在系统 Wi-Fi 设置中选择网络并连接。"}</p></div>
          </section>
          {networkError && <p className="jiaho-entry__error" role="status">{networkError}</p>}
          <div className="jiaho-wizard__network-actions"><button className="jiaho-wizard__system-settings" disabled={network?.settings_available === false || locked || networkBusy} onClick={() => void networkState.openSettings()}><Gear size={18} />打开 Wi-Fi 设置<ArrowRight size={16} /></button><button disabled={networkBusy || locked || !status} onClick={networkState.refresh}>重新检测</button></div>
          {network?.settings_available === false && <p className="jiaho-wizard__hint">这台设备暂不支持直接打开设置，请在系统网络菜单中连接 Wi-Fi。</p>}
          <details className="jiaho-wizard__network"><summary>网络详情</summary>{network?.interfaces.map((item) => <div key={item.name}><WifiHigh size={18} /><b>{item.name}</b><span>{item.addresses.join(" · ")}</span></div>)}<small>使用 BitBay 公共登录接口的空参数校验确认连通，不登录账户、不上传家庭资料，也不收集 Wi-Fi 密码。接口可达不代表邮件投递或模型服务已就绪。</small></details>
          <button className="jiaho-entry__primary" disabled={locked || !status} onClick={() => goto("account")}>{network?.connectivity === "online" ? "下一步，配置账户" : "暂时跳过，配置账户"}<ArrowRight size={18} /></button>
        </> : step === "model" ? <><AiOsModelSetup key={mode} variant="wizard" mode={mode} modelReady={status?.model_ready} language={language} services={services} onBusyChange={setModelBusy} onReady={prepareMode} /><button className="jiaho-wizard__back" disabled={locked} onClick={() => goto("account")}><ArrowLeft size={16} />返回账户配置</button></> : <>
          <h2>选择当前工作模式。</h2><p className="jiaho-wizard__description">联网模式是默认选项，适合使用云端大模型和 BitBay 平台服务。本地模式只允许连接本机模型，不等于关闭系统网络。</p>
          <div className="jiaho-wizard__mode-options" role="group" aria-label="工作模式">
            <button aria-pressed={mode === "online"} className={mode === "online" ? "is-selected" : ""} disabled={locked} onClick={() => void changeMode("online")}><Cloud size={26} /><span><b>联网模式</b><small>默认 · 可使用云端 Provider 和平台服务</small></span><i>{mode === "online" ? <Check size={18} /> : ""}</i></button>
            <button aria-pressed={mode === "local"} className={mode === "local" ? "is-selected" : ""} disabled={locked} onClick={() => void changeMode("local")}><LockKey size={26} /><span><b>本地模式</b><small>只连接 127.0.0.1 / 本机模型，数据路由更收敛</small></span><i>{mode === "local" ? <Check size={18} /> : ""}</i></button>
          </div>
          <div className="jiaho-wizard__mode-summary"><span>{mode === "local" ? <LockKey size={22} /> : <Globe size={22} />}</span><div><b>{mode === "local" ? "当前：本地模式" : "当前：联网模式"}</b><p>{mode === "local" ? "家合不会把模型请求发送到公网；系统网络仍可用于其他明确授权的服务。" : "家合可以连接你明确配置的云端模型；发送家庭资料仍受原有权限和审计约束。"}</p></div></div>
          <div className="jiaho-wizard__navigation"><button onClick={() => goto("model")}><ArrowLeft size={16} />返回大模型</button><button className="jiaho-entry__primary" disabled={locked || !pendingSelection} onClick={() => void finish()}>{busy ? <CircleNotch className="jiaho-spin" size={18} /> : <>完成配置，进入 DepDek<ArrowRight size={18} /></>}</button></div>
        </>}
      </section>
    </div>
    <footer className="jiaho-wizard__footer"><span>AI, at home.</span><span>本地模式不是系统断网或防火墙开关。</span></footer>
  </main>;
}
