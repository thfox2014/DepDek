import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowClockwise,
  CheckCircle,
  EnvelopeSimple,
  FunnelSimple,
  GearSix,
  PencilSimple,
  Plus,
  Sparkle,
  Star,
  Tray,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import * as api from "../api";
import "./inbox.css";

const CONFIG_PATH = "mail/accounts.json";
const INDEX_PATH = "mail/index.json";

type MailMessage = {
  id: string;
  path?: string;
  account: string;
  subject: string;
  sender: string;
  recipients: string;
  date: string;
  preview: string;
  body: string;
  unread: boolean;
  starred?: boolean;
};

type AccountDraft = api.MailAccount;
type MailFolder = "inbox" | "starred" | "drafts" | "archive";
type MailMessageState = {
  read?: boolean;
  starred?: boolean;
  archived?: boolean;
};

type MailIndexFile = {
  version: 1;
  updated_at: string;
  messages: Record<string, MailMessageState>;
};

const PREVIEW_ACCOUNTS: api.MailAccount[] = [
  { name: "个人邮箱", host: "imap.example.com", user: "me@example.com", password: "preview", secure: true },
];

const PREVIEW_MESSAGES: MailMessage[] = [
  {
    id: "preview-alice",
    account: "个人邮箱",
    subject: "Re: Q3 预算表 v2 已更新",
    sender: "Alice Chen <alice@example.com>",
    recipients: "me@example.com",
    date: "今天 17:42",
    preview: "口径我核对过了：订阅按年摊销、硬件计入当月。两处小数差已在批注标出。",
    body: "口径我核对过了：订阅按年摊销、硬件计入当月。两处小数差已在批注标出。\n\n如果你确认，我明天上午把最终版本发给财务。",
    unread: true,
    starred: true,
  },
  {
    id: "preview-domain",
    account: "个人邮箱",
    subject: "域名续费提醒：depdek.com",
    sender: "Cloud Registrar <billing@example.com>",
    recipients: "me@example.com",
    date: "今天 15:08",
    preview: "你的域名将在 7 天后到期。续费金额为 ¥128，点击查看账单详情。",
    body: "你的域名将在 7 天后到期。续费金额为 ¥128，点击查看账单详情。",
    unread: true,
  },
  {
    id: "preview-github",
    account: "个人邮箱",
    subject: "DepDek · Pull request 已通过审查",
    sender: "GitHub <notifications@github.com>",
    recipients: "me@example.com",
    date: "昨天 21:16",
    preview: "PR #42 的所有检查已通过，等待合并。",
    body: "PR #42 的所有检查已通过，等待合并。",
    unread: false,
  },
  {
    id: "preview-calendar",
    account: "个人邮箱",
    subject: "明日 13:00 · DepDek 重构评审",
    sender: "Calendar <calendar@example.com>",
    recipients: "me@example.com",
    date: "昨天 09:30",
    preview: "会议室 B · 与李雯、Chen 等 6 人参加。",
    body: "会议室 B\n与李雯、Chen 等 6 人参加。",
    unread: false,
  },
];

function parseHeader(lines: string[], key: string): string {
  const line = lines.find((item) => item.startsWith(`- **${key}:**`));
  return line?.slice(`- **${key}:**`.length).trim() ?? "";
}

