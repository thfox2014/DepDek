import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  CheckCircle,
  CheckSquare,
  CloudArrowUp,
  CircleNotch,
  GearSix,
  LinkSimple,
  MapPin,
  Plus,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import * as api from "../api";
import type { TaskReporter } from "../taskTypes";
import { enqueueTodo } from "../todoStore";
import "./calendar.css";

const ACCOUNTS_PATH = "calendar/accounts.json";
const EVENTS_PATH = "calendar/events.json";

const PROVIDERS: Record<api.CalendarProvider, { label: string; hint: string; write: boolean }> = {
  google: { label: "Google Calendar", hint: "OAuth 或日历订阅地址（读取）", write: false },
  microsoft: { label: "Microsoft Outlook", hint: "OAuth 或 ICS 订阅地址（读取）", write: false },
  apple: { label: "Apple / iCloud", hint: "iCloud ICS 或 CalDAV 地址（读取）", write: false },
  caldav: { label: "CalDAV / 自建日历", hint: "CalDAV collection 地址，可读写", write: true },
  ics: { label: "ICS 订阅", hint: "公开或私有 ICS 地址（只读）", write: false },
};

const PREVIEW_ACCOUNTS: api.CalendarAccount[] = [
  { id: "preview-google", name: "Google 工作日历", provider: "google", enabled: true, readonly: true },
  { id: "preview-local", name: "DepDek 本地日历", provider: "caldav", enabled: true },
];

type CalendarConnectionStatus = "idle" | "connecting" | "connected" | "error";
type CalendarConnectionState = {
  status: CalendarConnectionStatus;
  lastSyncAt?: number;
  error?: string;
  logs: string[];
};
type CalendarConnectionPatch = Partial<Omit<CalendarConnectionState, "logs">> & { log?: string };

function formatConnectionTime(value?: number): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value) : "";
}

function dayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateAtKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function dateTime(date: Date, hour: number, minute: number): string {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next.toISOString();
}

function makePreviewEvents(): api.CalendarEvent[] {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const later = new Date(today);
  later.setDate(today.getDate() + 2);
  return [
    { id: "preview-standup", remote_id: "standup", source_account_id: "preview-google", source_name: "Google 工作日历", title: "产品周会", start: dateTime(today, 9, 30), end: dateTime(today, 10, 15), location: "线上 · 腾讯会议" },
    { id: "preview-review", remote_id: "review", source_account_id: "preview-google", source_name: "Google 工作日历", title: "DepDek 重构评审", start: dateTime(today, 13, 0), end: dateTime(today, 14, 0), location: "会议室 B" },
    { id: "preview-deep-work", source_account_id: "preview-local", source_name: "DepDek 本地日历", title: "深度工作块 · 邮件整理", start: dateTime(tomorrow, 19, 0), end: dateTime(tomorrow, 21, 0), location: "本地" },
    { id: "preview-budget", remote_id: "budget", source_account_id: "preview-google", source_name: "Google 工作日历", title: "与 Alice 对齐 Q3 预算", start: dateTime(later, 15, 0), end: dateTime(later, 16, 0), location: "线上" },
  ];
}

