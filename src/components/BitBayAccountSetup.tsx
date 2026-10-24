import { Check, CircleNotch, EnvelopeSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type * as api from "../api";
import { BITBAY_API_ORIGIN, bitBayEmail, bitBayError, passwordBytes } from "../lib/bitbay";

export interface BitBayServices {
  aiOsBitBaySendCode: typeof api.aiOsBitBaySendCode;
  aiOsBitBayRegister: typeof api.aiOsBitBayRegister;
  aiOsBitBayLogin: typeof api.aiOsBitBayLogin;
}
export default function BitBayAccountSetup({ status, services, onReady, onBusyChange }: {
  status: api.AiOsStatus | null; services: BitBayServices;
  onReady: (next: api.AiOsStatus) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [login, setLogin] = useState(false), [email, setEmail] = useState("");
  const [password, setPassword] = useState(""), [repeat, setRepeat] = useState(""), [code, setCode] = useState("");
  const [localPassword, setLocalPassword] = useState(""), [localRepeat, setLocalRepeat] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [retryAt, setRetryAt] = useState(0), [remaining, setRemaining] = useState(0);
  const operation = useRef(false), alive = useRef(true);
  const loading = !status;
  const needsUnlock = Boolean(status?.initialized && !status.authenticated);
  const needLocalPassword = login && !status?.initialized && passwordBytes(password) > 0 && passwordBytes(password) < 12;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!retryAt) return;
    const update = () => setRemaining(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    update(); const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const sendCode = async () => {
    if (operation.current || loading || remaining > 0 || !consent) return;
    if (needsUnlock) { setError("请先解锁上方的本机空间，再发送验证码。"); return; }
    let normalized: string;
    try { normalized = bitBayEmail(email); } catch (e) { setError(bitBayError(e)); return; }
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await services.aiOsBitBaySendCode(normalized);
      if (!alive.current) return;
      if (result.sent !== true) throw new Error("BITBAY_OUTCOME_UNKNOWN");
      const wait = Math.max(60, Math.min(300, result.retry_after_seconds || 60));
      setRemaining(wait); setRetryAt(Date.now() + wait * 1000);
      setNotice("验证码已发送，请检查邮箱。验证码 5 分钟内有效。");
    } catch (e) {
      if (alive.current) {
        setError(bitBayError(e));
        if (String(e).includes("BITBAY_RATE_LIMITED")) { setRemaining(60); setRetryAt(Date.now() + 60000); }
      }
    } finally { operation.current = false; if (alive.current) setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (operation.current || loading || !consent) return;
    if (needsUnlock) { setError("请先解锁上方的本机空间，再继续 BitBay 注册或登录。"); return; }
    let normalized: string;
    try { normalized = bitBayEmail(email); } catch (e) { setError(bitBayError(e)); return; }
    if ((!login && password !== repeat) || (needLocalPassword && localPassword !== localRepeat)) { setError("两次输入的密码不一致。"); return; }
    const size = passwordBytes(password);
    if (size < (login ? 6 : 12) || size > 20 || /[\x00-\x1f\x7f]/.test(password)) { setError(bitBayError("BITBAY_PASSWORD_INVALID")); return; }
    if (!login && !/^\d{6}$/.test(code)) { setError("请输入邮件中的 6 位验证码。"); return; }
    if (needLocalPassword && (passwordBytes(localPassword) < 12 || /[\x00-\x1f\x7f]/.test(localPassword))) { setError(bitBayError("LOCAL_UNLOCK_PASSWORD_REQUIRED")); return; }
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = login
        ? await services.aiOsBitBayLogin(normalized, password, needLocalPassword ? localPassword : undefined)
        : await services.aiOsBitBayRegister(normalized, code, password);
      if (!alive.current) return;
      // A local or malformed response is not evidence of platform registration.
      if (!next.authenticated || next.bitbay?.email !== normalized || !(next.bitbay.user_id > 0)) throw new Error("BITBAY_OUTCOME_UNKNOWN");
      setPassword(""); setRepeat(""); setLocalPassword(""); setLocalRepeat(""); setCode("");
      await onReady(next);
    } catch (e) { if (alive.current) setError(bitBayError(e)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };

  if (status?.authenticated && status.bitbay) return <section className="jiaho-wizard__bitbay-linked" aria-label="BitBay 已关联"><Check size={23} /><div><b>BitBay 邮箱账户已关联</b><span>{status.bitbay.email}</span><small>本机空间已准备好；不会自动上传资料或保持云端会话。</small></div></section>;
  return <section className="jiaho-wizard__platform-card" aria-label="BitBay 邮箱注册">
    <header><EnvelopeSimple size={24} /><span><b>BitBay 邮箱账户</b><small>{login ? "已有账户登录" : "邮箱验证 · 注册平台账户"}</small></span></header>
    <div className="jiaho-wizard__bitbay-tabs" role="group" aria-label="BitBay 账户方式"><button type="button" disabled={busy} aria-pressed={!login} onClick={() => { setLogin(false); setError(""); setNotice(""); setPassword(""); setRepeat(""); setCode(""); setLocalPassword(""); setLocalRepeat(""); }}>邮箱注册</button><button type="button" disabled={busy} aria-pressed={login} onClick={() => { setLogin(true); setError(""); setNotice(""); setPassword(""); setRepeat(""); setCode(""); setLocalPassword(""); setLocalRepeat(""); }}>已有账户登录</button></div>
    {needsUnlock && <p role="status">已有本机空间，请先在上方解锁，再关联 BitBay；原有数据不会被替换。</p>}
    <form className="jiaho-wizard__account-form" onSubmit={(event) => void submit(event)}>
      <label>邮箱地址<input type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" maxLength={254} value={email} onChange={(event) => { setEmail(event.target.value); setCode(""); setNotice(""); }} required disabled={busy || loading} /></label>
      {!login && <label>邮箱验证码<div className="jiaho-wizard__code-input"><input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="6 位验证码" value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy || loading} /><button type="button" disabled={busy || loading || !consent || !email.trim() || remaining > 0} onClick={() => void sendCode()}>{remaining > 0 ? `${remaining} 秒后重发` : needsUnlock ? "解锁后发送验证码" : "发送验证码"}</button></div></label>}
      <label>{login ? "BitBay 平台密码" : "设置密码"}<input type="password" autoComplete={login ? "current-password" : "new-password"} minLength={login ? 6 : 12} maxLength={20} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={login ? "输入已有平台密码" : "12–20 位，建议使用英文字母、数字和符号"} required disabled={busy || loading} /></label>
      {!login && <label>确认密码<input type="password" autoComplete="new-password" maxLength={20} value={repeat} onChange={(event) => setRepeat(event.target.value)} required disabled={busy || loading} /></label>}
      {needLocalPassword && <><p className="jiaho-wizard__hint">已有平台密码较短。请另设至少 12 位本机空间密码，用于离线解锁，不发送给 BitBay。</p><label>本机空间密码<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={localPassword} onChange={(event) => setLocalPassword(event.target.value)} required disabled={busy || loading} /></label><label>确认本机空间密码<input type="password" autoComplete="new-password" maxLength={1024} value={localRepeat} onChange={(event) => setLocalRepeat(event.target.value)} required disabled={busy || loading} /></label></>}
      <label className="jiaho-wizard__bitbay-consent"><input type="checkbox" checked={consent} disabled={busy || loading} onChange={(event) => setConsent(event.target.checked)} /><span>允许将邮箱、验证码和平台密码发送到 <b>{BITBAY_API_ORIGIN}</b>。本机仅保存空间密码的安全哈希与账户关联，不保存平台密码或 Token。</span></label>
      {!login && !status?.initialized && <p className="jiaho-wizard__hint">此密码也用于本机空间解锁；平台修改密码不会自动更改本机密码。</p>}
      {notice && <p className="jiaho-wizard__bitbay-notice" role="status">{notice}</p>}
      {error && <p className="jiaho-entry__error" role="alert">{error}</p>}
      <button className="jiaho-entry__primary" type="submit" disabled={busy || loading || !consent}>{busy ? <><CircleNotch size={18} className="jiaho-spin" />正在连接 BitBay…</> : needsUnlock ? `解锁后${login ? "登录" : "注册"} BitBay` : login ? "登录 BitBay 并继续" : "注册 BitBay 并继续"}</button>
    </form>
  </section>;
}
