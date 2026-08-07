import { describe, expect, it, vi } from "vitest";
import { fetchMail, renderMessageMarkdown, type ImapFactory, type MailAccount } from "../src/mail.js";
import { RpcError } from "../src/rpc.js";
import type { VaultClient } from "../src/tools.js";

/** In-memory vault: read_file/write_file over a path->content map. */
function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
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
      throw new Error(`unexpected method ${method}`);
    }),
  };
  return { vault, files };
}

const MIME = (subject: string, body: string) =>
  `From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: ${subject}\r\n` +
  `Date: Mon, 1 Jan 2024 00:00:00 +0000\r\nContent-Type: text/plain\r\n\r\n${body}`;

/** Fake IMAP factory yielding the given messages (uid/source pairs). */
function fakeImap(
  messages: { uid: number; source: string }[],
  hooks: { failConnect?: boolean } = {},
): ImapFactory {
  return (_account: MailAccount) => ({
    connect: async () => {
      if (hooks.failConnect) throw new Error("connection refused");
    },
    getMailboxLock: async () => ({ release: () => {} }),
    fetch: async function* () {
      for (const m of messages) yield { uid: m.uid, source: Buffer.from(m.source) };
    },
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
    const written = [...files.keys()].filter((p) => p.startsWith("mail/qq/"));
    expect(written).toHaveLength(2);
    expect(files.get(written[0]!)).toContain("# hello");
    // last_uid advanced to 7 and was written back
    const saved = JSON.parse(files.get("mail/accounts.json")!);
    expect(saved.accounts[0].last_uid).toBe(7);
    expect(saved.accounts[1].last_uid).toBeUndefined();
  });

  it("tags vault operations with session_id mail", async () => {
    const { vault } = fakeVault({ "mail/accounts.json": JSON.stringify(CONFIG) });
    await fetchMail(vault, { account: "qq" }, fakeImap([{ uid: 6, source: MIME("s", "b") }]));
    for (const call of (vault.request as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1].session_id).toBe("mail");
    }
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
});

describe("renderMessageMarkdown", () => {
  it("renders headers, body and attachment names", () => {
    const md = renderMessageMarkdown({
      subject: "Hi",
      from: { text: "Alice <alice@example.com>" },
      to: [{ text: "bob@example.com" }],
      date: new Date("2024-01-01T00:00:00Z"),
      text: "hello world",
      attachments: [{ filename: "a.pdf" }, {}],
    });
    expect(md).toContain("# Hi");
    expect(md).toContain("**From:** Alice <alice@example.com>");
    expect(md).toContain("**To:** bob@example.com");
    expect(md).toContain("**Attachments (not saved):** a.pdf");
    expect(md).toContain("hello world");
  });
});