function formatTime(value: string, allDay?: boolean): string {
  if (allDay) return "全天";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDay(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(value);
}

function monthLabel(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(value);
}

function AccountModal({ initial, onClose, onSave }: { initial?: api.CalendarAccount | null; onClose: () => void; onSave: (account: api.CalendarAccount) => Promise<void> }) {
  const [provider, setProvider] = useState<api.CalendarProvider>(initial?.provider ?? "google");
  const [name, setName] = useState(initial?.name ?? "");
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? "");
  const [user, setUser] = useState(initial?.user ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PROVIDERS[provider];

  const submit = async () => {
    if (!name.trim()) { setError("请填写日历名称。"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({ id: initial?.id ?? `calendar-${Date.now().toString(36)}`, name: name.trim(), provider, endpoint: endpoint.trim() || undefined, user: user.trim() || undefined, password: password || initial?.password || undefined, enabled: initial?.enabled !== false, readonly: !meta.write });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return <div className="dd-calendar-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="dd-calendar-modal" role="dialog" aria-modal="true" aria-label="连接日历">
      <header><span className="dd-calendar-modal-icon"><LinkSimple size={21} /></span><div><h2>连接一个日历</h2><p>先把外部日历带回本地，再决定哪些事件写回。</p></div><button onClick={onClose} aria-label="关闭连接日历"><X size={18} /></button></header>
      <div className="dd-calendar-form">
        <label>日历名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：个人 Google 日历" /></label>
        <label>服务类型<select value={provider} onChange={(event) => setProvider(event.target.value as api.CalendarProvider)}>{Object.entries(PROVIDERS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
        <label>订阅 / CalDAV 地址<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={meta.hint} />{provider === "apple" && <small className="dd-calendar-form-hint">Apple 的 webcal:// 地址会自动转换为 HTTPS。</small>}</label>
        <div className="dd-calendar-form-row"><label>账户（可选）<input value={user} onChange={(event) => setUser(event.target.value)} placeholder="邮箱或 CalDAV 用户名" /></label><label>{provider === "apple" ? "应用专用密码" : "密码（可选）"}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={initial?.password ? "已保存 · 如需更换再输入" : provider === "apple" ? "Apple 应用专用密码" : "只用于连接"} /></label></div>
        <div className="dd-calendar-provider-note"><CalendarBlank size={15} /><span>{meta.write ? "此连接支持显式写回；不会自动改动远端事件。" : provider === "apple" ? "Apple 支持公开 ICS 订阅，或使用 caldav.icloud.com + Apple 应用专用密码读取。" : "此连接默认只读；Google 和 Microsoft 写回需要 OAuth 授权。"}</span></div>
        {error && <p className="dd-calendar-error">{error}</p>}
      </div>
      <footer><span>凭据保存在当前本地 Home</span><button onClick={onClose}>取消</button><button className="dd-calendar-primary" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : initial ? "保存设置" : "保存连接"}</button></footer>
    </section>
  </div>;
}

function EventModal({ accounts, defaultDate, onClose, onSave }: { accounts: api.CalendarAccount[]; defaultDate: Date; onClose: () => void; onSave: (event: api.CalendarEvent, accountId?: string, syncExternal?: boolean) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(dayKey(defaultDate));
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [location, setLocation] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [syncExternal, setSyncExternal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const canWriteExternal = Boolean(selectedAccount && PROVIDERS[selectedAccount.provider].write);

  const submit = async () => {
    if (!title.trim()) { setError("请填写日程标题。"); return; }
    const startDate = new Date(`${date}T${start}:00`);
    const endDate = new Date(`${date}T${end}:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) { setError("结束时间必须晚于开始时间。"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({ id: `local-${Date.now().toString(36)}`, title: title.trim(), start: startDate.toISOString(), end: endDate.toISOString(), location: location.trim() || undefined, source_name: "DepDek 本地日历", updated_at: new Date().toISOString() }, accountId || undefined, syncExternal);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return <div className="dd-calendar-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="dd-calendar-modal" role="dialog" aria-modal="true" aria-label="新建日程">
      <header><span className="dd-calendar-modal-icon"><Plus size={21} /></span><div><h2>新建日程</h2><p>先写入 DepDek 本地日历，再按你的选择同步到外部。</p></div><button onClick={onClose} aria-label="关闭新建日程"><X size={18} /></button></header>
      <div className="dd-calendar-form"><label>标题<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：与 Alice 对齐 Q3 预算" /></label><div className="dd-calendar-form-row"><label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>地点<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="线上 / 会议室" /></label></div><div className="dd-calendar-form-row"><label>开始<input type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束<input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div><label>同步到外部日历<select value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={!accounts.length}><option value="">仅保存在 DepDek</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {PROVIDERS[account.provider].write ? "可写" : "只读"}</option>)}</select></label><label className="dd-calendar-check"><input type="checkbox" checked={syncExternal} disabled={!canWriteExternal} onChange={(event) => setSyncExternal(event.target.checked)} /><span>{canWriteExternal ? "保存后立即同步到所选外部日历" : "只读连接需 OAuth 授权；当前仅保存到 DepDek"}</span></label>{error && <p className="dd-calendar-error">{error}</p>}</div>
      <footer><span>DepDek 是本地中枢，外部写回逐次确认</span><button onClick={onClose}>取消</button><button className="dd-calendar-primary" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : "保存日程"}</button></footer>
    </section>
  </div>;
}

export default function CalendarView({ onStartTask, onUpdateTask }: TaskReporter) {
  const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(dayKey(today));
  const [accounts, setAccounts] = useState<api.CalendarAccount[]>([]);
  const [events, setEvents] = useState<api.CalendarEvent[]>([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionStates, setConnectionStates] = useState<Record<string, CalendarConnectionState>>({});
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<api.CalendarAccount | null>(null);
  const [eventModalOpen, setEventModalOpen] = useState(false);

  const loadCalendar = useCallback(async () => {
    if (browserPreview) {
      setAccounts(PREVIEW_ACCOUNTS);
      setEvents(makePreviewEvents());
      setLoading(false);
      return;
    }
    try {
      const [accountResult, eventResult] = await Promise.all([
        api.vaultReadFile(ACCOUNTS_PATH).catch(() => ({ content: "{\"accounts\":[]}" })),
        api.vaultReadFile(EVENTS_PATH).catch(() => ({ content: "{\"version\":1,\"events\":[]}" })),
      ]);
      const accountData = JSON.parse(accountResult.content) as { accounts?: api.CalendarAccount[] };
      const eventData = JSON.parse(eventResult.content) as { events?: api.CalendarEvent[] };
      setAccounts(accountData.accounts ?? []);
      setEvents(eventData.events ?? []);
    } catch (error) {
      setNotice(`读取本地日历失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [browserPreview]);

  const saveAccounts = async (next: api.CalendarAccount[]) => {
    if (!browserPreview) await api.vaultWriteFile(ACCOUNTS_PATH, JSON.stringify({ accounts: next }, null, 2) + "\n");
    setAccounts(next);
  };

  const saveEvents = async (next: api.CalendarEvent[]) => {
    if (!browserPreview) await api.vaultWriteFile(EVENTS_PATH, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), events: next }, null, 2) + "\n");
    setEvents(next);
  };

  const updateConnectionState = (accountId: string, patch: CalendarConnectionPatch) => {
    setConnectionStates((current) => {
      const previous = current[accountId] ?? { status: "idle", logs: [] };
      const logs = patch.log ? [...previous.logs, `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${patch.log}`].slice(-12) : previous.logs;
      const { log: _log, ...statePatch } = patch;
      return { ...current, [accountId]: { ...previous, ...statePatch, logs } };
    });
  };

  const openAccountSettings = (account?: api.CalendarAccount) => {
    setEditingAccount(account ?? null);
    setAccountModalOpen(true);
  };

  useEffect(() => { void loadCalendar(); }, [loadCalendar]);

  const filteredEvents = useMemo(() => accountFilter === "all" ? events : events.filter((event) => event.source_account_id === accountFilter), [accountFilter, events]);
  const monthDays = useMemo(() => {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    const first = new Date(start);
    first.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => { const value = new Date(first); value.setDate(first.getDate() + index); return value; });
  }, [month]);
  const selectedEvents = useMemo(() => filteredEvents.filter((event) => dayKey(new Date(event.start)) === selectedDate).sort((a, b) => a.start.localeCompare(b.start)), [filteredEvents, selectedDate]);
  const monthEventCount = filteredEvents.filter((event) => new Date(event.start).getFullYear() === month.getFullYear() && new Date(event.start).getMonth() === month.getMonth()).length;

  const syncCalendars = async (accountId?: string) => {
    const targetAccounts = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
    const targetCount = Math.max(targetAccounts.length, 1);
    const targetName = targetAccounts[0]?.name;
    targetAccounts.forEach((account) => updateConnectionState(account.id, { status: "connecting", error: undefined, log: `开始连接 ${account.name}` }));
    const taskId = onStartTask?.({ kind: "calendar_sync", title: targetName ? `连接 ${targetName}` : "同步日历", detail: targetName ? `正在检查「${targetName}」` : `准备同步 ${targetCount} 个日历连接`, progress: { current: 0, total: targetCount, label: "连接日历" }, logs: [{ ts: Date.now(), level: "info", message: targetName ? `开始连接「${targetName}」` : "开始同步本地日历中枢" }] });
    setSyncing(true);
    setNotice(null);
    try {
      if (browserPreview) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        setEvents(makePreviewEvents());
        targetAccounts.forEach((account) => updateConnectionState(account.id, { status: "connected", lastSyncAt: Date.now(), log: "浏览器预览连接成功（未访问外部服务）" }));
        if (taskId) onUpdateTask?.(taskId, { status: "success", detail: "日历已聚合到本地", progress: { current: targetCount, total: targetCount, label: "完成" }, finishedAt: Date.now(), log: { level: "success", message: "示例日历已更新" } });
        setNotice(targetName ? `「${targetName}」连接成功 · 浏览器预览不会连接外部服务` : "日历已聚合到 DepDek 本地中枢 · 浏览器预览不会连接外部服务");
      } else {
        const result = await api.calendarSync(accountId);
        await loadCalendar();
        const failures = result.accounts.filter((account) => account.error);
        result.accounts.forEach((resultAccount) => updateConnectionState(resultAccount.id, resultAccount.error
          ? { status: "error", error: resultAccount.error, log: `连接失败：${resultAccount.error}` }
          : { status: "connected", lastSyncAt: Date.now(), error: undefined, log: `连接成功，导入 ${resultAccount.imported} 项日程` }));
        if (taskId) {
          result.accounts.forEach((account, index) => onUpdateTask?.(taskId, { progress: { current: index + 1, total: Math.max(result.accounts.length, 1), label: "同步日历" }, log: account.error ? { level: "error", message: `${account.name}：${account.error}` } : { level: "success", message: `${account.name} 导入 ${account.imported} 项` } }));
          onUpdateTask?.(taskId, { status: failures.length ? "error" : "success", detail: failures.length ? "部分日历同步失败" : `已导入 ${result.imported} 项日程`, message: failures.map((account) => account.error).filter(Boolean).join("；") || undefined, finishedAt: Date.now() });
        }
        const failureMessage = failures.map((account) => `${account.name}：${account.error}`).join("；");
        setNotice(failures.length ? `日历同步完成，但有 ${failures.length} 个连接失败 · ${failureMessage}` : targetName ? `「${targetName}」连接成功，导入 ${result.imported} 项日程` : `已从外部日历导入 ${result.imported} 项`);
      }
    } catch (error) {
      const message = String(error);
      targetAccounts.forEach((account) => updateConnectionState(account.id, { status: "error", error: message, log: `连接失败：${message}` }));
      if (taskId) onUpdateTask?.(taskId, { status: "error", detail: "日历同步失败", message, finishedAt: Date.now(), log: { level: "error", message } });
      setNotice(`日历同步失败：${message}`);
    } finally {
      setSyncing(false);
    }
  };

  const addAccount = async (account: api.CalendarAccount) => {
    const exists = accounts.some((item) => item.id === account.id);
    const next = exists ? accounts.map((item) => item.id === account.id ? account : item) : [...accounts, account];
    await saveAccounts(next);
    setAccountModalOpen(false);
    setEditingAccount(null);
    if (exists) updateConnectionState(account.id, { status: "idle", error: undefined, log: "连接配置已更新，请重新连接" });
    setNotice(exists ? `${account.name} 的连接设置已更新，请点击“连接”验证` : `${account.name} 已加入本地日历中枢`);
  };

  const addEvent = async (event: api.CalendarEvent, accountId?: string, syncExternal = false) => {
    const next = [...events, event].sort((a, b) => a.start.localeCompare(b.start));
    await saveEvents(next);
    setEventModalOpen(false);
    setSelectedDate(dayKey(new Date(event.start)));
    setMonth(new Date(new Date(event.start).getFullYear(), new Date(event.start).getMonth(), 1));
    if (!syncExternal || !accountId) { setNotice("日程已保存到 DepDek 本地日历"); return; }
    const taskId = onStartTask?.({ kind: "calendar_sync", title: "同步新日程", detail: "本地日程已保存，准备写回外部日历", progress: { current: 0, total: 1, label: "写回外部" }, logs: [{ ts: Date.now(), level: "info", message: `准备写回「${event.title}」` }] });
    try {
      if (browserPreview) {
        if (taskId) onUpdateTask?.(taskId, { status: "success", detail: "示例写回已完成", progress: { current: 1, total: 1, label: "完成" }, finishedAt: Date.now(), log: { level: "success", message: "浏览器预览未连接外部日历" } });
        setNotice("日程已保存到本地 · 预览模式未写回外部");
      } else {
        const result = await api.calendarPush(accountId, event);
        // Keep the remote identity in the local canonical record.  This makes
        // the next pull idempotent instead of creating a duplicate event.
        const account = accounts.find((item) => item.id === accountId);
        const syncedEvent: api.CalendarEvent = {
          ...event,
          remote_id: result.remote_id,
          source_account_id: accountId,
          source_name: account?.name ?? event.source_name,
          updated_at: new Date().toISOString(),
        };
        await saveEvents(next.map((item) => item.id === event.id ? syncedEvent : item));
        if (taskId) onUpdateTask?.(taskId, { status: "success", detail: "已写回外部日历", progress: { current: 1, total: 1, label: "完成" }, finishedAt: Date.now(), log: { level: "success", message: "外部日历已确认写回" } });
        setNotice("日程已保存，并已写回外部日历");
      }
    } catch (error) {
      const message = String(error);
      if (taskId) onUpdateTask?.(taskId, { status: "error", detail: "外部写回失败", message, finishedAt: Date.now(), log: { level: "error", message } });
      setNotice(`日程已保存在本地，但外部写回失败：${message}`);
    }
  };

  const moveMonth = (delta: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));

  const addEventToTodo = async (event: api.CalendarEvent) => {
    try {
      await enqueueTodo({
        title: event.title,
        description: [event.location, event.description].filter(Boolean).join(" · ") || undefined,
        priority: "important_not_urgent",
        dueAt: event.start,
        source: { type: "calendar", id: event.id, remoteId: event.remote_id, label: event.source_name ?? "DepDek 日历" },
        dedupeKey: `calendar:${event.id}`,
      });
      setNotice("日历事件已加入统一待办队列");
    } catch (error) {
      setNotice(`加入待办失败：${String(error)}`);
    }
  };

  return <>
    <div className="dd-view-head dd-calendar-head"><div><div className="dd-eyebrow">CALENDAR / 时间主权</div><h1>日历</h1></div><span>外部日历回到本地 · DepDek 是你的日程中枢 · 写回逐次确认</span></div>
    <section className="dd-calendar-toolbar"><div className="dd-calendar-filter"><CalendarBlank size={17} /><select aria-label="筛选日历" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}><option value="all">所有日历 · {events.length} 项</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></div><div className="dd-calendar-toolbar-actions"><button onClick={() => { setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDate(dayKey(today)); }}>今天</button><button onClick={() => void syncCalendars()} disabled={syncing}><ArrowClockwise size={16} />{syncing ? "同步中…" : "同步日历"}</button><button onClick={() => openAccountSettings()}><LinkSimple size={16} />连接日历</button><button className="dd-calendar-primary" onClick={() => setEventModalOpen(true)}><Plus size={16} />新建日程</button></div></section>
    {notice && <div className={`dd-calendar-notice ${notice.includes("失败") ? "dd-calendar-notice--error" : ""}`}>{notice.includes("失败") ? <WarningCircle size={15} /> : <CheckCircle size={15} />}{notice}</div>}
    <section className="dd-calendar-layout">
      <aside className="dd-calendar-sidebar"><div className="dd-calendar-side-title"><b>我的日历</b><button onClick={() => openAccountSettings()} aria-label="添加日历连接"><Plus size={15} /></button></div>{accounts.map((account) => { const state = connectionStates[account.id] ?? { status: "idle" as CalendarConnectionStatus, logs: [] }; const statusText = state.status === "connecting" ? "连接中…" : state.status === "connected" ? `已连接${state.lastSyncAt ? ` · ${formatConnectionTime(state.lastSyncAt)}` : ""}` : state.status === "error" ? "连接失败" : "未连接"; return <div key={account.id} className={`dd-calendar-account ${accountFilter === account.id ? "dd-calendar-account--active" : ""}`}><button className="dd-calendar-account-main" onClick={() => setAccountFilter(account.id)}><span className={`dd-calendar-account-dot dd-calendar-account-dot--${account.provider}`} /><span className="dd-calendar-account-copy"><b>{account.name}</b><small>{PROVIDERS[account.provider].label} · {PROVIDERS[account.provider].write ? "可写" : "只读"}</small><em className={`dd-calendar-account-status dd-calendar-account-status--${state.status}`}>{state.status === "connecting" && <CircleNotch size={11} className="dd-calendar-spin" />}{state.status === "connected" && <CheckCircle size={11} />}{state.status === "error" && <WarningCircle size={11} />}{statusText}</em></span></button><div className="dd-calendar-account-actions"><button className="dd-calendar-account-settings" onClick={(event) => { event.stopPropagation(); openAccountSettings(account); }} aria-label={`设置${account.name}`}><GearSix size={12} /></button><button className="dd-calendar-account-connect" onClick={() => void syncCalendars(account.id)} disabled={state.status === "connecting"}>{state.status === "connecting" ? "连接中" : state.status === "error" ? "重试" : "连接"}</button></div>{state.status === "error" && <div className="dd-calendar-account-error"><div><WarningCircle size={13} /><span>{state.error}</span></div>{state.logs.length > 0 && <details><summary>查看连接日志（{state.logs.length}）</summary><pre>{state.logs.join("\n")}</pre></details>}</div>}</div>; })}{!accounts.length && !loading && <div className="dd-calendar-empty-side">连接 Google、Outlook、Apple、CalDAV 或 ICS 日历，统一带回本地。</div>}<div className="dd-calendar-hub-note"><CloudArrowUp size={16} /><span><b>本地中枢</b><small>事件先保存到 `calendar/events.json`，外部写回需单独确认。</small></span></div></aside>
      <div className="dd-calendar-main"><div className="dd-calendar-month-head"><button onClick={() => moveMonth(-1)} aria-label="上个月"><CaretLeft size={17} /></button><h2>{monthLabel(month)}</h2><button onClick={() => moveMonth(1)} aria-label="下个月"><CaretRight size={17} /></button><span>{monthEventCount} 项日程</span></div><div className="dd-calendar-weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div><div className="dd-calendar-grid">{monthDays.map((day) => { const key = dayKey(day); const dayEvents = filteredEvents.filter((event) => dayKey(new Date(event.start)) === key); return <button key={key} className={`dd-calendar-day ${day.getMonth() !== month.getMonth() ? "dd-calendar-day--muted" : ""} ${key === selectedDate ? "dd-calendar-day--selected" : ""} ${key === dayKey(today) ? "dd-calendar-day--today" : ""}`} onClick={() => setSelectedDate(key)}><time>{day.getDate()}</time><div>{dayEvents.slice(0, 3).map((event) => <span key={event.id} className="dd-calendar-event-chip" title={event.title}>{event.title}</span>)}{dayEvents.length > 3 && <small>+{dayEvents.length - 3} 项</small>}</div></button>; })}</div></div>
      <aside className="dd-calendar-agenda"><header><div><span>选中日期</span><h2>{formatDay(dateAtKey(selectedDate))}</h2></div><button onClick={() => setEventModalOpen(true)} aria-label="在选中日期新建日程"><Plus size={17} /></button></header>{selectedEvents.length ? <div className="dd-calendar-agenda-list">{selectedEvents.map((event) => <article key={event.id} className="dd-calendar-agenda-item"><time>{formatTime(event.start, event.all_day)}{!event.all_day && ` – ${formatTime(event.end)}`}</time><b>{event.title}</b>{event.location && <span><MapPin size={13} />{event.location}</span>}<small>{event.source_name ?? "DepDek 本地日历"}</small><button className="dd-calendar-add-todo" onClick={() => void addEventToTodo(event)}><CheckSquare size={13} />加入待办</button></article>)}</div> : <div className="dd-calendar-empty-agenda"><CalendarBlank size={28} /><b>这一天还没有日程</b><span>点击右上角加号，在本地中枢创建一项。</span></div>}</aside>
    </section>
    {accountModalOpen && <AccountModal initial={editingAccount} onClose={() => { setAccountModalOpen(false); setEditingAccount(null); }} onSave={addAccount} />}
    {eventModalOpen && <EventModal accounts={accounts} defaultDate={dateAtKey(selectedDate)} onClose={() => setEventModalOpen(false)} onSave={addEvent} />}
  </>;
}
