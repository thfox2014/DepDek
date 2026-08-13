import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "dompurify";
import {
  Archive,
  ArrowBendUpRight,
  ArrowClockwise,
  CheckCircle,
  CheckSquare,
  DownloadSimple,
  EnvelopeSimple,
  FunnelSimple,
  FolderSimple,
  GearSix,
  PencilSimple,
  Plus,
  Paperclip,
  Sparkle,
  Star,
  Trash,
  Tray,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import * as api from "../api";
import type { TaskReporter } from "../taskTypes";
import { enqueueTodo } from "../todoStore";
import AIAnalysisPanel from "./AIAnalysisPanel";
import "./inbox.css";

const CONFIG_PATH = "mail/accounts.json";
const INDEX_PATH = "mail/index.json";
// Read mail bodies in bounded batches. The list keeps native scrolling while
// avoiding a Promise.all over every local message at first paint.
const MAIL_CHUNK_SIZE = 40;
const MAIL_MIN_VISIBLE = 8;

type MailMessage = {
  id: string;
  path?: string;
  account: string;
  uid?: number;
  subject: string;
  sender: string;
  recipients: string;
  date: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  preview: string;
  body: string;
  htmlBody?: string;
  attachments?: MailAttachment[];
  unread: boolean;
  starred?: boolean;
  /**
   * The local canonical folder recorded in the message markdown. UI state
   * may override it, but a message must still have one primary location when
   * the derived index is missing or was created by an older build.
   */
  folder?: MailFolder;
};

type MailAttachment = {
  name: string;
  path?: string;
  size?: number;
  mime?: string;
};

type AccountDraft = api.MailAccount;
type MailFolder = "inbox" | "starred" | "drafts" | "sent" | "trash" | "archive" | `remote:${string}`;
type MailSort = "date-desc" | "date-asc" | "sender-asc" | "sender-desc";
type MailMessageState = {
  read?: boolean;
  starred?: boolean;
  archived?: boolean;
  folder?: MailFolder;
};

type MailIndexFile = {
  version: 1;
  updated_at: string;
  messages: Record<string, MailMessageState>;
};

function parseMailFolder(value: string): MailFolder | undefined {
  const normalized = value.trim();
  if (normalized === "inbox" || normalized === "starred" || normalized === "drafts" || normalized === "sent" || normalized === "trash" || normalized === "archive") {
    return normalized;
  }
  if (normalized.startsWith("remote:") && normalized.length > "remote:".length) return normalized as MailFolder;
  return undefined;
}

function inferMailFolderFromPath(path: string): MailFolder | undefined {
  const parts = path.split(/[\\/]/);
  const filename = parts[parts.length - 1]?.toLocaleLowerCase() ?? "";
  // Composed copies created before the Folder header was added still carry a
  // stable prefix. Treat them as sent/draft mail rather than inbox mail.
  if (/^sent-(?:\d+|preview-)/.test(filename)) return "sent";
  if (/^draft-(?:\d+|preview-)/.test(filename)) return "drafts";
  return undefined;
}

function isInboxFolder(folder: MailFolder | undefined): boolean {
  return folder === undefined || folder === "inbox";
}

type MailFileEntry = {
  name: string;
  path: string;
};

type ComposeDraft = {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments: ComposeAttachment[];
};

type ComposeAttachment = api.MailSendAttachment;

type RemoteMailboxView = api.MailboxInfo & {
  canonical?: "inbox" | "drafts" | "sent" | "trash" | "archive" | "junk";
  label: string;
};

const MOVE_FOLDER_OPTIONS: Array<{ id: Exclude<MailFolder, "starred">; label: string }> = [
  { id: "inbox", label: "收件箱" },
  { id: "archive", label: "已归档" },
  { id: "drafts", label: "草稿箱" },
  { id: "sent", label: "已发送" },
  { id: "trash", label: "已删除" },
];

const REMOTE_FOLDER_ALIASES: Record<NonNullable<RemoteMailboxView["canonical"]>, string[]> = {
  inbox: ["inbox", "收件箱"],
  drafts: ["draft", "drafts", "草稿", "草稿箱"],
  sent: ["sent", "sent messages", "sent items", "sent mail", "已发送"],
  trash: ["trash", "deleted", "deleted messages", "deleted items", "bin", "已删除", "垃圾箱"],
  archive: ["archive", "archives", "all", "all mail", "all messages", "已归档"],
  junk: ["junk", "spam", "bulk", "垃圾邮件", "广告邮件"],
};

const REMOTE_FOLDER_LABELS: Record<string, string> = {
  inbox: "收件箱",
  draft: "草稿箱",
  drafts: "草稿箱",
  sent: "已发送",
  "sent messages": "已发送",
  "sent items": "已发送",
  "sent mail": "已发送",
  trash: "已删除",
  deleted: "已删除",
  "deleted messages": "已删除",
  "deleted items": "已删除",
  archive: "已归档",
  archives: "已归档",
  "all mail": "全部邮件",
  "all messages": "全部邮件",
  junk: "垃圾邮件",
  spam: "垃圾邮件",
  bulk: "垃圾邮件",
  "other folder": "其他文件夹",
  "other folders": "其他文件夹",
};

function normalizedMailboxName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\\/g, "").replace(/\s+/g, " ");
}

function canonicalRemoteMailbox(mailbox: api.MailboxInfo): RemoteMailboxView["canonical"] {
  const special = normalizedMailboxName(mailbox.special_use ?? "");
  const path = normalizedMailboxName(mailbox.path);
  if (special.includes("inbox") || path === "inbox") return "inbox";
  for (const [canonical, aliases] of Object.entries(REMOTE_FOLDER_ALIASES) as Array<[NonNullable<RemoteMailboxView["canonical"]>, string[]]>) {
    if (special.includes(canonical) || aliases.includes(path)) return canonical;
  }
  return undefined;
}

function remoteMailboxLabel(mailbox: api.MailboxInfo): string {
  const canonical = canonicalRemoteMailbox(mailbox);
  if (canonical) return REMOTE_FOLDER_LABELS[canonical] ?? mailbox.path;
  const parts = mailbox.path.split(/[\\/]/).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? mailbox.path;
  return REMOTE_FOLDER_LABELS[normalizedMailboxName(leaf)] ?? leaf;
}

function mergeRemoteMailboxes(mailboxes: api.MailboxInfo[]): RemoteMailboxView[] {
  const merged = new Map<string, RemoteMailboxView>();
  for (const mailbox of mailboxes) {
    if (!mailbox.path.trim()) continue;
    const canonical = canonicalRemoteMailbox(mailbox);
    const key = canonical ?? `remote:${normalizedMailboxName(mailbox.path)}`;
    const next: RemoteMailboxView = { ...mailbox, canonical, label: remoteMailboxLabel(mailbox) };
    const current = merged.get(key);
    // Prefer a SPECIAL-USE mailbox over a provider's translated alias (for
    // example `Sent` and `Sent Messages`) so actions target one folder.
    if (!current || (!current.special_use && next.special_use)) merged.set(key, next);
  }
  return [...merged.values()];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return window.btoa(binary);
}