function parseMailMarkdown(account: string, path: string, content: string): MailMessage {
  const lines = content.split(/\r?\n/);
  const separator = lines.indexOf("---");
  const body = (separator >= 0 ? lines.slice(separator + 1) : lines.slice(1)).join("\n").trim();
  const date = parseHeader(lines, "Date");
  return {
    id: path,
    path,
    account,
    subject: lines[0]?.replace(/^#\s*/, "").trim() || "(无主题)",
    sender: parseHeader(lines, "From") || "未知发件人",
    recipients: parseHeader(lines, "To"),
    date: date ? new Date(date).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
    preview: body.replace(/\s+/g, " ").slice(0, 100),
    body: body || "（没有可显示的正文）",
    unread: true,
  };
}

function AccountModal({ initial, onClose, onSave }: { initial: AccountDraft | null; onClose: () => void; onSave: (account: AccountDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<AccountDraft>(initial ?? {
    name: "",
    host: "",
    port: 993,
    secure: true,
    user: "",
    password: "",
    mailbox: "INBOX",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (next: Partial<AccountDraft>) => setDraft((current) => ({ ...current, ...next }));

  const submit = async () => {
    if (!draft.name.trim() || !draft.host.trim() || !draft.user.trim() || !draft.password.trim()) {
      setError("请填写账号名称、IMAP 主机、邮箱地址和授权码。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, name: draft.name.trim(), host: draft.host.trim(), user: draft.user.trim() });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dd-inbox-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dd-inbox-modal" role="dialog" aria-modal="true" aria-label="邮箱账户设置">
        <header>
          <span className="dd-inbox-modal-icon"><EnvelopeSimple size={20} /></span>
          <div><h2>{initial ? "编辑邮箱账户" : "添加邮箱账户"}</h2><p>DepDek 只通过 IMAP 读取邮件，并将副本写入本地 Home。</p></div>
          <button className="dd-icon-button" onClick={onClose} aria-label="关闭账户设置"><X size={18} /></button>
        </header>
        <div className="dd-inbox-form">
          <label>显示名称<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：个人邮箱" /></label>
          <label>邮箱地址<input type="email" value={draft.user} onChange={(event) => patch({ user: event.target.value })} placeholder="you@example.com" /></label>
          <div className="dd-inbox-form-row"><label>IMAP 主机<input value={draft.host} onChange={(event) => patch({ host: event.target.value })} placeholder="imap.example.com" /></label><label>端口<input type="number" value={draft.port ?? 993} onChange={(event) => patch({ port: Number(event.target.value) || 993 })} /></label></div>
          <div className="dd-inbox-form-row"><label>授权码 / 密码<input type="password" value={draft.password} onChange={(event) => patch({ password: event.target.value })} placeholder={initial ? "已保存 · 如需更换再输入" : "客户端授权码"} /></label><label>文件夹<input value={draft.mailbox ?? "INBOX"} onChange={(event) => patch({ mailbox: event.target.value })} /></label></div>
          <label className="dd-inbox-checkbox"><input type="checkbox" checked={draft.secure !== false} onChange={(event) => patch({ secure: event.target.checked })} />使用 TLS 安全连接（推荐）</label>
          {error && <p className="dd-inbox-error">{error}</p>}
        </div>
        <footer><span>凭据只写入当前 Home，不会进入模型上下文。</span><button onClick={onClose}>取消</button><button className="dd-primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存账户"}</button></footer>
      </section>
    </div>
  );
}

export default function InboxView() {
  const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const [accounts, setAccounts] = useState<api.MailAccount[] | null>(null);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [messageStates, setMessageStates] = useState<Record<string, MailMessageState>>({});
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [accountModal, setAccountModal] = useState<AccountDraft | null | undefined>(undefined);

  const loadAccounts = useCallback(async () => {
    if (browserPreview) {
      setAccounts(PREVIEW_ACCOUNTS);
      setSelectedAccount((current) => current || PREVIEW_ACCOUNTS[0]?.name || "");
      setLoading(false);
      return;
    }
    try {
      const result = await api.vaultReadFile(CONFIG_PATH);
      const parsed = JSON.parse(result.content) as { accounts?: api.MailAccount[] };
      const next = parsed.accounts ?? [];
      setAccounts(next);
      setSelectedAccount((current) => current && next.some((account) => account.name === current) ? current : next[0]?.name ?? "");
    } catch (e) {
      if (!String(e).includes("E32002")) setNotice(`读取邮箱账户失败：${String(e)}`);
      setAccounts([]);
      setSelectedAccount("");
    } finally {
      setLoading(false);
    }
  }, [browserPreview]);

  const loadMessageIndex = useCallback(async () => {
    if (browserPreview) {
      setMessageStates({});
      return;
    }
    try {
      const result = await api.vaultReadFile(INDEX_PATH);
      const parsed = JSON.parse(result.content) as Partial<MailIndexFile>;
      const next = parsed.messages ?? {};
      setMessageStates(next);
      setReadIds(new Set(Object.entries(next).filter(([, state]) => state.read).map(([id]) => id)));
      setArchivedIds(new Set(Object.entries(next).filter(([, state]) => state.archived).map(([id]) => id)));
    } catch (e) {
      // An index is derived metadata. A missing or malformed index must never
      // make locally cached mail unreadable; it will be rebuilt by user actions.
      if (!String(e).includes("E32002")) setNotice(`读取邮件状态失败，将使用默认状态：${String(e)}`);
      setMessageStates({});
      setReadIds(new Set());
      setArchivedIds(new Set());
    }
  }, [browserPreview]);

  const loadMessages = useCallback(async (accountName: string) => {
    if (browserPreview) {
      setMessages(PREVIEW_MESSAGES.filter((message) => message.account === accountName));
      setSelectedMessageId((current) => current && PREVIEW_MESSAGES.some((message) => message.id === current) ? current : PREVIEW_MESSAGES[0]?.id ?? null);
      return;
    }
    try {
      const { entries } = await api.vaultListDir(`mail/${accountName}`);
      const files = entries.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md")).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 100);
      const loaded = await Promise.all(files.map(async (entry) => {
        const path = `mail/${accountName}/${entry.name}`;
        const result = await api.vaultReadFile(path);
        return parseMailMarkdown(accountName, path, result.content);
      }));
      setMessages(loaded);
      setSelectedMessageId((current) => current && loaded.some((message) => message.id === current) ? current : loaded[0]?.id ?? null);
    } catch (e) {
      setMessages([]);
      setSelectedMessageId(null);
      setNotice(`读取本地邮件失败：${String(e)}`);
    }
  }, [browserPreview]);

  useEffect(() => { void loadAccounts(); void loadMessageIndex(); }, [loadAccounts, loadMessageIndex]);
  useEffect(() => { if (selectedAccount) void loadMessages(selectedAccount); }, [loadMessages, selectedAccount]);

  const hydratedMessages = useMemo(() => messages.map((message) => {
    const state = messageStates[message.id];
    return {
      ...message,
      unread: state?.read ? false : message.unread,
      starred: state?.starred ?? message.starred,
    };
  }), [messageStates, messages]);
  const selectedMessage = hydratedMessages.find((message) => message.id === selectedMessageId) ?? null;
  const visibleMessages = useMemo(() => {
    if (folder === "starred") return hydratedMessages.filter((message) => message.starred && !archivedIds.has(message.id));
    if (folder === "archive") return hydratedMessages.filter((message) => archivedIds.has(message.id));
    if (folder === "drafts") return [];
    return hydratedMessages.filter((message) => !archivedIds.has(message.id));
  }, [archivedIds, folder, hydratedMessages]);
  const unreadCount = hydratedMessages.filter((message) => message.unread && !readIds.has(message.id) && !archivedIds.has(message.id)).length;
  const aiItems = useMemo(() => hydratedMessages.filter((message) => message.unread && !readIds.has(message.id) && !archivedIds.has(message.id)).slice(0, 3), [archivedIds, hydratedMessages, readIds]);

  const persistMessageState = useCallback(async (id: string, patch: MailMessageState) => {
    const next = {
      ...messageStates,
      [id]: { ...messageStates[id], ...patch },
    };
    setMessageStates(next);
    if (patch.read !== undefined) {
      setReadIds((current) => {
        const updated = new Set(current);
        if (patch.read) updated.add(id); else updated.delete(id);
        return updated;
      });
    }
    if (patch.archived !== undefined) {
      setArchivedIds((current) => {
        const updated = new Set(current);
        if (patch.archived) updated.add(id); else updated.delete(id);
        return updated;
      });
    }
    if (browserPreview) return;
    try {
      const index: MailIndexFile = { version: 1, updated_at: new Date().toISOString(), messages: next };
      await api.vaultWriteFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
    } catch (e) {
      setNotice(`保存邮件状态失败：${String(e)}`);
    }
  }, [browserPreview, messageStates]);

  const toggleStar = () => {
    if (!selectedMessageId) return;
    const currentStarred = Boolean(selectedMessage?.starred);
    void persistMessageState(selectedMessageId, { starred: !currentStarred });
  };

  const archiveSelected = () => {
    if (!selectedMessageId) return;
    void persistMessageState(selectedMessageId, { archived: true });
    setSelectedMessageId(null);
    setNotice("邮件已移入本地归档");
  };

  const fetchMail = async () => {
    if (!selectedAccount) return;
    setSyncing(true);
    setNotice(null);
    try {
      if (browserPreview) {
        setNotice("示例邮箱已是最新 · 本地 UX 预览不会连接外部服务器");
      } else {
        const result = await api.mailFetch(selectedAccount);
        const resultAccount = result.accounts.find((account) => account.name === selectedAccount);
        setNotice(resultAccount?.error ?? `同步完成 · 新收到 ${resultAccount?.new_messages ?? 0} 封邮件`);
        await loadMessages(selectedAccount);
      }
    } catch (e) {
      setNotice(`同步失败：${String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const saveAccount = async (account: AccountDraft) => {
    const current = accounts ?? [];
    const next = current.some((item) => item.name === account.name)
      ? current.map((item) => item.name === account.name ? { ...item, ...account } : item)
      : [...current, account];
    if (!browserPreview) await api.vaultWriteFile(CONFIG_PATH, JSON.stringify({ accounts: next }, null, 2) + "\n");
    setAccounts(next);
    setSelectedAccount(account.name);
    setAccountModal(undefined);
    setNotice(browserPreview ? "账户已保存到 UX 预览状态" : "账户已保存到本地 Home");
  };

  return (
    <>
      <div className="dd-view-head dd-inbox-head"><div><div className="dd-eyebrow">INBOX / 邮件与行动</div><h1>收件箱</h1></div><span>邮件回到本地 Home · AI 只整理，不代替你发送</span></div>
      <section className="dd-inbox-toolbar">
        <div className="dd-inbox-account"><EnvelopeSimple size={17} /><select aria-label="选择邮箱账户" value={selectedAccount} onChange={(event) => setSelectedAccount(event.target.value)} disabled={!accounts?.length}>{accounts?.map((account) => <option key={account.name} value={account.name}>{account.name} · {account.user}</option>)}</select><button className="dd-inbox-account-settings" onClick={() => setAccountModal(accounts?.find((account) => account.name === selectedAccount) ?? null)} aria-label="设置邮箱账户"><GearSix size={16} /></button></div>
        <div className="dd-inbox-toolbar-actions"><button className={aiOpen ? "dd-inbox-ai-button dd-inbox-ai-button--active" : "dd-inbox-ai-button"} onClick={() => setAiOpen((current) => !current)}><Sparkle size={17} />AI 整理{unreadCount > 0 && <em>{unreadCount}</em>}</button><button onClick={fetchMail} disabled={syncing || !selectedAccount}><ArrowClockwise size={16} />{syncing ? "同步中…" : "收取邮件"}</button><button onClick={() => setAccountModal(null)}><Plus size={16} />添加账户</button></div>
      </section>
      {notice && <div className="dd-inbox-notice"><CheckCircle size={15} />{notice}</div>}
      {aiOpen && <section className="dd-inbox-ai-panel"><div><div className="dd-inbox-ai-title"><Sparkle size={16} />本地 AI 整理建议</div><p>基于当前 Home 中的邮件副本生成；不会外发邮件内容。</p></div><div className="dd-inbox-ai-items">{aiItems.length ? aiItems.map((message) => <button key={message.id} onClick={() => { setSelectedMessageId(message.id); void persistMessageState(message.id, { read: true }); }}><b>{message.subject}</b><span>{message.subject.includes("续费") ? "付款截止 · 建议今晚处理" : "检测到待回复或行动项"}</span></button>) : <span className="dd-inbox-empty-ai">当前没有需要整理的未读邮件。</span>}</div></section>}
      <section className="dd-inbox-shell">
        <aside className="dd-inbox-folders"><div className="dd-inbox-section-label">邮箱</div><button className={`dd-inbox-folder ${folder === "inbox" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("inbox")}><Tray size={17} />收件箱 <em>{unreadCount}</em></button><button className={`dd-inbox-folder ${folder === "starred" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("starred")}><Star size={17} />已标记</button><button className={`dd-inbox-folder ${folder === "drafts" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("drafts")}><PencilSimple size={17} />草稿</button><button className={`dd-inbox-folder ${folder === "archive" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("archive")}><Archive size={17} />已归档</button><div className="dd-inbox-section-label dd-inbox-section-label--accounts">账户</div>{accounts?.map((account) => <button className={`dd-inbox-folder dd-inbox-folder--account ${selectedAccount === account.name ? "dd-inbox-folder--selected" : ""}`} key={account.name} onClick={() => { setSelectedAccount(account.name); setFolder("inbox"); }}><UserCircle size={16} />{account.name}</button>)}{!accounts?.length && <div className="dd-inbox-no-account">还没有邮箱账户<br /><button onClick={() => setAccountModal(null)}>立即添加</button></div>}</aside>
        <div className="dd-inbox-list"><div className="dd-inbox-list-head"><b>{folder === "inbox" ? (selectedAccount || "收件箱") : folder === "starred" ? "已标记" : folder === "drafts" ? "草稿" : "已归档"}</b><span>{visibleMessages.length} 封邮件</span><button aria-label="筛选邮件"><FunnelSimple size={16} /></button></div>{loading ? <div className="dd-inbox-loading">加载邮箱账户…</div> : visibleMessages.length ? visibleMessages.map((message) => <button className={`dd-mail-item ${selectedMessageId === message.id ? "dd-mail-item--active" : ""} ${message.unread && !readIds.has(message.id) ? "dd-mail-item--unread" : ""}`} key={message.id} onClick={() => { setSelectedMessageId(message.id); void persistMessageState(message.id, { read: true }); }}><span className="dd-mail-unread-dot" /><div className="dd-mail-item-main"><div className="dd-mail-item-meta"><b>{message.sender.split("<")[0].trim()}</b><time>{message.date}</time></div><strong>{message.subject}</strong><p>{message.preview}</p></div>{message.starred && <Star className="dd-mail-star" size={15} weight="fill" />}</button>) : <div className="dd-inbox-empty"><EnvelopeSimple size={28} /><b>{folder === "drafts" ? "还没有草稿" : "这里还没有邮件"}</b><span>{folder === "inbox" ? "收取邮件或添加一个邮箱账户开始。" : "邮件会在本地 Home 中保持可回溯。"}</span></div>}</div>
        <article className="dd-inbox-reader">{selectedMessage ? <><header className="dd-inbox-reader-head"><div><h2>{selectedMessage.subject}</h2><div className="dd-inbox-reader-meta"><UserCircle size={17} /><b>{selectedMessage.sender}</b><span>发给 {selectedMessage.recipients || "我"}</span><time>{selectedMessage.date}</time></div></div><div className="dd-inbox-reader-actions"><button onClick={toggleStar} aria-label="标记星标"><Star size={17} weight={selectedMessage.starred ? "fill" : "regular"} /></button><button onClick={archiveSelected} aria-label="归档邮件"><Archive size={17} /></button></div></header><div className="dd-inbox-reader-source"><span>来源：{selectedMessage.account} · 本地副本</span>{selectedMessage.unread && <em>AI 待整理</em>}</div><div className="dd-inbox-reader-body">{selectedMessage.body.split(/\n+/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div><footer className="dd-inbox-reader-footer"><button onClick={() => setAiOpen(true)}><Sparkle size={16} />让 AI 提取行动项</button><button><PencilSimple size={16} />回复（原型）</button></footer></> : <div className="dd-inbox-reader-empty"><EnvelopeSimple size={34} /><b>选择一封邮件</b><span>邮件内容会保留在本地 Home，并可回溯来源。</span></div>}</article>
      </section>
      {accountModal !== undefined && <AccountModal initial={accountModal} onClose={() => setAccountModal(undefined)} onSave={saveAccount} />}
    </>
  );
}
