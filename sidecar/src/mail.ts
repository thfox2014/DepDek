/**
 * IMAP mail fetching (contract section 2.5).
 *
 * The sidecar never touches the filesystem: account config is read from and
 * messages are written to the user's data folder exclusively through vault/*
 * RPC, with session_id "mail" for audit attribution. Only network access is
 * to the configured IMAP servers.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { RpcError } from "./rpc.js";
import type { VaultClient } from "./tools.js";

export const ERR_PATH_NOT_FOUND = -32002;

/** Audit attribution for all vault operations performed by mail fetching. */
const SESSION_ID = "mail";
const CONFIG_PATH = "mail/accounts.json";

export interface MailAccount {
  name: string;
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  password: string;
  mailbox?: string;
  last_uid?: number;
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
}

export interface MailAccountsFile {
  accounts: MailAccount[];
}

export interface MailFetchAccountResult {
  name: string;
  new_messages: number;
  error?: string;
}

export interface MailFetchResult {
  fetched: number;
  accounts: MailFetchAccountResult[];
}

export interface MailDeleteResult {
  account: string;
  deleted: number;
}

export interface MailSendInput {
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text: string;
  /** Optional rich HTML body. Plain text remains the required fallback. */
  html?: string;
  attachments?: MailSendAttachment[];
}

export interface MailSendAttachment {
  name: string;
  content_base64: string;
  mime?: string;
  size?: number;
}

export interface MailSendResult {
  account: string;
  message_id: string;
}

export interface MailboxInfo {
  path: string;
  special_use?: string;
  subscribed?: boolean;
  messages?: number;
  unseen?: number;
}

export type MailActionName =
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "move"
  | "archive"
  | "trash";

export interface MailActionInput {
  account: string;
  action: MailActionName;
  uids: number[];
  destination?: string;
  /** Source mailbox; defaults to the account's configured mailbox. */
  mailbox?: string;
}

export interface MailActionResult {
  account: string;
  action: MailActionName;
  processed: number;
  destination?: string;
}

export interface MailActionProgressEvent {
  account: string;
  action: MailActionName;
  uid: number;
  current: number;
  total: number;
  message: string;
}

export interface SmtpTransportLike {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>;
  close?: () => void;
}

export type SmtpFactory = (account: MailAccount) => SmtpTransportLike;

const MAX_OUTBOUND_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_OUTBOUND_ATTACHMENTS = 20;

function defaultSmtpFactory(account: MailAccount): SmtpTransportLike {
  const port = account.smtp_port ?? 465;
  const secure = account.smtp_secure ?? port === 465;
  const host = account.smtp_host ?? account.host.replace(/^imap\./i, "smtp.");
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: account.user, pass: account.password },
  });
}

function safeOutboundAttachmentName(name: string, index: number): string {
  const leaf = name.split(/[\\/]/).at(-1)?.trim() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f:]/g, "_").slice(0, 160);
  return cleaned || `attachment-${index + 1}`;
}

function decodeOutboundAttachments(input: MailSendAttachment[] | undefined): Array<{ filename: string; content: Buffer; contentType: string }> {
  if (!input?.length) return [];
  if (input.length > MAX_OUTBOUND_ATTACHMENTS) throw new Error(`附件数量不能超过 ${MAX_OUTBOUND_ATTACHMENTS} 个`);
  let total = 0;
  return input.map((attachment, index) => {
    if (!attachment.content_base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content_base64) || attachment.content_base64.length % 4 !== 0) {
      throw new Error(`附件 ${index + 1} 的内容不是有效的 base64`);
    }
    const content = Buffer.from(attachment.content_base64, "base64");
    total += content.length;
    if (total > MAX_OUTBOUND_ATTACHMENT_BYTES) throw new Error("附件总大小不能超过 64 MiB");
    return {
      filename: safeOutboundAttachmentName(attachment.name, index),
      content,
      contentType: attachment.mime?.trim() || "application/octet-stream",
    };
  });
}