async function fileToComposeAttachment(file: File): Promise<ComposeAttachment> {
  if (file.size > 32 * 1024 * 1024) throw new Error(`附件「${file.name}」超过 32 MiB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    name: file.name || "附件",
    mime: file.type || "application/octet-stream",
    size: bytes.byteLength,
    content_base64: bytesToBase64(bytes),
  };
}

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
    date: "2025年05月23日 17:42",
    preview: "口径我核对过了：订阅按年摊销、硬件计入当月。两处小数差已在批注标出。",
    body: "口径我核对过了：订阅按年摊销、硬件计入当月。两处小数差已在批注标出。\n\n如果你确认，我明天上午把最终版本发给财务。",
    attachments: [{ name: "Q3-预算表-v2.xlsx", path: "preview://q3-budget.xlsx", size: 28_640, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
    unread: true,
    starred: true,
  },
  {
    id: "preview-domain",
    account: "个人邮箱",
    subject: "域名续费提醒：depdek.com",
    sender: "Cloud Registrar <billing@example.com>",
    recipients: "me@example.com",
    date: "2025年05月23日 15:08",
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
    date: "2025年05月22日 21:16",
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
    date: "2025年05月22日 09:30",
    preview: "会议室 B · 与李雯、Chen 等 6 人参加。",
    body: "会议室 B\n与李雯、Chen 等 6 人参加。",
    unread: false,
  },
];

function parseHeader(lines: string[], key: string): string {
  const line = lines.find((item) => item.startsWith(`- **${key}:**`));
  return line?.slice(`- **${key}:**`.length).trim() ?? "";
}

const MAIL_HTML_BODY_START = "<!-- depdek:mail-html:start -->";
const MAIL_HTML_BODY_END = "<!-- depdek:mail-html:end -->";
const MAIL_TEXT_BODY_START = "<!-- depdek:mail-text:start -->";
const MAIL_TEXT_BODY_END = "<!-- depdek:mail-text:end -->";

function extractMailPart(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return "";
  const contentStart = startIndex + start.length;
  const endIndex = content.indexOf(end, contentStart);
  return content.slice(contentStart, endIndex >= 0 ? endIndex : content.length).trim();
}

function htmlToPreview(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatMailDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}年${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
}

function extractEmailAddress(value: string): string {
  const bracketed = value.match(/<([^>]+)>/);
  return bracketed?.[1]?.trim() || value.trim();
}

function formatAttachmentSize(size?: number): string {
  if (size === undefined || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function safeComposeAttachmentName(name: string, index: number): string {
  const parts = name.split(/[\\/]/);
  const leaf = parts[parts.length - 1]?.trim() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f:]/g, "_").slice(0, 160);
  return `${String(index + 1).padStart(2, "0")}-${cleaned || `attachment-${index + 1}`}`;
}

function parseMailUid(path: string, lines: string[]): number | undefined {
  const header = Number.parseInt(parseHeader(lines, "UID"), 10);
  if (Number.isSafeInteger(header) && header > 0) return header;
  const match = path.match(/-(\d+)\.md$/);
  const uid = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isSafeInteger(uid) && uid > 0 ? uid : undefined;
}

function parseAttachments(lines: string[]): MailAttachment[] {
  const stored = parseHeader(lines, "Attachments");
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const attachment = item as Partial<MailAttachment>;
          return typeof attachment.name === "string" && attachment.name.trim()
            ? [{ name: attachment.name, path: typeof attachment.path === "string" ? attachment.path : undefined, size: typeof attachment.size === "number" ? attachment.size : undefined, mime: typeof attachment.mime === "string" ? attachment.mime : undefined }]
            : [];
        });
      }
    } catch {
      // Keep reading the message even if one legacy metadata line is malformed.
    }
  }
  const legacy = parseHeader(lines, "Attachments (not saved)");
  return legacy ? legacy.split(/,\s*/).filter(Boolean).map((name) => ({ name })) : [];
}

function parseMailMarkdown(account: string, path: string, content: string): MailMessage {
  const lines = content.split(/\r?\n/);
  const separator = lines.indexOf("---");
  const legacyBody = (separator >= 0 ? lines.slice(separator + 1) : lines.slice(1)).join("\n").trim();
  const htmlBody = extractMailPart(content, MAIL_HTML_BODY_START, MAIL_HTML_BODY_END);
  const textBody = extractMailPart(content, MAIL_TEXT_BODY_START, MAIL_TEXT_BODY_END);
  const body = textBody || (htmlBody ? htmlToPreview(htmlBody) : legacyBody);
  const date = parseHeader(lines, "Date");
  const references = parseHeader(lines, "References");
  const readHeader = parseHeader(lines, "Read");
  const folder = parseMailFolder(parseHeader(lines, "Folder")) ?? inferMailFolderFromPath(path);
  return {
    id: path,
    path,
    account,
    uid: parseMailUid(path, lines),
    subject: lines[0]?.replace(/^#\s*/, "").trim() || "(无主题)",
    sender: parseHeader(lines, "From") || "未知发件人",
    recipients: parseHeader(lines, "To"),
    date: date ? formatMailDate(date) : "",
    messageId: parseHeader(lines, "Message-ID") || undefined,
    inReplyTo: parseHeader(lines, "In-Reply-To") || undefined,
    references: references ? references.split(/\s+/).filter(Boolean) : undefined,
    preview: body.replace(/\s+/g, " ").slice(0, 100),
    body: body || "（没有可显示的正文）",
    htmlBody: htmlBody || undefined,
    attachments: parseAttachments(lines),
    unread: readHeader ? readHeader.toLowerCase() !== "true" : true,
    folder,
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
    smtp_host: "",
    smtp_port: 465,
    smtp_secure: true,
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
          <div className="dd-inbox-form-row"><label>授权码 / 密码<input type="password" value={draft.password} onChange={(event) => patch({ password: event.target.value })} placeholder={initial ? "已保存 · 如需更换再输入" : "客户端授权码"} /></label><label>收件文件夹<input value={draft.mailbox ?? "INBOX"} onChange={(event) => patch({ mailbox: event.target.value })} /></label></div>
          <div className="dd-inbox-form-row"><label>SMTP 主机<input value={draft.smtp_host ?? ""} onChange={(event) => patch({ smtp_host: event.target.value })} placeholder="smtp.example.com（留空自动推断）" /></label><label>SMTP 端口<input type="number" value={draft.smtp_port ?? 465} onChange={(event) => patch({ smtp_port: Number(event.target.value) || 465 })} /></label></div>
          <label className="dd-inbox-checkbox"><input type="checkbox" checked={draft.smtp_secure !== false} onChange={(event) => patch({ smtp_secure: event.target.checked })} />SMTP 使用 SSL（465 端口推荐）</label>
          <label className="dd-inbox-checkbox"><input type="checkbox" checked={draft.secure !== false} onChange={(event) => patch({ secure: event.target.checked })} />使用 TLS 安全连接（推荐）</label>
          {error && <p className="dd-inbox-error">{error}</p>}
        </div>
        <footer><span>凭据只写入当前 Home，不会进入模型上下文。</span><button onClick={onClose}>取消</button><button className="dd-primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存账户"}</button></footer>
      </section>
    </div>
  );
}

function plainTextToEditorHtml(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<br>"}</p>`)
    .join("");
}

function RichMailEditor({
  text,
  html,
  onChange,
}: {
  text: string;
  html?: string;
  onChange: (nextHtml: string, nextText: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: html || plainTextToEditorHtml(text),
    editorProps: {
      attributes: {
        class: "dd-mail-editor-content",
        "aria-label": "邮件正文编辑器",
      },
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getHTML(), current.getText({ blockSeparator: "\n" }));
    },
  });

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    editor.commands.setContent(html || plainTextToEditorHtml(text), { emitUpdate: false });
  }, [editor, html, text]);

  if (!editor) return <div className="dd-mail-editor-loading">正在加载编辑器…</div>;
  return <div className="dd-mail-editor"><div className="dd-mail-editor-toolbar" role="toolbar" aria-label="邮件格式"><button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={editor.isActive("bold") ? "is-active" : ""}>粗体</button><button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={editor.isActive("italic") ? "is-active" : ""}>斜体</button><button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={editor.isActive("bulletList") ? "is-active" : ""}>列表</button><button type="button" onClick={() => editor.chain().focus().undo().run()}>撤销</button><button type="button" onClick={() => editor.chain().focus().redo().run()}>重做</button></div><EditorContent editor={editor} /></div>;
}

