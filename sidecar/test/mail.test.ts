import { describe, expect, it, vi } from "vitest";
import { applyMailAction, deleteMail, fetchMail, listMailboxes, renderMessageMarkdown, sendMail, type ImapFactory, type MailAccount, type SmtpFactory } from "../src/mail.js";
import { RpcError } from "../src/rpc.js";
import type { VaultClient } from "../src/tools.js";

/** In-memory vault: text and binary files over path maps. */
function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const binaryFiles = new Map<string, Buffer>();
  const vault: VaultClient = {
    request: vi.fn(async (method: string, params: any) => {
      if (method === "vault/read_file") {
        const content = files.get(params.path);
        if (content === undefined) throw new RpcError(-32002, "path not found");
        return { content, size: content.length, sha256: "x" };
      }
      if (method === "vault/write_file") {
        files.set(params.path, params.content);
        return { size: params.content.length, sha256: "x" };
      }
      if (method === "vault/write_binary") {
        const content = Buffer.from(params.data_base64, "base64");
        binaryFiles.set(params.path, content);
        return { size: content.length, sha256: "binary-x" };
      }
      if (method === "vault/list_dir") {
        const prefix = params.path === "." ? "" : `${params.path}/`;
        const entries = [...files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          .filter((name) => name && !name.includes("/"))
          .map((name) => ({ name, kind: "file", size: files.get(`${prefix}${name}`)?.length ?? 0 }));
        return { entries };
      }
      throw new Error(`unexpected method ${method}`);
    }),
  };
  return { vault, files, binaryFiles };
}

const MIME = (subject: string, body: string) =>
  `From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: ${subject}\r\n` +
  `Date: Mon, 1 Jan 2024 00:00:00 +0000\r\nContent-Type: text/plain\r\n\r\n${body}`;