export interface StoredMailAttachment {
  name: string;
  path: string;
  size: number;
  mime: string;
}

export interface StoredMailMetadata {
  uid: number;
  path: string;
  subject: string;
  read?: boolean;
  date?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string[];
  thread_key: string;
}

export type MailProgressPhase = "connecting" | "connected" | "reading" | "saving" | "completed" | "error";

export interface MailProgressEvent {
  account: string;
  phase: MailProgressPhase;
  message: string;
  current?: number;
  total?: number;
}

export type MailProgressReporter = (event: MailProgressEvent) => void;

/** Structural subset of ImapFlow so tests can inject a fake. */
export interface ImapClientLike {
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  fetch(
    range: string | number[],
    query: unknown,
    options: unknown,
  ): AsyncIterable<{ uid: number; source?: Buffer; flags?: Set<string> | string[] }>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<boolean>;
  list?(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<Array<{
    path: string;
    specialUse?: string;
    subscribed?: boolean;
    status?: { messages?: number; unseen?: number };
  }>>;
  messageFlagsAdd?(range: number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>;
  messageFlagsRemove?(range: number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>;
  messageMove?(range: number[], destination: string, options?: { uid?: boolean }): Promise<unknown | false>;
  capabilities?: Map<string, boolean | number>;
  logout(): Promise<void>;
}

export type ImapFactory = (account: MailAccount) => ImapClientLike;

const defaultFactory: ImapFactory = (account) =>
  new ImapFlow({
    host: account.host,
    port: account.port ?? 993,
    secure: account.secure ?? true,
    auth: { user: account.user, pass: account.password },
    logger: false,
  }) as unknown as ImapClientLike;

const IMAP_CONNECT_TIMEOUT_MS = 30_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function addresses(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((v) => addresses(v)).filter(Boolean).join(", ");
  }
  return String((value as { text?: string }).text ?? value);
}

export const MAIL_HTML_BODY_START = "<!-- depdek:mail-html:start -->";
export const MAIL_HTML_BODY_END = "<!-- depdek:mail-html:end -->";
export const MAIL_TEXT_BODY_START = "<!-- depdek:mail-text:start -->";
export const MAIL_TEXT_BODY_END = "<!-- depdek:mail-text:end -->";

function fallbackTextFromHtml(html: string): string {
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

/** Render a parsed message as the markdown file stored in the vault. */
export function renderMessageMarkdown(parsed: {
  subject?: string;
  from?: unknown;
  to?: unknown;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string[] | string;
  read?: boolean;
  text?: string;
  html?: string | false;
  attachments?: { filename?: string }[];
}, uid?: number, storedAttachments: StoredMailAttachment[] = [], folder?: string): string {
  const subject = parsed.subject ?? "(no subject)";
  const html = typeof parsed.html === "string" ? parsed.html.trim() : "";
  const text = parsed.text?.trim() || (html ? fallbackTextFromHtml(html) : "");
  const lines = [
    `# ${subject}`,
    "",
    `- **From:** ${addresses(parsed.from)}`,
    `- **To:** ${addresses(parsed.to)}`,
    `- **Date:** ${parsed.date ? parsed.date.toISOString() : ""}`,
    ...(parsed.messageId ? [`- **Message-ID:** ${parsed.messageId}`] : []),
    ...(parsed.inReplyTo ? [`- **In-Reply-To:** ${parsed.inReplyTo}`] : []),
    ...(parsed.references ? [`- **References:** ${Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references}`] : []),
    ...(parsed.read !== undefined ? [`- **Read:** ${parsed.read ? "true" : "false"}`] : []),
    `- **Body format:** ${html ? (text ? "html + plain-text" : "html") : text ? "plain-text" : "empty"}`,
  ];
  if (uid !== undefined) lines.push(`- **UID:** ${uid}`);
  if (folder?.trim()) lines.push(`- **Folder:** ${folder.replace(/[\r\n]/g, " ").trim()}`);
  if (storedAttachments.length > 0) {
    lines.push(`- **Attachments:** ${JSON.stringify(storedAttachments)}`);
  }
  lines.push("", "---");
  if (html) lines.push("", MAIL_HTML_BODY_START, html, MAIL_HTML_BODY_END);
  if (text) lines.push("", MAIL_TEXT_BODY_START, text, MAIL_TEXT_BODY_END);
  if (!html && !text) lines.push("", "(no body)");
  return lines.join("\n");
}

function localFolderForMailbox(mailbox: string | undefined): string {
  const value = mailbox?.trim() || "INBOX";
  return value.toLocaleLowerCase() === "inbox" ? "inbox" : `remote:${value}`;
}

function safeAttachmentFilename(filename: string | undefined, index: number): string {
  const leaf = (filename ?? "").split(/[\\/]/).at(-1)?.trim() ?? "";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f:]/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 160);
  return `${String(index + 1).padStart(2, "0")}-${cleaned || `attachment-${index + 1}`}`;
}

function metadataThreadKey(parsed: { messageId?: string; inReplyTo?: string; references?: string[] | string; subject?: string }): string {
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  return references[0] || parsed.inReplyTo || parsed.messageId || (parsed.subject ?? "(no subject)").replace(/^(re|fw|fwd):\s*/i, "").trim().toLocaleLowerCase();
}

async function readMailMetadata(vault: VaultClient, accountName: string): Promise<StoredMailMetadata[]> {
  try {
    const result = await vault.request<{ content: string }>("vault/read_file", {
      session_id: SESSION_ID,
      path: `mail/${accountName}/index.json`,
    });
    const parsed = JSON.parse(result.content) as { version?: number; messages?: StoredMailMetadata[] };
    return Array.isArray(parsed.messages) ? parsed.messages.filter((item) => Number.isSafeInteger(item.uid) && typeof item.path === "string") : [];
  } catch (err) {
    if (err instanceof RpcError && err.code === ERR_PATH_NOT_FOUND) return [];
    throw err;
  }
}

async function saveAttachments(
  vault: VaultClient,
  accountName: string,
  uid: number,
  attachments: { filename?: string; content: Buffer; contentType?: string; size?: number }[],
): Promise<StoredMailAttachment[]> {
  const saved: StoredMailAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const name = attachment.filename?.trim() || `attachment-${index + 1}`;
    const path = `mail/${accountName}/attachments/${uid}/${safeAttachmentFilename(name, index)}`;
    const content = Buffer.from(attachment.content);
    await vault.request("vault/write_binary", {
      session_id: SESSION_ID,
      path,
      data_base64: content.toString("base64"),
    });
    saved.push({
      name,
      path,
      size: attachment.size ?? content.length,
      mime: attachment.contentType || "application/octet-stream",
    });
  }
  return saved;
}

