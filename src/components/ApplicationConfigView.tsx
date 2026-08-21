import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarBlank,
  CheckCircle,
  EnvelopeSimple,
  FolderOpen,
  GearSix,
  PencilSimple,
  Plus,
  ShieldCheck,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import * as api from "../api";
import "./app-config.css";

type ConfigApp = "mail" | "calendar" | "obsidian";
type MailDraft = api.MailAccount;
type CalendarDraft = api.CalendarAccount;

const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const PREVIEW_MAIL: api.MailAccount[] = [
  { name: "个人邮箱", host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "preview", mailbox: "INBOX", smtp_host: "smtp.example.com", smtp_port: 465, smtp_secure: true },
];

const PREVIEW_CALENDAR: api.CalendarAccount[] = [
  { id: "preview-apple", name: "Apple 日历", provider: "apple", endpoint: "https://caldav.icloud.com/", user: "me@icloud.com", enabled: true, readonly: true },
];

const CALENDAR_PROVIDERS: Record<api.CalendarProvider, { label: string; hint: string }> = {
  google: { label: "Google Calendar", hint: "ICS 订阅地址或 Google Calendar API 地址" },
  microsoft: { label: "Outlook Calendar", hint: "ICS 订阅地址或 Microsoft Graph 地址" },
  apple: { label: "Apple / iCloud", hint: "https://caldav.icloud.com/ 或 webcal:// 地址" },
  caldav: { label: "CalDAV", hint: "https://example.com/caldav/" },
  ics: { label: "ICS 订阅", hint: "https://example.com/calendar.ics" },
};

function parseAccounts<T>(content: string): T[] {
  try {
    const value = JSON.parse(content) as { accounts?: T[] };
    return Array.isArray(value.accounts) ? value.accounts : [];
  } catch {
    return [];
  }
}

function AppIcon({ icon: Icon, tone }: { icon: Icon; tone: "mail" | "calendar" | "obsidian" }) {
  return <span className={`dd-app-config__icon dd-app-config__icon--${tone}`}><Icon size={25} weight="duotone" /></span>;
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`dd-app-config__field${wide ? " dd-app-config__field--wide" : ""}`}><span>{label}</span>{children}</label>;
}