function ComposeMailModal({
  account,
  initial,
  mode,
  onClose,
  onSave,
  onSend,
}: {
  account: api.MailAccount | null;
  initial: ComposeDraft;
  mode: "new" | "reply" | "forward";
  onClose: () => void;
  onSave: (draft: ComposeDraft) => Promise<void>;
  onSend: (draft: ComposeDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ComposeDraft>({ ...initial, attachments: initial.attachments ?? [] });
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (next: Partial<ComposeDraft>) => setDraft((current) => ({ ...current, ...next }));

  const selectAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const selected = await Promise.all([...files].map(fileToComposeAttachment));
      const next = [...draft.attachments, ...selected];
      if (next.length > 20) throw new Error("附件数量不能超过 20 个");
      if (next.reduce((total, attachment) => total + (attachment.size ?? 0), 0) > 64 * 1024 * 1024) {
        throw new Error("附件总大小不能超过 64 MiB");
      }
      patch({ attachments: next });
    } catch (e) {
      setError(String(e));
    }
  };

  const submit = async () => {
    if (!account) {
      setError("请先添加或选择一个邮箱账户。");
      return;
    }
    if (!draft.to.trim()) {
      setError("请填写收件人。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, to: draft.to.trim(), subject: draft.subject.trim() });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    if (!account) {
      setError("请先添加或选择一个邮箱账户。");
      return;
    }
    if (!draft.to.trim()) {
      setError("请填写收件人。");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend({ ...draft, to: draft.to.trim(), subject: draft.subject.trim() });
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const title = mode === "reply" ? "回复邮件" : mode === "forward" ? "转发邮件" : "新邮件";

  return (
    <div className="dd-inbox-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dd-inbox-modal dd-inbox-compose-modal" role="dialog" aria-modal="true" aria-labelledby="dd-compose-mail-title">
        <header>
          <span className="dd-inbox-modal-icon"><PencilSimple size={20} /></span>
          <div><h2 id="dd-compose-mail-title">{title}</h2><p>邮件正文和凭据仅在本地处理；点击发送后通过当前账户的 SMTP 服务发送。</p></div>
          <button className="dd-icon-button" onClick={onClose} aria-label="关闭新邮件"><X size={18} /></button>
        </header>
        <div className="dd-inbox-form">
          <label>发件账户<input value={account?.user ?? ""} readOnly placeholder="请选择邮箱账户" /></label>
          <label>收件人<input type="email" value={draft.to} onChange={(event) => patch({ to: event.target.value })} placeholder="recipient@example.com" autoFocus /></label>
          <label>主题<input value={draft.subject} onChange={(event) => patch({ subject: event.target.value })} placeholder="邮件主题" /></label>
          <label>正文<RichMailEditor text={draft.body} html={draft.html} onChange={(html, text) => patch({ html, body: text })} /></label>
          <div className="dd-compose-attachments"><div className="dd-compose-attachments-head"><b><Paperclip size={15} />附件</b><label className="dd-compose-attach-button"><Paperclip size={14} />添加附件<input type="file" multiple onChange={(event) => { void selectAttachments(event.target.files); event.target.value = ""; }} /></label></div>{draft.attachments.length > 0 ? <div className="dd-compose-attachment-list">{draft.attachments.map((attachment, index) => <div className="dd-compose-attachment" key={`${attachment.name}-${index}`}><span><strong>{attachment.name}</strong><small>{formatAttachmentSize(attachment.size) || "附件"}</small></span><button type="button" onClick={() => patch({ attachments: draft.attachments.filter((_, attachmentIndex) => attachmentIndex !== index) })} aria-label={`移除附件 ${attachment.name}`}><X size={14} /></button></div>)}</div> : <small className="dd-compose-attachments-hint">支持多个附件，单个不超过 32 MiB，总计不超过 64 MiB。</small>}</div>
          {error && <p className="dd-inbox-error">{error}</p>}
        </div>
        <footer><span>发送前会保留本地副本，发送失败不会丢失草稿。</span><button onClick={onClose}>取消</button><button onClick={() => void submit()} disabled={saving || sending}>{saving ? "保存中…" : "保存草稿"}</button><button className="dd-primary" disabled={saving || sending} onClick={() => void send()}>{sending ? "发送中…" : "发送"}</button></footer>
      </section>
    </div>
  );
}

function DeleteMailModal({
  count,
  canDeleteRemote,
  onClose,
  onConfirm,
}: {
  count: number;
  canDeleteRemote: boolean;
  onClose: () => void;
  onConfirm: (syncRemote: boolean) => Promise<void>;
}) {
  const [syncRemote, setSyncRemote] = useState(false);

  const submit = () => {
    // The task center owns the long-running operation. Close this destructive
    // confirmation immediately; errors are retained in the task's full log.
    void onConfirm(syncRemote).catch(() => undefined);
    onClose();
  };

  return (
    <div className="dd-inbox-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dd-inbox-modal dd-inbox-delete-modal" role="dialog" aria-modal="true" aria-labelledby="dd-delete-mail-title">
        <header>
          <span className="dd-inbox-modal-icon dd-inbox-modal-icon--danger"><Trash size={20} /></span>
          <div><h2 id="dd-delete-mail-title">删除 {count} 封邮件</h2><p>邮件会先移入本地“已删除”，远端同步删除后不可恢复。</p></div>
          <button className="dd-icon-button" onClick={onClose} aria-label="关闭删除确认"><X size={18} /></button>
        </header>
        <div className="dd-inbox-form">
          <div className="dd-inbox-delete-question">是否同步删除远端邮箱邮件？</div>
          <label className={`dd-inbox-checkbox dd-inbox-remote-delete-option ${!canDeleteRemote ? "dd-inbox-checkbox--disabled" : ""}`}>
            <input type="checkbox" checked={syncRemote} disabled={!canDeleteRemote} onChange={(event) => setSyncRemote(event.target.checked)} />
            <span><b>同步删除远端邮箱中的邮件</b><small>{canDeleteRemote ? "远端删除后不可恢复，请确认邮箱服务商支持。" : "当前邮件缺少可用于远端定位的 UID，无法安全同步删除。"}</small></span>
          </label>
        </div>
        <footer><span>已选择 {count} 封邮件 · {syncRemote ? "将同步删除远端" : "移入本地已删除"}</span><button onClick={onClose}>取消</button><button className="dd-primary dd-danger-primary" onClick={submit}>{syncRemote ? "同步删除远端" : "移入已删除"}</button></footer>
      </section>
    </div>
  );
}

export default function InboxView({ onStartTask, onUpdateTask, onInboxCountChange }: TaskReporter & { onInboxCountChange?: (previewCount?: number) => void }) {
  const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const [accounts, setAccounts] = useState<api.MailAccount[] | null>(null);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [messageStates, setMessageStates] = useState<Record<string, MailMessageState>>({});
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [accountModal, setAccountModal] = useState<AccountDraft | null | undefined>(undefined);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<"new" | "reply" | "forward">("new");
  const [composeDraft, setComposeDraft] = useState<ComposeDraft>({ to: "", subject: "", body: "", attachments: [] });
  const [deleteTargets, setDeleteTargets] = useState<MailMessage[] | null>(null);
  const [readerMode, setReaderMode] = useState<"rich" | "plain">("rich");
  const [mailSort, setMailSort] = useState<MailSort>("date-desc");
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [mailContextMenu, setMailContextMenu] = useState<{ x: number; y: number; message: MailMessage } | null>(null);
  const [mailEntries, setMailEntries] = useState<MailFileEntry[]>([]);
  const [remoteMailboxes, setRemoteMailboxes] = useState<api.MailboxInfo[]>([]);
  const [loadedMessageCount, setLoadedMessageCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const mailLoadRequest = useRef(0);

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

  const loadRemoteMailboxes = useCallback(async (accountName: string) => {
    if (browserPreview) {
      setRemoteMailboxes([
        { path: "INBOX", special_use: "\\Inbox", subscribed: true },
        { path: "Archive", special_use: "\\Archive", subscribed: true },
        { path: "Trash", special_use: "\\Trash", subscribed: true },
      ]);
      return;
    }
    try {
      const result = await api.mailListMailboxes(accountName);
      setRemoteMailboxes(result.mailboxes);
    } catch (error) {
      // Folder discovery is optional: the local inbox must remain usable if a
      // provider does not expose LIST or the account is temporarily offline.
      setRemoteMailboxes([]);
      setNotice(`读取远端文件夹失败：${String(error)}`);
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
      setArchivedIds(new Set(Object.entries(next).filter(([, state]) => state.archived || state.folder === "archive").map(([id]) => id)));
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
    const requestId = mailLoadRequest.current + 1;
    mailLoadRequest.current = requestId;
    setLoading(true);
    setLoadingMore(false);
    setMailEntries([]);
    setLoadedMessageCount(0);
    setMessages([]);
    if (browserPreview) {
      const previewMessages = PREVIEW_MESSAGES.filter((message) => message.account === accountName);
      setMessages(previewMessages);
      setLoadedMessageCount(previewMessages.length);
      setSelectedMessageId((current) => current && previewMessages.some((message) => message.id === current) ? current : previewMessages[0]?.id ?? null);
      setLoading(false);
      return;
    }
    try {
      const { entries } = await api.vaultListDir(`mail/${accountName}`);
      const files = entries
        .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((entry) => ({ name: entry.name, path: `mail/${accountName}/${entry.name}` }));
      const firstChunk = files.slice(0, MAIL_CHUNK_SIZE);
      const loaded = await Promise.all(firstChunk.map(async (entry) => {
        const result = await api.vaultReadFile(entry.path);
        return parseMailMarkdown(accountName, entry.path, result.content);
      }));
      if (mailLoadRequest.current !== requestId) return;
      setMailEntries(files);
      setMessages(loaded);
      setLoadedMessageCount(firstChunk.length);
      setSelectedMessageId((current) => current && loaded.some((message) => message.id === current) ? current : loaded[0]?.id ?? null);
      onInboxCountChange?.();
    } catch (e) {
      if (mailLoadRequest.current !== requestId) return;
      setMailEntries([]);
      setLoadedMessageCount(0);
      setMessages([]);
      setSelectedMessageId(null);
      setNotice(`读取本地邮件失败：${String(e)}`);
    } finally {
      if (mailLoadRequest.current === requestId) setLoading(false);
    }
  }, [browserPreview, onInboxCountChange]);

  useEffect(() => { void loadAccounts(); void loadMessageIndex(); }, [loadAccounts, loadMessageIndex]);
  useEffect(() => { if (selectedAccount) { void loadMessages(selectedAccount); void loadRemoteMailboxes(selectedAccount); } }, [loadMessages, loadRemoteMailboxes, selectedAccount]);
  useEffect(() => { setSelectedIds(new Set()); }, [folder, selectedAccount]);
  useEffect(() => { setReaderMode("rich"); setMoveMenuOpen(false); }, [selectedMessageId]);
  useEffect(() => {
    if (!mailContextMenu) return;
    const close = () => setMailContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, [mailContextMenu]);

  const hydratedMessages = useMemo(() => messages.map((message) => {
    const state = messageStates[message.id];
    return {
      ...message,
      unread: state?.read ? false : message.unread,
      starred: state?.starred ?? message.starred,
      folder: state?.folder ?? message.folder,
    };
  }), [messageStates, messages]);
  const selectedMessage = hydratedMessages.find((message) => message.id === selectedMessageId) ?? null;
  const normalizedRemoteMailboxes = useMemo(() => mergeRemoteMailboxes(remoteMailboxes), [remoteMailboxes]);
  const junkMailbox = normalizedRemoteMailboxes.find((mailbox) => mailbox.canonical === "junk");
  const customRemoteMailboxes = normalizedRemoteMailboxes.filter((mailbox) => !mailbox.canonical);
  const moveRemoteMailboxes = normalizedRemoteMailboxes.filter((mailbox) => mailbox.canonical === "junk" || !mailbox.canonical);
  const remoteMailboxByPath = useMemo(() => new Map(normalizedRemoteMailboxes.map((mailbox) => [mailbox.path, mailbox])), [normalizedRemoteMailboxes]);
  const safeSelectedHtml = useMemo(() => selectedMessage?.htmlBody
    ? DOMPurify.sanitize(selectedMessage.htmlBody, {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onclick", "onload"],
    })
    : "", [selectedMessage]);
  const visibleMessages = useMemo(() => {
    const filtered = hydratedMessages.filter((message) => {
      const state = messageStates[message.id];
      const stateFolder = state?.folder ?? message.folder;
      const archived = Boolean(state?.archived || archivedIds.has(message.id) || stateFolder === "archive");
      if (folder.startsWith("remote:")) return !archived && stateFolder === folder;
      if (folder === "starred") return Boolean(message.starred) && !archived && stateFolder !== "trash";
      if (folder === "archive") return archived;
      if (folder === "drafts") return !archived && stateFolder === "drafts";
      if (folder === "sent") return !archived && stateFolder === "sent";
      if (folder === "trash") return !archived && stateFolder === "trash";
      return !archived && isInboxFolder(stateFolder);
    });
    return [...filtered].sort((a, b) => {
      if (mailSort.startsWith("sender")) {
        const senderCompare = a.sender.split("<")[0].trim().localeCompare(b.sender.split("<")[0].trim(), "zh-CN", { sensitivity: "base" });
        return mailSort === "sender-desc" ? -senderCompare : senderCompare;
      }
      const dateCompare = a.date.localeCompare(b.date);
      return mailSort === "date-asc" ? dateCompare : -dateCompare;
    });
  }, [archivedIds, folder, hydratedMessages, mailSort, messageStates]);
  const unreadCount = hydratedMessages.filter((message) => {
    const state = messageStates[message.id];
    const stateFolder = state?.folder ?? message.folder;
    return message.unread && !readIds.has(message.id) && !archivedIds.has(message.id) && isInboxFolder(stateFolder);
  }).length;
  const inboxMessageCount = browserPreview
    ? hydratedMessages.filter((message) => {
      const state = messageStates[message.id];
      const stateFolder = state?.folder ?? message.folder;
      return message.unread && !readIds.has(message.id) && !archivedIds.has(message.id) && isInboxFolder(stateFolder);
    }).length
    : mailEntries.filter((entry) => {
      const state = messageStates[entry.path];
      const stateFolder = state?.folder ?? inferMailFolderFromPath(entry.path);
      return !state?.read && !state?.archived && isInboxFolder(stateFolder);
    }).length;
  const aiItems = useMemo(() => hydratedMessages.filter((message) => {
    const state = messageStates[message.id];
    const stateFolder = state?.folder ?? message.folder;
    return message.unread && !readIds.has(message.id) && !archivedIds.has(message.id) && isInboxFolder(stateFolder);
  }).slice(0, 3), [archivedIds, hydratedMessages, messageStates, readIds]);
  const mailAnalysisContext = useMemo(() => ({
    domain: "mail" as const,
    title: selectedMessage ? `邮件：${selectedMessage.subject}` : `收件箱：${selectedAccount || "当前账户"}`,
    sources: (selectedMessage ? [selectedMessage] : visibleMessages.slice(0, 12)).map((message) => ({
      label: message.subject,
      path: message.path,
      content: `发件人：${message.sender}\n收件人：${message.recipients}\n日期：${message.date}\n主题：${message.subject}\n正文摘要：${message.preview}\n正文：${message.body.slice(0, 3500)}`,
    })),
  }), [selectedAccount, selectedMessage, visibleMessages]);
  const hasMoreMessages = loadedMessageCount < mailEntries.length;

  const loadMoreMessages = useCallback(async () => {
    if (browserPreview || !selectedAccount || loadingMore || !hasMoreMessages) return;
    const requestId = mailLoadRequest.current;
    const start = loadedMessageCount;
    const nextEntries = mailEntries.slice(start, start + MAIL_CHUNK_SIZE);
    if (!nextEntries.length) return;
    setLoadingMore(true);
    try {
      const loaded = await Promise.all(nextEntries.map(async (entry) => {
        const result = await api.vaultReadFile(entry.path);
        return parseMailMarkdown(selectedAccount, entry.path, result.content);
      }));
      if (mailLoadRequest.current !== requestId) return;
      setMessages((current) => [...current, ...loaded]);
      setLoadedMessageCount(start + nextEntries.length);
    } catch (e) {
      if (mailLoadRequest.current === requestId) setNotice(`继续加载邮件失败：${String(e)}`);
    } finally {
      if (mailLoadRequest.current === requestId) setLoadingMore(false);
    }
  }, [browserPreview, hasMoreMessages, loadedMessageCount, loadingMore, mailEntries, selectedAccount]);

  // Starred/archive folders can be sparse. Fill the first viewport from later
  // chunks until it has enough rows to scroll, without loading the whole inbox.
  useEffect(() => {
    if (folder === "drafts" || loading || loadingMore || !hasMoreMessages || visibleMessages.length >= MAIL_MIN_VISIBLE) return;
    void loadMoreMessages();
  }, [folder, hasMoreMessages, loadMoreMessages, loading, loadingMore, visibleMessages.length]);

  const handleMailListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - (element.scrollTop + element.clientHeight) < element.clientHeight * 0.75) void loadMoreMessages();
  }, [loadMoreMessages]);

  const runRemoteMailAction = useCallback(async (
    action: api.MailActionName,
    targets: MailMessage[],
    options: { destination?: string; silent?: boolean } = {},
  ): Promise<api.MailActionResult | null> => {
    if (browserPreview) return null;
    const uids = targets.map((message) => message.uid).filter((uid): uid is number => uid !== undefined);
    if (!uids.length) throw new Error("所选邮件缺少远端 UID，无法同步操作");
    const taskId = options.silent ? undefined : onStartTask?.({
      kind: "mail_action",
      title: `处理 ${targets.length} 封邮件`,
      detail: `准备执行${action === "mark_read" ? "标记已读" : action === "mark_unread" ? "标记未读" : action === "star" ? "添加星标" : action === "unstar" ? "取消星标" : action === "archive" ? "归档" : action === "trash" ? "移入垃圾箱" : "移动"}`,
      progress: { current: 0, total: uids.length, label: "准备执行" },
      logs: [{ ts: Date.now(), level: "info", message: `准备串行处理 ${uids.length} 个远端 UID` }],
    });
    let stopProgress: (() => void) | undefined;
    try {
      if (taskId) {
        stopProgress = await api.onMailActionEvent((event) => {
          if (event.account !== selectedAccount || event.action !== action) return;
          onUpdateTask?.(taskId, {
            detail: event.message,
            progress: { current: event.current, total: event.total, label: "串行执行" },
            log: { level: "info", message: event.message },
          });
        }).catch(() => undefined);
      }
      const result = await api.mailAction(selectedAccount, action, uids, { destination: options.destination });
      if (taskId) onUpdateTask?.(taskId, {
        status: "success",
        detail: `已完成 ${result.processed} 封邮件的远端操作`,
        progress: { current: result.processed, total: result.processed, label: "完成" },
        finishedAt: Date.now(),
        log: { level: "success", message: `远端操作完成：${result.processed} 封` },
      });
      return result;
    } catch (error) {
      if (taskId) onUpdateTask?.(taskId, { status: "error", detail: "远端邮件操作失败", message: String(error), finishedAt: Date.now(), log: { level: "error", message: String(error) } });
      if (!options.silent) setNotice(`远端操作失败：${String(error)}`);
      throw error;
    } finally {
      stopProgress?.();
    }
  }, [browserPreview, onStartTask, onUpdateTask, selectedAccount]);

  const persistMessageStates = useCallback(async (ids: Iterable<string>, patch: MailMessageState) => {
    const targetIds = [...ids];
    if (!targetIds.length) return;
    const next = { ...messageStates };
    for (const id of targetIds) next[id] = { ...messageStates[id], ...patch };
    setMessageStates(next);
    if (patch.read !== undefined) {
      setReadIds((current) => {
        const updated = new Set(current);
        for (const id of targetIds) {
          if (patch.read) updated.add(id); else updated.delete(id);
        }
        return updated;
      });
    }
    if (patch.archived !== undefined) {
      setArchivedIds((current) => {
        const updated = new Set(current);
        for (const id of targetIds) {
          if (patch.archived) updated.add(id); else updated.delete(id);
        }
        return updated;
      });
    }
    if (browserPreview) {
      if (patch.read !== undefined || patch.archived !== undefined || patch.folder !== undefined) {
        const nextUnreadCount = messages.filter((message) => {
          const stateFolder = next[message.id]?.folder ?? message.folder;
          return message.unread && !next[message.id]?.read && !next[message.id]?.archived && isInboxFolder(stateFolder);
        }).length;
        onInboxCountChange?.(nextUnreadCount);
      }
      return;
    }
    try {
      const index: MailIndexFile = { version: 1, updated_at: new Date().toISOString(), messages: next };
      await api.vaultWriteFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
      if (patch.read !== undefined || patch.archived !== undefined || patch.folder !== undefined) onInboxCountChange?.();
    } catch (e) {
      setNotice(`保存邮件状态失败：${String(e)}`);
    }
  }, [browserPreview, messageStates, messages, onInboxCountChange]);

  const persistMessageState = useCallback((id: string, patch: MailMessageState) => persistMessageStates([id], patch), [persistMessageStates]);

  const markMessageRead = useCallback((message: MailMessage) => {
    void persistMessageState(message.id, { read: true });
    if (message.unread && !browserPreview) void runRemoteMailAction("mark_read", [message], { silent: true }).catch(() => undefined);
  }, [browserPreview, persistMessageState, runRemoteMailAction]);

  const openSingleMailAnalysis = useCallback((message: MailMessage) => {
    setSelectedMessageId(message.id);
    setMailContextMenu(null);
    setAiOpen(true);
    if (message.unread) markMessageRead(message);
  }, [markMessageRead]);

  const markSelectedRead = async () => {
    if (!selectedIds.size) return;
    const targets = messages.filter((message) => selectedIds.has(message.id));
    const count = targets.length;
    setBulkMenuOpen(false);
    await runRemoteMailAction("mark_read", targets);
    await persistMessageStates(selectedIds, { read: true });
    setSelectedIds(new Set());
    setNotice(`已将 ${count} 封邮件标记为已读`);
  };

  const requestDeleteMessages = (ids: Set<string>) => {
    const targets = messages.filter((message) => ids.has(message.id));
    if (!targets.length) return;
    setDeleteTargets(targets);
  };

  const confirmDeleteMessages = async (syncRemote: boolean) => {
    const targets = deleteTargets;
    if (!targets?.length) return;
    const totalSteps = targets.length * (syncRemote ? 2 : 1);
    const taskId = onStartTask?.({
      kind: "mail_delete",
      title: `删除 ${targets.length} 封邮件`,
      detail: syncRemote ? "准备同步删除远端并移入本地已删除" : "准备移入本地已删除",
      progress: { current: 0, total: totalSteps, label: syncRemote ? "准备远端删除" : "准备本地归档" },
      logs: [{ ts: Date.now(), level: "info", message: `已选择 ${targets.length} 封邮件` }],
    });
    let completedSteps = 0;
    const logTask = (detail: string, label: string, message: string, level: "info" | "success" | "warn" | "error" = "info") => {
      if (!taskId) return;
      onUpdateTask?.(taskId, { detail, progress: { current: completedSteps, total: totalSteps, label }, log: { level, message } });
    };
    const completeTaskStep = (detail: string, label: string, message: string, level: "success" | "error" = "success") => {
      completedSteps += 1;
      logTask(detail, label, message, level);
    };

    try {
      if (syncRemote) {
        const uids = targets.map((message) => message.uid).filter((uid): uid is number => uid !== undefined);
        if (uids.length !== targets.length) throw new Error("部分邮件缺少 UID，无法安全同步删除远端邮件");
        if (browserPreview) throw new Error("预览模式不会连接远端邮箱");
        for (const [index, uid] of uids.entries()) {
          logTask(`正在同步删除远端邮件（${index + 1}/${uids.length}）`, "远端删除", `发送 UID ${uid} 的远端删除指令`);
          await api.mailDelete(selectedAccount, [uid]);
          completeTaskStep(`已同步删除远端邮件（${index + 1}/${uids.length}）`, "远端删除", `UID ${uid} 删除完成`);
        }
      }

      const failed: string[] = [];
      for (const [index, message] of targets.entries()) {
          logTask(`正在移入已删除（${index + 1}/${targets.length}）`, "本地归档", `处理 ${message.subject}`);
        try {
          // Keep the local copy so the Deleted folder remains recoverable;
          // remote deletion, when confirmed above, is still permanent.
          completeTaskStep(`已移入已删除（${index + 1}/${targets.length}）`, "本地归档", `${message.subject} 处理完成`);
        } catch {
          failed.push(message.id);
          completeTaskStep(`移入已删除失败（${index + 1}/${targets.length}）`, "本地归档", `${message.subject} 处理失败`, "error");
        }
      }

      const deletedIds = new Set(targets.filter((message) => !failed.includes(message.id)).map((message) => message.id));
      setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      setSelectedMessageId((current) => current && deletedIds.has(current) ? null : current);
      const nextStates = { ...messageStates };
      for (const id of deletedIds) nextStates[id] = { ...nextStates[id], folder: "trash", archived: false };
      setMessageStates(nextStates);
      setArchivedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      if (!browserPreview && deletedIds.size > 0) {
        try {
          const index: MailIndexFile = { version: 1, updated_at: new Date().toISOString(), messages: nextStates };
          await api.vaultWriteFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
          onInboxCountChange?.();
        } catch (e) {
          if (taskId) onUpdateTask?.(taskId, { status: "error", detail: "状态索引保存失败", message: String(e), finishedAt: Date.now(), log: { level: "error", message: `状态索引保存失败：${String(e)}` } });
          setNotice(`邮件已删除，但状态索引保存失败：${String(e)}`);
          return;
        }
      }
      if (browserPreview && deletedIds.size > 0) {
        const nextUnreadCount = messages.filter((message) => !deletedIds.has(message.id) && message.unread && !nextStates[message.id]?.read && !nextStates[message.id]?.archived && nextStates[message.id]?.folder !== "trash").length;
        onInboxCountChange?.(nextUnreadCount);
      }
      const summary = failed.length
        ? `已完成删除 ${deletedIds.size} 封，${failed.length} 封删除失败`
        : syncRemote
          ? `已完成删除 ${deletedIds.size} 封邮件（本地与远端）`
          : `已将 ${deletedIds.size} 封邮件移入已删除`;
      if (taskId) onUpdateTask?.(taskId, { status: failed.length ? "error" : "success", detail: summary, message: failed.length ? `${failed.length} 封本地副本删除失败` : undefined, finishedAt: Date.now(), log: { level: failed.length ? "error" : "success", message: summary } });
      setDeleteTargets(null);
      setBulkMenuOpen(false);
      setNotice(summary);
    } catch (e) {
      const message = String(e);
      if (taskId) onUpdateTask?.(taskId, { status: "error", detail: "删除任务失败", message, finishedAt: Date.now(), log: { level: "error", message } });
      throw e;
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = visibleMessages.length > 0 && visibleMessages.every((message) => next.has(message.id));
      visibleMessages.forEach((message) => allSelected ? next.delete(message.id) : next.add(message.id));
      return next;
    });
  };

  const toggleStar = () => {
    if (!selectedMessageId) return;
    const currentStarred = Boolean(selectedMessage?.starred);
    if (!selectedMessage) return;
    void runRemoteMailAction(currentStarred ? "unstar" : "star", [selectedMessage])
      .then(() => persistMessageState(selectedMessageId, { starred: !currentStarred }))
      .catch(() => undefined);
  };

  const archiveSelected = () => {
    if (!selectedMessageId) return;
    if (!selectedMessage) return;
    void runRemoteMailAction("archive", [selectedMessage])
      .then(() => persistMessageState(selectedMessageId, { folder: "archive", archived: true }))
      .then(() => { setSelectedMessageId(null); setNotice("邮件已同步归档"); })
      .catch(() => undefined);
  };

  const moveSelectedToFolder = async (target: string) => {
    if (!selectedMessage) return;
    const messageId = selectedMessage.id;
    const customRemoteFolder = target.startsWith("remote:") ? target.slice("remote:".length) : undefined;
    const exactRemoteFolder = customRemoteFolder || remoteMailboxes.find((mailbox) => mailbox.path.toLowerCase() === target.toLowerCase())?.path;
    const action: api.MailActionName = target === "archive" ? "archive" : target === "trash" ? "trash" : target === "starred" ? "star" : "move";
    const destination = action === "move"
      ? exactRemoteFolder || (target === "inbox" ? accounts?.find((account) => account.name === selectedAccount)?.mailbox || "INBOX" : target)
      : undefined;
    await runRemoteMailAction(action, [selectedMessage], { destination });
    const localFolder: MailFolder = customRemoteFolder ? `remote:${customRemoteFolder}` : target as MailFolder;
    const patch: MailMessageState = localFolder === "archive"
      ? { folder: localFolder, archived: true }
      : { folder: localFolder, archived: false };
    await persistMessageState(messageId, patch);
    setMoveMenuOpen(false);
    setSelectedIds((current) => new Set([...current].filter((id) => id !== messageId)));
    if (target !== folder) setSelectedMessageId(null);
    setNotice(`邮件已同步移动到${MOVE_FOLDER_OPTIONS.find((option) => option.id === target)?.label ?? customRemoteFolder ?? target}`);
  };

  const saveComposedMailCopy = async (draft: ComposeDraft, targetFolder: "drafts" | "sent") => {
    const account = accounts?.find((item) => item.name === selectedAccount);
    if (!account) throw new Error("请先选择邮箱账户");
    const now = new Date();
    const prefix = targetFolder === "sent" ? "sent" : "draft";
    const id = browserPreview
      ? `preview-${prefix}-${now.getTime()}`
      : `mail/${account.name}/${prefix}-${now.getTime()}.md`;
    const subject = draft.subject || "(无主题)";
    const storedAttachments: MailAttachment[] = [];
    if (!browserPreview) {
      for (const [index, attachment] of draft.attachments.entries()) {
        const path = `mail/${account.name}/attachments/outgoing/${now.getTime()}/${safeComposeAttachmentName(attachment.name, index)}`;
        await api.vaultWriteBinary(path, attachment.content_base64);
        storedAttachments.push({ name: attachment.name, path, size: attachment.size, mime: attachment.mime });
      }
    } else {
      storedAttachments.push(...draft.attachments.map((attachment) => ({ name: attachment.name, size: attachment.size, mime: attachment.mime })));
    }
    const content = [
      `# ${subject}`,
      "",
      `- **From:** ${account.user}`,
      `- **To:** ${draft.to}`,
      `- **Date:** ${now.toISOString()}`,
      `- **Body format:** ${draft.html ? "html + plain-text" : "plain-text"}`,
      `- **Folder:** ${targetFolder}`,
      ...(storedAttachments.length ? [`- **Attachments:** ${JSON.stringify(storedAttachments)}`] : []),
      "",
      "---",
      "",
      ...(draft.html ? [MAIL_HTML_BODY_START, draft.html, MAIL_HTML_BODY_END, ""] : []),
      MAIL_TEXT_BODY_START,
      draft.body || "（草稿暂无正文）",
      MAIL_TEXT_BODY_END,
      "",
    ].join("\n");
    if (!browserPreview) await api.vaultWriteFile(id, content);
    const message: MailMessage = {
      id,
      path: browserPreview ? undefined : id,
      account: account.name,
      subject,
      sender: account.user,
      recipients: draft.to,
      date: formatMailDate(now.toISOString()),
      preview: draft.body.replace(/\s+/g, " ").slice(0, 100),
      body: draft.body || "（草稿暂无正文）",
      htmlBody: draft.html,
      attachments: storedAttachments,
      unread: false,
    };
    const nextStates = { ...messageStates, [id]: { ...messageStates[id], read: true, folder: targetFolder, archived: false } };
    setMessageStates(nextStates);
    setReadIds((current) => new Set(current).add(id));
    setArchivedIds((current) => new Set([...current].filter((item) => item !== id)));
    setMessages((current) => [...current.filter((item) => item.id !== id), message]);
    if (!browserPreview) {
      const index: MailIndexFile = { version: 1, updated_at: now.toISOString(), messages: nextStates };
      await api.vaultWriteFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
      const draftName = id.split("/").pop() ?? id;
      setMailEntries((current) => [...current.filter((entry) => entry.path !== id), { name: draftName, path: id }]);
    }
    setFolder(targetFolder);
    setSelectedMessageId(id);
    return id;
  };

  const saveNewMailDraft = async (draft: ComposeDraft) => {
    await saveComposedMailCopy(draft, "drafts");
    setComposeOpen(false);
    setNotice("新邮件已保存到草稿箱");
  };

  const sendComposedMail = async (draft: ComposeDraft) => {
    if (browserPreview) throw new Error("预览模式不会连接 SMTP 服务器");
    const account = accounts?.find((item) => item.name === selectedAccount);
    if (!account) throw new Error("请先选择邮箱账户");
    const result = await api.mailSend({ account: selectedAccount, to: draft.to, subject: draft.subject, text: draft.body, html: draft.html, attachments: draft.attachments });
    await saveComposedMailCopy(draft, "sent");
    setComposeOpen(false);
    setNotice(result.message_id ? `邮件已发送 · ${result.message_id}` : "邮件已发送");
  };

  const addSelectedToTodo = async () => {
    if (!selectedMessage) return;
    try {
      await enqueueTodo({
        title: selectedMessage.subject === "(无主题)" ? `处理来自 ${selectedMessage.sender.split("<")[0].trim()} 的邮件` : selectedMessage.subject,
        description: selectedMessage.preview,
        priority: selectedMessage.subject.includes("续费") || selectedMessage.subject.includes("截止") ? "important_urgent" : "other",
        source: { type: "mail", id: selectedMessage.id, label: selectedMessage.subject, path: selectedMessage.path, remoteId: selectedMessage.uid ? String(selectedMessage.uid) : undefined },
        dedupeKey: `mail:${selectedMessage.id}`,
      });
      setNotice("邮件已加入统一待办队列");
    } catch (error) {
      setNotice(`加入待办失败：${String(error)}`);
    }
  };

  const openNewMail = () => {
    setComposeMode("new");
    setComposeDraft({ to: "", subject: "", body: "", attachments: [] });
    setComposeOpen(true);
  };

  const replyToSelected = () => {
    if (!selectedMessage) return;
    setComposeMode("reply");
    setComposeDraft({
      to: extractEmailAddress(selectedMessage.sender),
      subject: selectedMessage.subject.startsWith("Re:") ? selectedMessage.subject : `Re: ${selectedMessage.subject}`,
      body: `\n\n—— 原邮件 ——\n${selectedMessage.body}`,
      attachments: [],
    });
    setComposeOpen(true);
  };

  const forwardSelected = () => {
    if (!selectedMessage) return;
    setComposeMode("forward");
    setComposeDraft({
      to: "",
      subject: selectedMessage.subject.startsWith("Fwd:") ? selectedMessage.subject : `Fwd: ${selectedMessage.subject}`,
      body: `\n\n—— 转发邮件 ——\n发件人：${selectedMessage.sender}\n日期：${selectedMessage.date}\n收件人：${selectedMessage.recipients}\n主题：${selectedMessage.subject}\n\n${selectedMessage.body}`,
      attachments: [],
    });
    setComposeOpen(true);
  };

  const downloadAttachment = async (attachment: MailAttachment) => {
    try {
      let blob: Blob;
      if (browserPreview) {
        blob = new Blob([`DepDek 附件下载预览：${attachment.name}\n`], { type: attachment.mime || "application/octet-stream" });
      } else {
        if (!attachment.path) {
          setNotice("这个附件来自旧版邮件记录；请点击“收取邮件”回补后再下载");
          return;
        }
        const result = await api.vaultReadBinary(attachment.path);
        const decoded = window.atob(result.data_base64);
        const bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
        blob = new Blob([bytes], { type: attachment.mime || result.mime || "application/octet-stream" });
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice(`已开始下载附件：${attachment.name}`);
    } catch (error) {
      setNotice(`附件下载失败：${String(error)}`);
    }
  };

  const fetchMail = async () => {
    if (!selectedAccount) return;
    const taskId = onStartTask?.({
      kind: "mail_fetch",
      title: "收取邮件",
      detail: `正在检查「${selectedAccount}」的新邮件`,
      progress: { current: 0, label: "准备收取" },
      logs: [{ ts: Date.now(), level: "info", message: `开始检查「${selectedAccount}」` }],
    });
    setSyncing(true);
    setNotice(null);
    let stopProgress: (() => void) | undefined;
    try {
      if (!browserPreview && taskId) {
        stopProgress = await api.onMailEvent((event) => {
          if (event.account !== selectedAccount) return;
          const level = event.phase === "error" ? "error" : event.phase === "completed" ? "success" : "info";
          onUpdateTask?.(taskId, {
            detail: event.message,
            progress: { current: event.current ?? 0, total: event.total, label: event.phase === "connecting" ? "连接邮箱" : event.phase === "reading" ? "读取新邮件" : event.phase === "saving" ? "保存本地副本" : event.phase === "completed" ? "完成" : "处理邮件" },
            log: { level, message: event.message },
          });
        }).catch(() => undefined);
      }
      if (browserPreview) {
        // Preview the same stages as the real sidecar without any network call.
        onUpdateTask?.(taskId ?? "", { detail: `正在连接「${selectedAccount}」`, progress: { current: 0, label: "连接邮箱" }, log: { level: "info", message: "连接 IMAP（预览模式不访问外部服务）" } });
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        onUpdateTask?.(taskId ?? "", { detail: "正在读取新邮件", progress: { current: 0, label: "读取新邮件" }, log: { level: "info", message: "读取 INBOX 新邮件" } });
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        onUpdateTask?.(taskId ?? "", { detail: "正在保存本地副本", progress: { current: 1, total: 1, label: "保存本地副本" }, log: { level: "info", message: "邮件副本写入本地 Home" } });
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        setNotice("示例邮箱已是最新 · 本地 UX 预览不会连接外部服务器");
        if (taskId) onUpdateTask?.(taskId, { status: "success", detail: "示例邮箱已是最新", progress: { current: 1, total: 1, label: "完成" }, finishedAt: Date.now(), log: { level: "success", message: "示例邮箱已是最新" } });
      } else {
        if (taskId) onUpdateTask?.(taskId, { detail: `正在连接「${selectedAccount}」`, progress: { current: 0, label: "连接邮箱" }, log: { level: "info", message: "连接 IMAP 并读取新邮件" } });
        const result = await api.mailFetch(selectedAccount, true);
        const resultAccount = result.accounts.find((account) => account.name === selectedAccount);
        const message = resultAccount?.error ?? `同步完成 · 新收到 ${resultAccount?.new_messages ?? 0} 封邮件`;
        setNotice(message);
        if (taskId) onUpdateTask?.(taskId, resultAccount?.error
          ? { status: "error", detail: "邮箱收取失败", message: resultAccount.error, finishedAt: Date.now(), log: { level: "error", message: resultAccount.error } }
          : { status: "success", detail: message, progress: { current: 1, total: 1, label: "完成" }, finishedAt: Date.now(), log: { level: "success", message } });
        await loadMessages(selectedAccount);
      }
    } catch (e) {
      const message = String(e);
      setNotice(`同步失败：${message}`);
      if (taskId) onUpdateTask?.(taskId, { status: "error", detail: "邮箱收取失败", message, finishedAt: Date.now(), log: { level: "error", message } });
    } finally {
      stopProgress?.();
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
    onInboxCountChange?.();
  };

  return (
    <div className="dd-inbox-view">
      <div className="dd-view-head dd-inbox-head"><div><div className="dd-eyebrow">INBOX / 邮件与行动</div><h1>收件箱</h1></div><span>邮件回到本地 Home · AI 只整理，不代替你发送</span></div>
      <section className="dd-inbox-toolbar">
        <div className="dd-inbox-account"><EnvelopeSimple size={17} /><select aria-label="选择邮箱账户" value={selectedAccount} onChange={(event) => setSelectedAccount(event.target.value)} disabled={!accounts?.length}>{accounts?.map((account) => <option key={account.name} value={account.name}>{account.name} · {account.user}</option>)}</select><button className="dd-inbox-account-settings" onClick={() => setAccountModal(accounts?.find((account) => account.name === selectedAccount) ?? null)} aria-label="设置邮箱账户"><GearSix size={16} /></button></div>
        <div className="dd-inbox-toolbar-actions"><button className="dd-inbox-compose-button" onClick={openNewMail} disabled={!selectedAccount}><PencilSimple size={16} />新邮件</button><button className={aiOpen ? "dd-inbox-ai-button dd-inbox-ai-button--active" : "dd-inbox-ai-button"} onClick={() => setAiOpen((current) => !current)}><Sparkle size={17} />AI 整理{unreadCount > 0 && <em>{unreadCount}</em>}</button><button onClick={fetchMail} disabled={syncing || !selectedAccount}><ArrowClockwise size={16} />{syncing ? "同步中…" : "收取邮件"}</button><button onClick={() => setAccountModal(null)}><Plus size={16} />添加账户</button></div>
      </section>
      {notice && <div className="dd-inbox-notice"><CheckCircle size={15} />{notice}</div>}
      {aiOpen && <section className="dd-inbox-ai-panel"><AIAnalysisPanel context={mailAnalysisContext} compact preferredAgentId="tanvis" />{aiItems.length > 0 && <div className="dd-inbox-ai-items">{aiItems.map((message) => <button key={message.id} onClick={() => { setSelectedMessageId(message.id); markMessageRead(message); }}><b>{message.subject}</b><span>{message.subject.includes("续费") ? "付款截止 · 建议今晚处理" : "检测到待回复或行动项"}</span></button>)}</div>}</section>}
      <section className="dd-inbox-shell">
        <aside className="dd-inbox-folders"><div className="dd-inbox-section-label">邮箱</div><button className={`dd-inbox-folder ${folder === "inbox" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("inbox")}><Tray size={17} />收件箱 <em>{inboxMessageCount}</em></button><button className={`dd-inbox-folder ${folder === "starred" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("starred")}><Star size={17} />已标记</button><button className={`dd-inbox-folder ${folder === "drafts" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("drafts")}><PencilSimple size={17} />草稿箱</button><button className={`dd-inbox-folder ${folder === "sent" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("sent")}><EnvelopeSimple size={17} />已发送</button><button className={`dd-inbox-folder ${folder === "trash" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("trash")}><Trash size={17} />已删除</button><button className={`dd-inbox-folder ${folder === "archive" ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder("archive")}><Archive size={17} />已归档</button>{junkMailbox && <button className={`dd-inbox-folder dd-inbox-folder--remote ${folder === `remote:${junkMailbox.path}` ? "dd-inbox-folder--active" : ""}`} onClick={() => setFolder(`remote:${junkMailbox.path}`)} title={junkMailbox.path}><FolderSimple size={17} />垃圾邮件 <em>{junkMailbox.unseen ?? 0}</em></button>}{customRemoteMailboxes.length > 0 && <div className="dd-inbox-section-label dd-inbox-section-label--remote">其他文件夹</div>}{customRemoteMailboxes.map((mailbox) => <button className={`dd-inbox-folder dd-inbox-folder--remote ${folder === `remote:${mailbox.path}` ? "dd-inbox-folder--active" : ""}`} key={mailbox.path} onClick={() => setFolder(`remote:${mailbox.path}`)} title={mailbox.path}><FolderSimple size={17} />{mailbox.label}<em>{mailbox.unseen ?? 0}</em></button>)}<div className="dd-inbox-section-label dd-inbox-section-label--accounts">账户</div>{accounts?.map((account) => <button className={`dd-inbox-folder dd-inbox-folder--account ${selectedAccount === account.name ? "dd-inbox-folder--selected" : ""}`} key={account.name} onClick={() => { setSelectedAccount(account.name); setFolder("inbox"); }}><UserCircle size={16} />{account.name}</button>)}{!accounts?.length && <div className="dd-inbox-no-account">还没有邮箱账户<br /><button onClick={() => setAccountModal(null)}>立即添加</button></div>}</aside>
        <div className="dd-inbox-list">
          <div className="dd-inbox-list-head">
            <input className="dd-mail-select-all" type="checkbox" aria-label="全选当前邮件" checked={visibleMessages.length > 0 && visibleMessages.every((message) => selectedIds.has(message.id))} onChange={toggleAllVisible} />
            <b>{folder.startsWith("remote:") ? remoteMailboxByPath.get(folder.slice("remote:".length))?.label ?? folder.slice("remote:".length) : folder === "inbox" ? (selectedAccount || "收件箱") : folder === "starred" ? "已标记" : folder === "drafts" ? "草稿箱" : folder === "sent" ? "已发送" : folder === "trash" ? "已删除" : folder === "archive" ? "已归档" : "垃圾邮件"}</b>
            <label className="dd-inbox-sort"><select aria-label="邮件排序" value={mailSort} onChange={(event) => setMailSort(event.target.value as MailSort)}><option value="date-desc">时间 · 最新</option><option value="date-asc">时间 · 最早</option><option value="sender-asc">发件人 · A-Z</option><option value="sender-desc">发件人 · Z-A</option></select></label>
            <div className="dd-inbox-bulk-menu">
              <button aria-label="邮件批量操作" aria-haspopup="menu" aria-expanded={bulkMenuOpen} disabled={selectedIds.size === 0} onClick={() => setBulkMenuOpen((current) => !current)} title={selectedIds.size ? `操作已选择的 ${selectedIds.size} 封邮件` : "请先选择邮件"}><FunnelSimple size={16} /></button>
              {bulkMenuOpen && <div className="dd-inbox-bulk-popover" role="menu"><span>已选择 {selectedIds.size} 封</span><button role="menuitem" onClick={() => void markSelectedRead()}><EnvelopeSimple size={15} />标记已读</button><button role="menuitem" className="dd-inbox-bulk-delete" onClick={() => { setBulkMenuOpen(false); requestDeleteMessages(selectedIds); }}><Trash size={15} />删除</button></div>}
            </div>
          </div>
          <div className="dd-inbox-message-scroll" onScroll={handleMailListScroll}>
            {loading ? <div className="dd-inbox-loading">加载本地邮件…</div> : visibleMessages.length ? visibleMessages.map((message) => <div className={`dd-mail-item ${selectedMessageId === message.id ? "dd-mail-item--active" : ""} ${message.unread ? "dd-mail-item--unread" : ""}`} key={message.id} role="button" tabIndex={0} onClick={() => { setSelectedMessageId(message.id); if (message.unread) markMessageRead(message); }} onContextMenu={(event) => { event.preventDefault(); setSelectedMessageId(message.id); setMailContextMenu({ x: event.clientX, y: event.clientY, message }); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedMessageId(message.id); if (message.unread) markMessageRead(message); } }}><input className="dd-mail-select" type="checkbox" aria-label={`选择邮件：${message.subject}`} checked={selectedIds.has(message.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelected(message.id)} /><span className="dd-mail-unread-dot" /><div className="dd-mail-item-main"><div className="dd-mail-item-meta"><b>{message.sender.split("<")[0].trim()}</b><time>{message.date}</time></div><strong>{message.attachments && message.attachments.length > 0 && <Paperclip size={13} weight="bold" aria-label="含附件" />}<span>{message.subject}</span></strong><p>{message.preview}</p></div>{message.starred && <Star className="dd-mail-star" size={15} weight="fill" />}</div>) : <div className="dd-inbox-empty"><EnvelopeSimple size={28} /><b>{folder.startsWith("remote:") ? `${remoteMailboxByPath.get(folder.slice("remote:".length))?.label ?? folder.slice("remote:".length)} 为空` : folder === "drafts" ? "还没有草稿" : folder === "sent" ? "已发送" : folder === "trash" ? "已删除为空" : folder === "archive" ? "还没有归档邮件" : folder === "starred" ? "还没有标记邮件" : "这里还没有邮件"}</b><span>{folder === "inbox" ? "收取邮件或添加一个邮箱账户开始。" : "邮件会在本地 Home 中保持可回溯。"}</span></div>}
          </div>
        </div>
        <article className="dd-inbox-reader">
          {selectedMessage ? <>
            <header className="dd-inbox-reader-head">
              <div><h2>{selectedMessage.subject}</h2><div className="dd-inbox-reader-meta"><UserCircle size={17} /><b>{selectedMessage.sender}</b><span>发给 {selectedMessage.recipients || "我"}</span><time title={selectedMessage.date}>{selectedMessage.date}</time></div></div>
              <div className="dd-inbox-reader-actions">
                <button className="dd-reader-action dd-reader-action--ai" onClick={() => openSingleMailAnalysis(selectedMessage)}><Sparkle size={14} />AI 分析</button>
                <button className="dd-reader-action" onClick={replyToSelected}><PencilSimple size={14} />回复</button>
                <button className="dd-reader-action" onClick={forwardSelected}><ArrowBendUpRight size={14} />转发</button>
                <button className="dd-reader-action dd-reader-action--todo" onClick={() => void addSelectedToTodo()}><CheckSquare size={14} />加入待办</button>
                <div className="dd-reader-move-menu"><button className="dd-reader-action" onClick={() => setMoveMenuOpen((current) => !current)} aria-haspopup="menu" aria-expanded={moveMenuOpen}><FolderSimple size={14} />移动到</button>{moveMenuOpen && <div className="dd-reader-move-popover" role="menu"><span>选择目标文件夹</span>{MOVE_FOLDER_OPTIONS.map((option) => <button key={option.id} role="menuitem" onClick={() => void moveSelectedToFolder(option.id)}>{option.label}</button>)}{moveRemoteMailboxes.map((mailbox) => <button key={mailbox.path} role="menuitem" onClick={() => void moveSelectedToFolder(`remote:${mailbox.path}`)}>{mailbox.label}</button>)}</div>}</div>
                <span className="dd-reader-action-divider" /><button className="dd-reader-utility" onClick={toggleStar} aria-label="标记星标"><Star size={16} weight={selectedMessage.starred ? "fill" : "regular"} /></button><button className="dd-reader-utility" onClick={archiveSelected} aria-label="归档邮件"><Archive size={16} /></button><button className="dd-reader-utility dd-reader-utility--danger" onClick={() => requestDeleteMessages(new Set([selectedMessage.id]))} aria-label="删除邮件"><Trash size={16} /></button>
              </div>
            </header>
            <div className="dd-inbox-reader-source"><span>来源：{selectedMessage.account} · 本地副本</span>{selectedMessage.unread && <em>AI 待整理</em>}</div>
            <div className="dd-inbox-reader-body">
              {selectedMessage.htmlBody && selectedMessage.body && <div className="dd-inbox-reader-format-bar" role="tablist" aria-label="邮件正文格式"><span>正文</span><div><button className={readerMode === "rich" ? "dd-reader-format--active" : ""} onClick={() => setReaderMode("rich")} role="tab" aria-selected={readerMode === "rich"}>富文本</button><button className={readerMode === "plain" ? "dd-reader-format--active" : ""} onClick={() => setReaderMode("plain")} role="tab" aria-selected={readerMode === "plain"}>纯文本</button></div></div>}
              {readerMode === "rich" && safeSelectedHtml ? <iframe className="dd-mail-html-frame" title={`邮件正文：${selectedMessage.subject}`} sandbox="" referrerPolicy="no-referrer" srcDoc={safeSelectedHtml} /> : selectedMessage.body.split(/\n+/).map((paragraph, index) => <p key={`${index}-${paragraph}`}>{paragraph || "\u00a0"}</p>)}
              {selectedMessage.attachments && selectedMessage.attachments.length > 0 && <div className="dd-mail-attachments"><b><Paperclip size={14} />附件</b><div>{selectedMessage.attachments.map((attachment) => <button key={`${attachment.path ?? "legacy"}-${attachment.name}`} onClick={() => void downloadAttachment(attachment)} title={attachment.path ? `下载 ${attachment.name}` : "旧版附件记录，需要重新收取邮件后下载"}><span><strong>{attachment.name}</strong>{formatAttachmentSize(attachment.size) && <small>{formatAttachmentSize(attachment.size)}</small>}</span><DownloadSimple size={16} /></button>)}</div></div>}
            </div>
          </> : <div className="dd-inbox-reader-empty"><EnvelopeSimple size={34} /><b>选择一封邮件</b><span>邮件内容会保留在本地 Home，并可回溯来源。</span></div>}
        </article>
      </section>
      {mailContextMenu && <div className="dd-mail-context-menu" style={{ left: `${Math.min(mailContextMenu.x, window.innerWidth - 188)}px`, top: `${Math.min(mailContextMenu.y, window.innerHeight - 72)}px` }} role="menu" onClick={(event) => event.stopPropagation()}><button role="menuitem" onClick={() => openSingleMailAnalysis(mailContextMenu.message)}><Sparkle size={15} />AI 分析这封邮件</button><span>仅读取当前邮件并返回建议</span></div>}
      {accountModal !== undefined && <AccountModal initial={accountModal} onClose={() => setAccountModal(undefined)} onSave={saveAccount} />}
      {composeOpen && <ComposeMailModal account={accounts?.find((account) => account.name === selectedAccount) ?? null} initial={composeDraft} mode={composeMode} onClose={() => setComposeOpen(false)} onSave={saveNewMailDraft} onSend={sendComposedMail} />}
      {deleteTargets && <DeleteMailModal count={deleteTargets.length} canDeleteRemote={!browserPreview && deleteTargets.every((message) => message.uid !== undefined)} onClose={() => setDeleteTargets(null)} onConfirm={confirmDeleteMessages} />}
    </div>
  );
}