async function readAccounts(vault: VaultClient): Promise<MailAccountsFile> {
  let result: { content: string };
  try {
    result = await vault.request<{ content: string }>("vault/read_file", {
      session_id: SESSION_ID,
      path: CONFIG_PATH,
    });
  } catch (err) {
    if (err instanceof RpcError && err.code === ERR_PATH_NOT_FOUND) {
      throw new RpcError(
        ERR_PATH_NOT_FOUND,
        "no mail accounts configured: ask an agent to write mail/accounts.json first",
      );
    }
    throw err;
  }
  const config = JSON.parse(result.content) as MailAccountsFile;
  if (!Array.isArray(config.accounts)) {
    throw new RpcError(ERR_PATH_NOT_FOUND, `${CONFIG_PATH} has no "accounts" array`);
  }
  return config;
}

async function fetchAccount(
  vault: VaultClient,
  account: MailAccount,
  factory: ImapFactory,
  refreshBody: boolean,
  report: MailProgressReporter,
): Promise<number> {
  if (!account.name || account.name.includes("/") || account.name.includes("..")) {
    throw new Error(`invalid account name for a vault directory: ${JSON.stringify(account.name)}`);
  }
  const client = factory(account);
  report({ account: account.name, phase: "connecting", message: `正在连接 ${account.host}:${account.port ?? 993}` });
  await withTimeout(client.connect(), IMAP_CONNECT_TIMEOUT_MS, `连接 IMAP 超时（${IMAP_CONNECT_TIMEOUT_MS / 1000} 秒）`);
  report({ account: account.name, phase: "connected", message: "IMAP 连接成功，准备读取新邮件" });
  let count = 0;
  try {
    report({ account: account.name, phase: "reading", message: `正在读取文件夹 ${account.mailbox ?? "INBOX"}` });
    const lock = await withTimeout(client.getMailboxLock(account.mailbox ?? "INBOX"), IMAP_CONNECT_TIMEOUT_MS, `打开邮箱文件夹超时（${IMAP_CONNECT_TIMEOUT_MS / 1000} 秒）`);
    try {
      const lastUid = account.last_uid ?? 0;
      const refreshPaths = refreshBody ? await findRefreshPaths(vault, account.name) : new Map<number, string>();
      const metadataByUid = new Map((await readMailMetadata(vault, account.name)).map((item) => [item.uid, item]));
      // UID range "N:*" may still return the last message when N exceeds all
      // assigned UIDs (RFC 3501), so filter client-side as well.
      const range = `${lastUid + 1}:*`;
      const saveMessage = async (message: { uid: number; source?: Buffer; flags?: Set<string> | string[] }, path?: string, isNew = true) => {
        if (!message.source) return;
        const parsed = await simpleParser(message.source);
        const storedAttachments = await saveAttachments(vault, account.name, message.uid, parsed.attachments);
        const storedPath = path ?? `mail/${account.name}/${Date.now()}-${message.uid}.md`;
        const flags = message.flags instanceof Set ? message.flags : new Set(message.flags ?? []);
        const hasReadFlag = message.flags !== undefined ? flags.has("\\Seen") : undefined;
        await vault.request("vault/write_file", {
          session_id: SESSION_ID,
          path: storedPath,
          content: renderMessageMarkdown({ ...parsed, ...(hasReadFlag !== undefined ? { read: hasReadFlag } : {}) }, message.uid, storedAttachments, localFolderForMailbox(account.mailbox)),
        });
        const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        metadataByUid.set(message.uid, {
          uid: message.uid,
          path: storedPath,
          subject: parsed.subject ?? "(no subject)",
          ...(hasReadFlag !== undefined ? { read: hasReadFlag } : {}),
          ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
          ...(parsed.messageId ? { message_id: parsed.messageId } : {}),
          ...(parsed.inReplyTo ? { in_reply_to: parsed.inReplyTo } : {}),
          ...(references.length ? { references } : {}),
          thread_key: metadataThreadKey(parsed),
        });
        if (isNew) {
          account.last_uid = Math.max(account.last_uid ?? lastUid, message.uid);
          count++;
        }
      };

      for await (const message of client.fetch(range, { source: true, uid: true }, { uid: true })) {
        if (message.uid <= lastUid || !message.source) continue;
        report({ account: account.name, phase: "saving", message: `正在保存 UID ${message.uid} 的邮件副本`, current: count + 1 });
        await saveMessage(message);
      }

      // Re-fetch only legacy messages that need body or attachment backfill,
      // keeping the normal incremental path inexpensive.
      for (const [uid, path] of refreshPaths) {
        for await (const message of client.fetch([uid], { source: true, uid: true }, { uid: true })) {
          if (message.uid !== uid || !message.source) continue;
          report({ account: account.name, phase: "saving", message: `正在修复 UID ${uid} 的邮件正文`, current: count + 1 });
          await saveMessage(message, path, false);
          break;
        }
      }
      await vault.request("vault/write_file", {
        session_id: SESSION_ID,
        path: `mail/${account.name}/index.json`,
        content: JSON.stringify({ version: 1, updated_at: new Date().toISOString(), messages: [...metadataByUid.values()].sort((a, b) => a.uid - b.uid) }, null, 2) + "\n",
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  report({ account: account.name, phase: "completed", message: count ? `已保存 ${count} 封新邮件` : "没有新邮件，收件箱已是最新" , current: count });
  return count;
}

async function findRefreshPaths(vault: VaultClient, accountName: string): Promise<Map<number, string>> {
  let result: { entries: { name: string; kind: string }[] };
  try {
    result = await vault.request<{ entries: { name: string; kind: string }[] }>("vault/list_dir", {
      session_id: SESSION_ID,
      path: `mail/${accountName}`,
    });
  } catch (err) {
    if (err instanceof RpcError && err.code === ERR_PATH_NOT_FOUND) return new Map();
    throw err;
  }

  const legacy = new Map<number, string>();
  for (const entry of result.entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
    const match = entry.name.match(/-(\d+)\.md$/);
    const uid = match ? Number.parseInt(match[1]!, 10) : NaN;
    if (!Number.isSafeInteger(uid) || uid <= 0) continue;
    const path = `mail/${accountName}/${entry.name}`;
    const file = await vault.request<{ content: string }>("vault/read_file", {
      session_id: SESSION_ID,
      path,
    });
    if (file.content.includes("(no plain-text body)") || file.content.includes("**Attachments (not saved):**")) {
      legacy.set(uid, path);
    }
  }
  return legacy;
}

/**
 * Fetch new mail for one or all configured accounts (contract section 2.5).
 * A failing account is reported in its result entry without aborting the rest.
 */
export async function fetchMail(
  vault: VaultClient,
  opts: { account?: string; refresh_body?: boolean } = {},
  factory: ImapFactory = defaultFactory,
  report: MailProgressReporter = () => {},
): Promise<MailFetchResult> {
  const config = await readAccounts(vault);
  const targets = opts.account
    ? config.accounts.filter((a) => a.name === opts.account)
    : config.accounts;
  if (targets.length === 0) {
    throw new RpcError(
      ERR_PATH_NOT_FOUND,
      `unknown mail account: ${opts.account ?? "(none configured)"}`,
    );
  }

  const results: MailFetchAccountResult[] = [];
  let fetched = 0;
  for (const account of targets) {
    try {
      const n = await fetchAccount(vault, account, factory, opts.refresh_body === true, report);
      results.push({ name: account.name, new_messages: n });
      fetched += n;
    } catch (err) {
      report({ account: account.name, phase: "error", message: err instanceof Error ? err.message : String(err) });
      results.push({
        name: account.name,
        new_messages: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Persist updated last_uid values even when some accounts failed.
  await vault.request("vault/write_file", {
    session_id: SESSION_ID,
    path: CONFIG_PATH,
    content: JSON.stringify(config, null, 2) + "\n",
  });

  return { fetched, accounts: results };
}

/** Permanently delete selected messages from a remote IMAP mailbox by UID. */
export async function deleteMail(
  vault: VaultClient,
  opts: { account: string; uids: number[] },
  factory: ImapFactory = defaultFactory,
): Promise<MailDeleteResult> {
  const config = await readAccounts(vault);
  const account = config.accounts.find((item) => item.name === opts.account);
  if (!account) {
    throw new RpcError(ERR_PATH_NOT_FOUND, `unknown mail account: ${opts.account}`);
  }

  const uids = [...new Set(opts.uids)].filter((uid) => Number.isSafeInteger(uid) && uid > 0);
  if (uids.length === 0) return { account: account.name, deleted: 0 };

  const client = factory(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(account.mailbox ?? "INBOX");
    try {
      // Without UIDPLUS ImapFlow must issue a plain EXPUNGE, which could also
      // permanently remove messages another client had already marked deleted.
      if (!client.capabilities?.has("UIDPLUS")) {
        throw new Error("远端邮箱不支持 UIDPLUS，已阻止批量删除以避免误删其他邮件");
      }
      // Send one UID per command. This keeps a batch observable and makes a
      // failure boundary explicit instead of asking the IMAP server to
      // process an opaque multi-message mutation in one request.
      for (const uid of uids) {
        const deleted = await client.messageDelete([uid], { uid: true });
        if (!deleted) throw new Error(`远端邮箱未确认 UID ${uid} 的删除操作`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return { account: account.name, deleted: uids.length };
}

/** List remote folders without touching the vault beyond the account config. */
export async function listMailboxes(
  vault: VaultClient,
  opts: { account: string },
  factory: ImapFactory = defaultFactory,
): Promise<{ account: string; mailboxes: MailboxInfo[] }> {
  const config = await readAccounts(vault);
  const account = config.accounts.find((item) => item.name === opts.account);
  if (!account) throw new RpcError(ERR_PATH_NOT_FOUND, `unknown mail account: ${opts.account}`);
  const client = factory(account);
  await withTimeout(client.connect(), IMAP_CONNECT_TIMEOUT_MS, `连接 IMAP 超时（${IMAP_CONNECT_TIMEOUT_MS / 1000} 秒）`);
  try {
    if (!client.list) throw new Error("当前 IMAP 客户端不支持列出邮箱文件夹");
    const entries = await client.list({ statusQuery: { messages: true, unseen: true } });
    return {
      account: account.name,
      mailboxes: entries
        .filter((entry) => Boolean(entry.path))
        .map((entry) => ({
          path: entry.path,
          ...(entry.specialUse ? { special_use: entry.specialUse } : {}),
          ...(entry.subscribed !== undefined ? { subscribed: entry.subscribed } : {}),
          ...(entry.status?.messages !== undefined ? { messages: entry.status.messages } : {}),
          ...(entry.status?.unseen !== undefined ? { unseen: entry.status.unseen } : {}),
        })),
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

function specialUseDestination(mailboxes: MailboxInfo[], specialUse: string, fallback: string): string {
  return mailboxes.find((mailbox) => mailbox.special_use?.toLowerCase() === specialUse.toLowerCase())?.path
    ?? mailboxes.find((mailbox) => mailbox.path.toLowerCase() === fallback.toLowerCase())?.path
    ?? fallback;
}

/**
 * Apply remote mailbox actions one UID at a time. A single action request is
 * intentionally serial so the task center can show a reliable failure
 * boundary and the provider never receives an opaque multi-message mutation.
 */
export async function applyMailAction(
  vault: VaultClient,
  input: MailActionInput,
  factory: ImapFactory = defaultFactory,
  report: (event: MailActionProgressEvent) => void = () => {},
): Promise<MailActionResult> {
  const config = await readAccounts(vault);
  const account = config.accounts.find((item) => item.name === input.account);
  if (!account) throw new RpcError(ERR_PATH_NOT_FOUND, `unknown mail account: ${input.account}`);
  const uids = [...new Set(input.uids)].filter((uid) => Number.isSafeInteger(uid) && uid > 0);
  if (!uids.length) return { account: account.name, action: input.action, processed: 0 };

  const client = factory(account);
  await withTimeout(client.connect(), IMAP_CONNECT_TIMEOUT_MS, `连接 IMAP 超时（${IMAP_CONNECT_TIMEOUT_MS / 1000} 秒）`);
  let destination = input.destination;
  try {
    const sourceMailbox = input.mailbox?.trim() || account.mailbox || "INBOX";
    let listed: MailboxInfo[] = [];
    if (["move", "archive", "trash"].includes(input.action)) {
      if (!client.messageMove) throw new Error("当前 IMAP 客户端不支持移动邮件");
      if (!destination && input.action === "archive") {
        if (!client.list) throw new Error("无法发现远端归档文件夹，请手工指定目标文件夹");
        listed = (await client.list()).map((entry) => ({ path: entry.path, special_use: entry.specialUse }));
        destination = specialUseDestination(listed, "\\Archive", "Archive");
      }
      if (!destination && input.action === "trash") {
        if (!client.list) throw new Error("无法发现远端垃圾箱文件夹，请手工指定目标文件夹");
        listed = listed.length ? listed : (await client.list()).map((entry) => ({ path: entry.path, special_use: entry.specialUse }));
        destination = specialUseDestination(listed, "\\Trash", "Trash");
      }
      if (!destination?.trim()) throw new Error("移动邮件缺少目标文件夹");
      destination = destination.trim();
    }

    const lock = await withTimeout(client.getMailboxLock(sourceMailbox), IMAP_CONNECT_TIMEOUT_MS, `打开邮箱文件夹超时（${IMAP_CONNECT_TIMEOUT_MS / 1000} 秒）`);
    try {
      for (const [index, uid] of uids.entries()) {
        const current = index + 1;
        report({ account: account.name, action: input.action, uid, current, total: uids.length, message: `正在处理 UID ${uid}（${current}/${uids.length}）` });
        let ok: boolean | unknown = true;
        if (input.action === "mark_read") {
          if (!client.messageFlagsAdd) throw new Error("当前 IMAP 客户端不支持标记已读");
          ok = await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
        } else if (input.action === "mark_unread") {
          if (!client.messageFlagsRemove) throw new Error("当前 IMAP 客户端不支持标记未读");
          ok = await client.messageFlagsRemove([uid], ["\\Seen"], { uid: true });
        } else if (input.action === "star") {
          if (!client.messageFlagsAdd) throw new Error("当前 IMAP 客户端不支持星标");
          ok = await client.messageFlagsAdd([uid], ["\\Flagged"], { uid: true });
        } else if (input.action === "unstar") {
          if (!client.messageFlagsRemove) throw new Error("当前 IMAP 客户端不支持取消星标");
          ok = await client.messageFlagsRemove([uid], ["\\Flagged"], { uid: true });
        } else {
          ok = await client.messageMove!([uid], destination!, { uid: true });
        }
        if (ok === false) throw new Error(`远端未确认 UID ${uid} 的操作`);
        report({ account: account.name, action: input.action, uid, current, total: uids.length, message: `UID ${uid} 处理完成` });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { account: account.name, action: input.action, processed: uids.length, ...(destination ? { destination } : {}) };
}

/** Send a plain-text message through the account's configured SMTP server. */
export async function sendMail(
  vault: VaultClient,
  input: MailSendInput,
  factory: SmtpFactory = defaultSmtpFactory,
): Promise<MailSendResult> {
  const config = await readAccounts(vault);
  const account = config.accounts.find((item) => item.name === input.account);
  if (!account) {
    throw new RpcError(ERR_PATH_NOT_FOUND, `unknown mail account: ${input.account}`);
  }
  if (!input.to.trim()) throw new Error("收件人不能为空");
  const attachments = decodeOutboundAttachments(input.attachments);

  const transport = factory(account);
  try {
    const result = await transport.sendMail({
      from: account.user,
      to: input.to,
      ...(input.cc?.trim() ? { cc: input.cc } : {}),
      ...(input.bcc?.trim() ? { bcc: input.bcc } : {}),
      subject: input.subject?.trim() || "(无主题)",
      text: input.text,
      ...(input.html?.trim() ? { html: input.html } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return { account: account.name, message_id: result.messageId ?? "" };
  } finally {
    transport.close?.();
  }
}