function MailConfig({ accounts, save, onNotify }: { accounts: api.MailAccount[]; save: (next: api.MailAccount[]) => Promise<void>; onNotify: (message: string) => void }) {
  const [editing, setEditing] = useState<MailDraft | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newAccount = (): MailDraft => ({ name: "", host: "", port: 993, secure: true, user: "", password: "", mailbox: "INBOX", smtp_host: "", smtp_port: 465, smtp_secure: true });
  const submit = async () => {
    if (!editing) return;
    const previous = editingOriginalName ? accounts.find((account) => account.name === editingOriginalName) : undefined;
    if (!editing.name.trim() || !editing.host.trim() || !editing.user.trim() || (!previous && !editing.password.trim())) {
      setError("请填写名称、IMAP 主机、邮箱地址和授权码。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const nextAccount = { ...editing, name: editing.name.trim(), host: editing.host.trim(), user: editing.user.trim(), password: editing.password || previous?.password || "" };
      const next = previous
        ? accounts.map((account) => account.name === previous.name ? nextAccount : account)
        : [...accounts, nextAccount];
      await save(next);
      setEditing(null); setEditingOriginalName(null);
      onNotify("邮箱账户配置已保存");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (account: api.MailAccount) => {
    if (!window.confirm(`删除邮箱账户「${account.name}」？本地邮件副本不会被删除。`)) return;
    await save(accounts.filter((item) => item.name !== account.name));
    onNotify(`已移除邮箱账户「${account.name}」`);
  };
  return <div className="dd-app-config__section">
    <div className="dd-app-config__section-head"><div><h2>邮件账户</h2><p>配置 IMAP / SMTP 账户；邮件正文和附件仍保存在本地 Home。</p></div><button className="dd-app-config__primary" onClick={() => { setError(null); setEditingOriginalName(null); setEditing(newAccount()); }}><Plus size={16} />添加账户</button></div>
    <div className="dd-app-config__account-list">{accounts.map((account) => <article className="dd-app-config__account" key={account.name}><AppIcon icon={EnvelopeSimple} tone="mail" /><div className="dd-app-config__account-copy"><b>{account.name}</b><span>{account.user}</span><small>{account.host}:{account.port ?? 993} · {account.secure === false ? "未启用 TLS" : "TLS"}</small></div><span className="dd-app-config__status dd-app-config__status--ok"><CheckCircle size={13} />已配置</span><button className="dd-app-config__icon-button" onClick={() => { setError(null); setEditingOriginalName(account.name); setEditing({ ...account, password: "" }); }} aria-label={`编辑${account.name}`}><PencilSimple size={15} /></button><button className="dd-app-config__icon-button dd-app-config__icon-button--danger" onClick={() => void remove(account)} aria-label={`删除${account.name}`}><Trash size={15} /></button></article>)}{accounts.length === 0 && <div className="dd-app-config__empty"><EnvelopeSimple size={26} /><b>尚未配置邮箱账户</b><span>添加一个 IMAP / SMTP 账户后，工作台会显示本地收件箱。</span></div>}</div>
    {editing && <div className="dd-app-config__editor"><header><div><b>{accounts.some((account) => account.name === editing.name) ? "编辑邮箱账户" : "添加邮箱账户"}</b><small>凭据仅写入当前 Home，不进入 Agent 上下文。</small></div><button className="dd-app-config__icon-button" onClick={() => setEditing(null)} aria-label="关闭编辑"><ArrowLeft size={16} /></button></header><div className="dd-app-config__form-grid"><Field label="显示名称"><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="例如：个人邮箱" /></Field><Field label="邮箱地址"><input type="email" value={editing.user} onChange={(event) => setEditing({ ...editing, user: event.target.value })} placeholder="you@example.com" /></Field><Field label="IMAP 主机"><input value={editing.host} onChange={(event) => setEditing({ ...editing, host: event.target.value })} placeholder="imap.example.com" /></Field><Field label="IMAP 端口"><input type="number" value={editing.port ?? 993} onChange={(event) => setEditing({ ...editing, port: Number(event.target.value) || 993 })} /></Field><Field label="授权码 / 密码"><input type="password" value={editing.password} onChange={(event) => setEditing({ ...editing, password: event.target.value })} placeholder="新账户必填；编辑时留空表示不修改" /></Field><Field label="收件文件夹"><input value={editing.mailbox ?? "INBOX"} onChange={(event) => setEditing({ ...editing, mailbox: event.target.value })} /></Field><Field label="SMTP 主机"><input value={editing.smtp_host ?? ""} onChange={(event) => setEditing({ ...editing, smtp_host: event.target.value })} placeholder="smtp.example.com" /></Field><Field label="SMTP 端口"><input type="number" value={editing.smtp_port ?? 465} onChange={(event) => setEditing({ ...editing, smtp_port: Number(event.target.value) || 465 })} /></Field><label className="dd-app-config__check"><input type="checkbox" checked={editing.secure !== false} onChange={(event) => setEditing({ ...editing, secure: event.target.checked })} />IMAP 使用 TLS</label><label className="dd-app-config__check"><input type="checkbox" checked={editing.smtp_secure !== false} onChange={(event) => setEditing({ ...editing, smtp_secure: event.target.checked })} />SMTP 使用 SSL</label></div>{error && <p className="dd-app-config__error"><WarningCircle size={15} />{error}</p>}<footer><button onClick={() => setEditing(null)}>取消</button><button className="dd-app-config__primary" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : "保存邮件配置"}</button></footer></div>}
  </div>;
}

function CalendarConfig({ accounts, save, onNotify }: { accounts: api.CalendarAccount[]; save: (next: api.CalendarAccount[]) => Promise<void>; onNotify: (message: string) => void }) {
  const [editing, setEditing] = useState<CalendarDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newAccount = (): CalendarDraft => ({ id: `calendar-${Date.now().toString(36)}`, name: "", provider: "apple", endpoint: "https://caldav.icloud.com/", user: "", password: "", enabled: true, readonly: true });
  const submit = async () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.endpoint?.trim()) { setError("请填写日历名称和订阅 / CalDAV 地址。"); return; }
    setSaving(true); setError(null);
    try {
      const previous = accounts.find((account) => account.id === editing.id);
      const nextAccount = { ...editing, name: editing.name.trim(), endpoint: editing.endpoint.trim(), password: editing.password || previous?.password || undefined };
      const next = accounts.some((account) => account.id === editing.id) ? accounts.map((account) => account.id === editing.id ? nextAccount : account) : [...accounts, nextAccount];
      await save(next); setEditing(null); onNotify("日历连接配置已保存");
    } catch (reason) { setError(String(reason)); } finally { setSaving(false); }
  };
  const remove = async (account: api.CalendarAccount) => {
    if (!window.confirm(`删除日历连接「${account.name}」？本地已同步事件不会删除。`)) return;
    await save(accounts.filter((item) => item.id !== account.id)); onNotify(`已移除日历连接「${account.name}」`);
  };
  return <div className="dd-app-config__section"><div className="dd-app-config__section-head"><div><h2>日历连接</h2><p>配置 Google、Outlook、Apple、CalDAV 或 ICS；事件先回到本地中枢。</p></div><button className="dd-app-config__primary" onClick={() => { setError(null); setEditing(newAccount()); }}><Plus size={16} />连接日历</button></div><div className="dd-app-config__account-list">{accounts.map((account) => <article className="dd-app-config__account" key={account.id}><AppIcon icon={CalendarBlank} tone="calendar" /><div className="dd-app-config__account-copy"><b>{account.name}</b><span>{CALENDAR_PROVIDERS[account.provider].label}</span><small>{account.endpoint}</small></div><span className="dd-app-config__status dd-app-config__status--ok"><CheckCircle size={13} />已保存</span><button className="dd-app-config__icon-button" onClick={() => { setError(null); setEditing({ ...account, password: "" }); }} aria-label={`编辑${account.name}`}><PencilSimple size={15} /></button><button className="dd-app-config__icon-button dd-app-config__icon-button--danger" onClick={() => void remove(account)} aria-label={`删除${account.name}`}><Trash size={15} /></button></article>)}{accounts.length === 0 && <div className="dd-app-config__empty"><CalendarBlank size={26} /><b>尚未连接日历</b><span>连接一个外部日历后，事件会在工作台的日历中汇总显示。</span></div>}</div>{editing && <div className="dd-app-config__editor"><header><div><b>{accounts.some((account) => account.id === editing.id) ? "编辑日历连接" : "连接一个日历"}</b><small>外部写回仍需在日历页面逐次确认。</small></div><button className="dd-app-config__icon-button" onClick={() => setEditing(null)} aria-label="关闭编辑"><ArrowLeft size={16} /></button></header><div className="dd-app-config__form-grid"><Field label="日历名称"><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="例如：个人 Apple 日历" /></Field><Field label="服务类型"><select value={editing.provider} onChange={(event) => setEditing({ ...editing, provider: event.target.value as api.CalendarProvider })}>{Object.entries(CALENDAR_PROVIDERS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></Field><Field label="订阅 / CalDAV 地址" wide><input value={editing.endpoint ?? ""} onChange={(event) => setEditing({ ...editing, endpoint: event.target.value })} placeholder={CALENDAR_PROVIDERS[editing.provider].hint} /></Field><Field label="账户（可选）"><input value={editing.user ?? ""} onChange={(event) => setEditing({ ...editing, user: event.target.value })} placeholder="邮箱或 CalDAV 用户名" /></Field><Field label={editing.provider === "apple" ? "应用专用密码" : "密码（可选）"}><input type="password" value={editing.password ?? ""} onChange={(event) => setEditing({ ...editing, password: event.target.value })} placeholder="编辑时留空表示不修改" /></Field><label className="dd-app-config__check"><input type="checkbox" checked={editing.enabled !== false} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />启用此连接</label><label className="dd-app-config__check"><input type="checkbox" checked={editing.readonly !== false} onChange={(event) => setEditing({ ...editing, readonly: event.target.checked })} />只读模式（推荐）</label></div>{error && <p className="dd-app-config__error"><WarningCircle size={15} />{error}</p>}<footer><button onClick={() => setEditing(null)}>取消</button><button className="dd-app-config__primary" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : "保存日历配置"}</button></footer></div>}</div>;
}

function ObsidianConfig({ root, setRoot, onNotify }: { root: string | null; setRoot: (value: string | null) => void; onNotify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    if (browserPreview) { onNotify("浏览器预览不能访问本机目录，请在桌面版选择 Vault"); return; }
    setBusy(true); setError(null);
    try { const selected = await open({ directory: true, multiple: false, title: "选择 Obsidian Vault" }); if (typeof selected !== "string") return; const normalized = await api.obsidianSetRoot(selected); setRoot(normalized); onNotify("Obsidian Vault 已连接"); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!window.confirm("断开 Obsidian 连接？原 Vault 和本地已索引数据不会删除。")) return;
    setBusy(true); setError(null);
    try { if (!browserPreview) await api.obsidianClearRoot(); setRoot(null); onNotify("Obsidian 已断开"); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <div className="dd-app-config__section"><div className="dd-app-config__section-head"><div><h2>Obsidian 知识库</h2><p>连接本地 Obsidian Vault；工作台的知识库页面只读展示 Markdown 笔记。</p></div><button className="dd-app-config__primary" disabled={busy} onClick={() => void connect()}><FolderOpen size={16} />{root ? "更换 Vault" : "选择 Vault"}</button></div><div className={`dd-app-config__obsidian-status ${root ? "dd-app-config__obsidian-status--connected" : ""}`}><AppIcon icon={BookOpen} tone="obsidian" /><div><b>{root ? "Obsidian Vault 已连接" : "尚未连接 Obsidian"}</b><span>{root ?? "选择一个本地 Vault，DepDek 会在工作台展示其中的知识库内容。"}</span></div>{root && <span className="dd-app-config__status dd-app-config__status--ok"><CheckCircle size={13} />只读</span>}</div>{root && <div className="dd-app-config__path"><ShieldCheck size={16} /><div><b>当前 Vault</b><span title={root}>{root}</span></div><button onClick={() => void disconnect()} disabled={busy}><Trash size={15} />断开连接</button></div>}{error && <p className="dd-app-config__error"><WarningCircle size={15} />{error}</p>}</div>;
}

export default function ApplicationConfigView({ onNotify }: { onNotify: (message: string) => void }) {
  const [selected, setSelected] = useState<ConfigApp | null>(null);
  const [mailAccounts, setMailAccounts] = useState<api.MailAccount[]>(browserPreview ? PREVIEW_MAIL : []);
  const [calendarAccounts, setCalendarAccounts] = useState<api.CalendarAccount[]>(browserPreview ? PREVIEW_CALENDAR : []);
  const [obsidianRoot, setObsidianRoot] = useState<string | null>(browserPreview ? "~/Obsidian/我的知识库 · UX 预览" : null);
  const [loading, setLoading] = useState(!browserPreview);

  useEffect(() => {
    if (browserPreview) return;
    let active = true;
    void Promise.all([
      api.vaultReadFile("mail/accounts.json").then((result) => parseAccounts<api.MailAccount>(result.content)).catch(() => []),
      api.vaultReadFile("calendar/accounts.json").then((result) => parseAccounts<api.CalendarAccount>(result.content)).catch(() => []),
      api.obsidianGetRoot().catch(() => null),
    ]).then(([mail, calendar, root]) => { if (!active) return; setMailAccounts(mail); setCalendarAccounts(calendar); setObsidianRoot(root); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const saveMail = async (next: api.MailAccount[]) => { if (!browserPreview) await api.vaultWriteFile("mail/accounts.json", JSON.stringify({ version: 1, accounts: next }, null, 2) + "\n"); setMailAccounts(next); };
  const saveCalendar = async (next: api.CalendarAccount[]) => { if (!browserPreview) await api.vaultWriteFile("calendar/accounts.json", JSON.stringify({ version: 1, accounts: next }, null, 2) + "\n"); setCalendarAccounts(next); };
  const cards = useMemo(() => [
    { key: "mail" as const, icon: EnvelopeSimple, tone: "mail" as const, title: "邮件", subtitle: "IMAP / SMTP", description: "配置邮箱账户、同步方式和本地邮件副本。", status: mailAccounts.length ? `${mailAccounts.length} 个账户已配置` : "尚未配置" },
    { key: "calendar" as const, icon: CalendarBlank, tone: "calendar" as const, title: "日历", subtitle: "CalDAV / ICS / OAuth", description: "连接主流日历，把事件汇总到工作台的本地中枢。", status: calendarAccounts.length ? `${calendarAccounts.length} 个连接已保存` : "尚未连接" },
    { key: "obsidian" as const, icon: BookOpen, tone: "obsidian" as const, title: "Obsidian", subtitle: "本地 Markdown Vault", description: "选择 Vault，在知识库页面只读浏览你的笔记。", status: obsidianRoot ? "Vault 已连接" : "尚未连接" },
  ], [calendarAccounts.length, mailAccounts.length, obsidianRoot]);

  if (loading) return <div className="dd-app-config dd-app-config--loading"><GearSix size={24} /><span>读取应用配置…</span></div>;
  if (selected) {
    const card = cards.find((item) => item.key === selected)!;
    return <div className="dd-app-config"><div className="dd-app-config__breadcrumb"><button onClick={() => setSelected(null)}><ArrowLeft size={16} />应用配置</button><span>/</span><b>{card.title}</b></div><div className="dd-app-config__detail-head"><AppIcon icon={card.icon} tone={card.tone} /><div><div className="dd-eyebrow">APP CONFIG / {card.subtitle}</div><h1>{card.title}配置</h1><p>{card.description}</p></div></div>{selected === "mail" && <MailConfig accounts={mailAccounts} save={saveMail} onNotify={onNotify} />}{selected === "calendar" && <CalendarConfig accounts={calendarAccounts} save={saveCalendar} onNotify={onNotify} />}{selected === "obsidian" && <ObsidianConfig root={obsidianRoot} setRoot={setObsidianRoot} onNotify={onNotify} />}</div>;
  }
  return <div className="dd-app-config"><div className="dd-view-head"><div><div className="dd-eyebrow">APP CONFIG / 应用连接</div><h1>应用配置</h1></div><span>选择一个应用进入配置；工作台只负责使用数据，连接和凭据集中在这里管理。</span></div><section className="dd-app-config__intro"><GearSix size={22} /><div><b>统一管理你的应用</b><span>配置完成后，邮件、知识库和日历仍会回到工作台中使用。</span></div><ShieldCheck size={18} /></section><div className="dd-app-config__cards">{cards.map((card) => <button className="dd-app-config__card" key={card.key} onClick={() => setSelected(card.key)}><AppIcon icon={card.icon} tone={card.tone} /><div><div className="dd-app-config__card-title"><b>{card.title}</b><span>{card.subtitle}</span></div><p>{card.description}</p><small>{card.status}</small></div><ArrowRight className="dd-app-config__card-arrow" size={18} /></button>)}</div><div className="dd-app-config__footnote"><ShieldCheck size={15} />连接凭据写入当前本地 Home；应用数据的读取、同步和外部写回仍由各自工作台页面控制。</div></div>;
}
