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

/** Structural subset of ImapFlow so tests can inject a fake. */
export interface ImapClientLike {
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  fetch(
    range: string,
    query: unknown,
    options: unknown,
  ): AsyncIterable<{ uid: number; source?: Buffer }>;
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

function addresses(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((v) => addresses(v)).filter(Boolean).join(", ");
  }
  return String((value as { text?: string }).text ?? value);
}

/** Render a parsed message as the markdown file stored in the vault. */
export function renderMessageMarkdown(parsed: {
  subject?: string;
  from?: unknown;
  to?: unknown;
  date?: Date;
  text?: string;
  attachments?: { filename?: string }[];
}): string {
  const subject = parsed.subject ?? "(no subject)";
  const attachmentNames = (parsed.attachments ?? [])
    .map((a) => a.filename)
    .filter((f): f is string => Boolean(f));
  const lines = [
    `# ${subject}`,
    "",
    `- **From:** ${addresses(parsed.from)}`,
    `- **To:** ${addresses(parsed.to)}`,
    `- **Date:** ${parsed.date ? parsed.date.toISOString() : ""}`,
  ];
  if (attachmentNames.length > 0) {
    lines.push(`- **Attachments (not saved):** ${attachmentNames.join(", ")}`);
  }
  lines.push("", "---", "", parsed.text ?? "(no plain-text body)");
  return lines.join("\n");
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
): Promise<number> {
  if (!account.name || account.name.includes("/") || account.name.includes("..")) {
    throw new Error(`invalid account name for a vault directory: ${JSON.stringify(account.name)}`);
  }
  const client = factory(account);
  await client.connect();
  let count = 0;
  try {
    const lock = await client.getMailboxLock(account.mailbox ?? "INBOX");
    try {
      const lastUid = account.last_uid ?? 0;
      // UID range "N:*" may still return the last message when N exceeds all
      // assigned UIDs (RFC 3501), so filter client-side as well.
      const range = `${lastUid + 1}:*`;
      for await (const message of client.fetch(range, { source: true, uid: true }, { uid: true })) {
        if (message.uid <= lastUid || !message.source) continue;
        const parsed = await simpleParser(message.source);
        const path = `mail/${account.name}/${Date.now()}-${message.uid}.md`;
        await vault.request("vault/write_file", {
          session_id: SESSION_ID,
          path,
          content: renderMessageMarkdown(parsed),
        });
        account.last_uid = Math.max(lastUid, message.uid);
        count++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return count;
}

/**
 * Fetch new mail for one or all configured accounts (contract section 2.5).
 * A failing account is reported in its result entry without aborting the rest.
 */
export async function fetchMail(
  vault: VaultClient,
  opts: { account?: string } = {},
  factory: ImapFactory = defaultFactory,
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
      const n = await fetchAccount(vault, account, factory);
      results.push({ name: account.name, new_messages: n });
      fetched += n;
    } catch (err) {
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