const MIME_WITH_ATTACHMENT =
  `From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: has file\r\n` +
  `Date: Mon, 1 Jan 2024 00:00:00 +0000\r\nContent-Type: multipart/mixed; boundary="depdek"\r\n\r\n` +
  `--depdek\r\nContent-Type: text/plain\r\n\r\nPlease see attachment.\r\n` +
  `--depdek\r\nContent-Type: application/pdf; name="../budget.pdf"\r\n` +
  `Content-Disposition: attachment; filename="../budget.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
  `JVBERi0xLjQK\r\n--depdek--\r\n`;

/** Fake IMAP factory yielding the given messages (uid/source pairs). */
function fakeImap(
  messages: { uid: number; source: string; flags?: string[] }[],
  hooks: { failConnect?: boolean } = {},
): ImapFactory {
  return (_account: MailAccount) => ({
    capabilities: new Map([["UIDPLUS", true]]),
    connect: async () => {
      if (hooks.failConnect) throw new Error("connection refused");
    },
    getMailboxLock: async () => ({ release: () => {} }),
    fetch: async function* () {
      for (const m of messages) yield { uid: m.uid, source: Buffer.from(m.source), ...(m.flags ? { flags: m.flags } : {}) };
    },
    messageDelete: async () => true,
    logout: async () => {},
  });
}

const CONFIG = {
  accounts: [
    { name: "qq", host: "imap.qq.com", user: "a@qq.com", password: "code", last_uid: 5 },
    { name: "gmail", host: "imap.gmail.com", user: "b@gmail.com", password: "pw" },
  ],
};

describe("fetchMail", () => {
  it("reports -32002 when mail/accounts.json does not exist", async () => {
    const { vault } = fakeVault();
    const err = await fetchMail(vault).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(-32002);
    expect(err.message).toContain("no mail accounts configured");
  });

  it("fetches only messages newer than last_uid and persists state", async () => {
    const { vault, files } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const result = await fetchMail(vault, { account: "qq" }, fakeImap([
      { uid: 5, source: MIME("old", "already seen") },
      { uid: 6, source: MIME("hello", "hi there") },
      { uid: 7, source: MIME("second", "again") },
    ]));

    expect(result).toEqual({ fetched: 2, accounts: [{ name: "qq", new_messages: 2 }] });
    const written = [...files.keys()].filter((p) => p.startsWith("mail/qq/") && p.endsWith(".md"));
    expect(written).toHaveLength(2);
    expect(files.get(written[0]!)).toContain("# hello");
    expect(files.get(written[0]!)).toContain("- **Folder:** inbox");
    expect(files.get("mail/qq/index.json")).toContain("thread_key");
    // last_uid advanced to 7 and was written back
    const saved = JSON.parse(files.get("mail/accounts.json")!);
    expect(saved.accounts[0].last_uid).toBe(7);
    expect(saved.accounts[1].last_uid).toBeUndefined();
  });

  it("persists the remote Seen flag so the UI can distinguish read mail", async () => {
    const { vault, files } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    await fetchMail(vault, { account: "qq" }, fakeImap([
      { uid: 6, source: MIME("seen", "already read"), flags: ["\\Seen"] },
      { uid: 7, source: MIME("unseen", "needs attention"), flags: [] },
    ]));

    const stored = [...files.entries()].find(([path]) => path.endsWith("-6.md"))?.[1];
    const metadata = JSON.parse(files.get("mail/qq/index.json")!);
    expect(stored).toContain("- **Read:** true");
    expect(metadata.messages.find((item: { uid: number }) => item.uid === 6).read).toBe(true);
    expect(metadata.messages.find((item: { uid: number }) => item.uid === 7).read).toBe(false);
  });

  it("reports connection, read, save and completion progress", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const events: string[] = [];
    await fetchMail(vault, { account: "qq" }, fakeImap([{ uid: 6, source: MIME("hello", "hi") }]), (event) => {
      events.push(`${event.phase}:${event.message}`);
    });
    expect(events[0]).toContain("connecting:");
    expect(events.some((event) => event.startsWith("connected:"))).toBe(true);
    expect(events.some((event) => event.startsWith("reading:"))).toBe(true);
    expect(events.some((event) => event.startsWith("saving:"))).toBe(true);
    expect(events.at(-1)).toContain("completed:");
  });

  it("tags vault operations with session_id mail", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    await fetchMail(vault, { account: "qq" }, fakeImap([{ uid: 6, source: MIME("s", "b") }]));
    for (const call of (vault.request as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1].session_id).toBe("mail");
    }
  });

  it("stores attachments as binary vault files and records downloadable metadata", async () => {
    const { vault, files, binaryFiles } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    await fetchMail(vault, { account: "qq" }, fakeImap([{ uid: 6, source: MIME_WITH_ATTACHMENT }]));

    const attachmentPaths = [...binaryFiles.keys()];
    expect(attachmentPaths).toHaveLength(1);
    expect(attachmentPaths[0]).toMatch(/^mail\/qq\/attachments\/6\/01-/);
    expect(attachmentPaths[0]).not.toContain("..");
    expect(binaryFiles.get(attachmentPaths[0]!)).toEqual(Buffer.from("%PDF-1.4\n"));

    const mailPath = [...files.keys()].find((path) => path.startsWith("mail/qq/") && path.endsWith(".md"));
    const markdown = files.get(mailPath!);
    expect(markdown).toContain("**Attachments:**");
    expect(markdown).toContain(attachmentPaths[0]!);
    expect(markdown).toContain("application/pdf");
  });

  it("keeps other accounts going when one fails", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const result = await fetchMail(vault, {}, (account) =>
      account.name === "qq"
        ? fakeImap([], { failConnect: true })(account)
        : fakeImap([{ uid: 1, source: MIME("g", "body") }])(account),
    );
    expect(result.fetched).toBe(1);
    expect(result.accounts[0]).toMatchObject({ name: "qq", new_messages: 0 });
    expect(result.accounts[0]!.error).toContain("connection refused");
    expect(result.accounts[1]).toEqual({ name: "gmail", new_messages: 1 });
  });

  it("refreshes legacy placeholder files without counting them as new mail", async () => {
    const config = { accounts: [{ ...CONFIG.accounts[0], last_uid: 6 }] };
    const legacyPath = "mail/qq/1700000000000-6.md";
    const { vault, files } = fakeVault({
      "mail/accounts.json": JSON.stringify(config),
      [legacyPath]: "# old\n\n- **Date:** 2024-01-01T00:00:00.000Z\n\n---\n\n(no plain-text body)",
    });

    const htmlSource = MIME("html", "unused")
      .replace("Content-Type: text/plain", "Content-Type: text/html")
      .replace("unused", "<h1>Recovered</h1>");
    const result = await fetchMail(vault, { account: "qq", refresh_body: true }, fakeImap([
      { uid: 6, source: htmlSource },
    ]));

    expect(result).toEqual({ fetched: 0, accounts: [{ name: "qq", new_messages: 0 }] });
    expect(files.get(legacyPath)).toContain("depdek:mail-text:start");
  });

  it("rejects an unknown account name", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const err = await fetchMail(vault, { account: "nope" }, fakeImap([])).catch((e) => e);
    expect(err.code).toBe(-32002);
  });

  it("rejects account names that are unsafe as vault directories", async () => {
    const bad = { accounts: [{ name: "../evil", host: "h", user: "u", password: "p" }] };
    const { vault, files } = fakeVault({ "mail/accounts.json": JSON.stringify(bad) });
    const result = await fetchMail(vault, {}, fakeImap([{ uid: 1, source: MIME("s", "b") }]));
    expect(result.accounts[0]!.error).toContain("invalid account name");
    expect([...files.keys()].filter((p) => p.includes("evil"))).toHaveLength(0);
  });

  it("deletes selected remote messages by UID", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    let activeDeletes = 0;
    let peakDeletes = 0;
    const messageDelete = vi.fn(async (_range: number[]) => {
      activeDeletes += 1;
      peakDeletes = Math.max(peakDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeDeletes -= 1;
      return true;
    });
    const factory: ImapFactory = () => ({
      capabilities: new Map([["UIDPLUS", true]]),
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: async function* () {},
      messageDelete,
      logout: async () => {},
    });

    await expect(deleteMail(vault, { account: "qq", uids: [7, 7, 8] }, factory)).resolves.toEqual({
      account: "qq",
      deleted: 2,
    });
    expect(messageDelete).toHaveBeenNthCalledWith(1, [7], { uid: true });
    expect(messageDelete).toHaveBeenNthCalledWith(2, [8], { uid: true });
    expect(messageDelete).toHaveBeenCalledTimes(2);
    expect(peakDeletes).toBe(1);
  });

  it("refuses remote deletion without UIDPLUS", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const messageDelete = vi.fn(async () => true);
    const factory: ImapFactory = () => ({
      capabilities: new Map(),
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: async function* () {},
      messageDelete,
      logout: async () => {},
    });

    await expect(deleteMail(vault, { account: "qq", uids: [7] }, factory)).rejects.toThrow("UIDPLUS");
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it("sends a message through the configured SMTP transport", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const send = vi.fn(async () => ({ messageId: "<depdek-1@example.com>" }));
    const close = vi.fn();
    const factory: SmtpFactory = () => ({ sendMail: send, close });

    await expect(sendMail(vault, {
      account: "qq",
      to: "recipient@example.com",
      subject: "Hello",
      text: "Local-first message",
    }, factory)).resolves.toEqual({ account: "qq", message_id: "<depdek-1@example.com>" });
    expect(send).toHaveBeenCalledWith({
      from: "a@qq.com",
      to: "recipient@example.com",
      subject: "Hello",
      text: "Local-first message",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends an optional HTML body alongside the plain-text fallback", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const send = vi.fn(async () => ({ messageId: "<depdek-html@example.com>" }));
    await sendMail(vault, {
      account: "qq",
      to: "recipient@example.com",
      subject: "Rich",
      text: "Plain fallback",
      html: "<p>Rich body</p>",
    }, () => ({ sendMail: send }));
    expect(send).toHaveBeenCalledWith({
      from: "a@qq.com",
      to: "recipient@example.com",
      subject: "Rich",
      text: "Plain fallback",
      html: "<p>Rich body</p>",
    });
  });

  it("decodes outbound attachments and sanitizes their filenames", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const send = vi.fn(async () => ({ messageId: "<depdek-attachment@example.com>" }));
    await sendMail(vault, {
      account: "qq",
      to: "recipient@example.com",
      text: "See attached",
      attachments: [{ name: "../报价单.pdf", mime: "application/pdf", content_base64: Buffer.from("PDF").toString("base64") }],
    }, () => ({ sendMail: send }));
    const message = send.mock.calls[0]?.[0] as { attachments?: Array<{ filename: string; content: Buffer; contentType: string }> };
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]?.filename).toBe("报价单.pdf");
    expect(message.attachments?.[0]?.content.toString()).toBe("PDF");
    expect(message.attachments?.[0]?.contentType).toBe("application/pdf");
  });

  it("lists remote folders and preserves special-use metadata", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const list = vi.fn(async () => [
      { path: "INBOX", specialUse: "\\Inbox", subscribed: true, status: { messages: 3, unseen: 1 } },
      { path: "Archive", specialUse: "\\Archive", subscribed: true, status: { messages: 9, unseen: 0 } },
    ]);
    const factory: ImapFactory = () => ({
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: async function* () {},
      messageDelete: async () => true,
      list,
      logout: async () => {},
    });

    await expect(listMailboxes(vault, { account: "qq" }, factory)).resolves.toEqual({
      account: "qq",
      mailboxes: [
        { path: "INBOX", special_use: "\\Inbox", subscribed: true, messages: 3, unseen: 1 },
        { path: "Archive", special_use: "\\Archive", subscribed: true, messages: 9, unseen: 0 },
      ],
    });
    expect(list).toHaveBeenCalledWith({ statusQuery: { messages: true, unseen: true } });
  });

  it("applies remote actions one UID at a time and reports progress", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const active = { value: 0, peak: 0 };
    const flagsAdd = vi.fn(async () => {
      active.value += 1;
      active.peak = Math.max(active.peak, active.value);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active.value -= 1;
      return true;
    });
    const move = vi.fn(async () => true);
    const factory: ImapFactory = () => ({
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: async function* () {},
      messageDelete: async () => true,
      messageFlagsAdd: flagsAdd,
      messageMove: move,
      logout: async () => {},
      list: async () => [{ path: "Archive", specialUse: "\\Archive" }],
    });
    const events: string[] = [];

    await expect(applyMailAction(vault, {
      account: "qq",
      action: "archive",
      uids: [7, 7, 8],
    }, factory, (event) => events.push(`${event.uid}:${event.current}/${event.total}`))).resolves.toEqual({
      account: "qq",
      action: "archive",
      processed: 2,
      destination: "Archive",
    });
    expect(move).toHaveBeenNthCalledWith(1, [7], "Archive", { uid: true });
    expect(move).toHaveBeenNthCalledWith(2, [8], "Archive", { uid: true });
    expect(move).toHaveBeenCalledTimes(2);
    expect(active.peak).toBe(0);
    expect(events).toEqual(["7:1/2", "7:1/2", "8:2/2", "8:2/2"]);
  });

  it("marks messages read through UID STORE", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    const flagsAdd = vi.fn(async () => true);
    const factory: ImapFactory = () => ({
      connect: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: async function* () {},
      messageDelete: async () => true,
      messageFlagsAdd: flagsAdd,
      logout: async () => {},
    });

    await applyMailAction(vault, { account: "qq", action: "mark_read", uids: [9] }, factory);
    expect(flagsAdd).toHaveBeenCalledWith([9], ["\\Seen"], { uid: true });
  });
});

describe("renderMessageMarkdown", () => {
  it("renders headers, body and downloadable attachment metadata", () => {
    const md = renderMessageMarkdown({
      subject: "Hi",
      from: { text: "Alice <alice@example.com>" },
      to: [{ text: "bob@example.com" }],
      date: new Date("2024-01-01T00:00:00Z"),
      text: "hello world",
      attachments: [{ filename: "a.pdf" }, {}],
    }, 7, [{ name: "a.pdf", path: "mail/qq/attachments/7/01-a.pdf", size: 42, mime: "application/pdf" }]);
    expect(md).toContain("# Hi");
    expect(md).toContain("**From:** Alice <alice@example.com>");
    expect(md).toContain("**To:** bob@example.com");
    expect(md).toContain("**Attachments:**");
    expect(md).toContain("mail/qq/attachments/7/01-a.pdf");
    expect(md).toContain("hello world");
  });

  it("preserves HTML and plain-text alternatives for the reader", () => {
    const md = renderMessageMarkdown({
      subject: "Rich mail",
      date: new Date("2024-01-01T00:00:00Z"),
      text: "plain fallback",
      html: "<html><body><h1>Rich</h1><img src=\"cid:logo\"></body></html>",
    }, 42);
    expect(md).toContain("**Body format:** html + plain-text");
    expect(md).toContain("**UID:** 42");
    expect(md).toContain("<!-- depdek:mail-html:start -->");
    expect(md).toContain("<h1>Rich</h1>");
    expect(md).toContain("<!-- depdek:mail-text:start -->");
    expect(md).toContain("plain fallback");
  });
});
