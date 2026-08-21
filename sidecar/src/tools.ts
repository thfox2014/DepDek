/**
 * Agent tools backed by the Rust Vault service.
 *
 * The agent never touches the filesystem directly: every tool's execute()
 * forwards the call to Rust via a vault/* JSON-RPC request (contract 2.3).
 * Rust enforces the sandbox (path validation, size limits, audit log).
 */

import { Type, type Static, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { fetchMail } from "./mail.js";

/** Minimal client interface the tools need (implemented by RpcPeer). */
export interface VaultClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

const SANDBOX_NOTE =
  "You can only access the user's data folder through these tools. " +
  "All paths are POSIX-style relative paths from the data folder root " +
  "('.' refers to the root itself). Absolute paths and '..' escapes are rejected.";

interface VaultToolOptions<TParameters extends TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  /** vault/* RPC method to invoke. */
  method: string;
  /** Build the RPC params from the validated tool arguments. */
  toParams: (args: Static<TParameters>) => Record<string, unknown>;
  /** Render the RPC result as text content for the model. */
  format: (result: any, args: Static<TParameters>) => string;
  /** Reject a tool call before it reaches the vault. */
  guard?: (args: Static<TParameters>) => string | undefined;
}

function vaultTool<TParameters extends TSchema>(
  client: VaultClient,
  sessionId: string,
  options: VaultToolOptions<TParameters>,
): AgentTool<TParameters> {
  return {
    name: options.name,
    label: options.name,
    description: `${options.description}\n\n${SANDBOX_NOTE}`,
    parameters: options.parameters,
    execute: async (_toolCallId, args): Promise<AgentToolResult<any>> => {
      const blocked = options.guard?.(args);
      if (blocked) {
        return {
          content: [{ type: "text", text: blocked }],
          details: { blocked: true },
        };
      }
      const result = await client.request(options.method, {
        session_id: sessionId,
        ...options.toParams(args),
      });
      return {
        content: [{ type: "text", text: options.format(result, args) }],
        details: result,
      };
    },
  };
}

const pathParam = Type.String({
  description: "Path relative to the data folder root (POSIX style, '.' for the root).",
});

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isProtectedContextPath(value: string): boolean {
  return normalizedPath(value) === "tasks/history.json";
}

const PROTECTED_CONTEXT_MESSAGE =
  "tasks/history.json is an internal task log and is excluded from AI context. " +
  "Use the task center for task status and summaries instead.";

const MEMORY_NOTE =
  "Memory is shared by the Agent Team but remains local. Propose only a concise, " +
  "source-backed fact, preference, constraint or procedure; the user must confirm " +
  "it before it can enter any Agent context. Never include passwords, tokens or secrets.";

const MAIL_CONFIG_NOTE =
  "Mail accounts live in the data folder at mail/accounts.json with shape " +
  '{accounts: [{name, host, user, password, port?, secure?, mailbox?}]} ' +
  "(defaults: port 993, secure true, mailbox INBOX). " +
  "To configure an account for the user, ask for the email address, its IMAP " +
  "authorization code/password, and the IMAP server (common ones: QQ imap.qq.com, " +
  "163 imap.163.com, Gmail imap.gmail.com, Outlook outlook.office365.com), " +
  "then write that file with the write_file tool (create or update the accounts array).";

/** Create the vault tools plus fetch_mail bound to a session id (contract 2.3, 2.5). */
export function createVaultTools(client: VaultClient, sessionId: string): AgentTool<any>[] {
  return [
    vaultTool(client, sessionId, {
      name: "read_file",
      description: "Read a UTF-8 text file from the user's data folder.",
      parameters: Type.Object({ path: pathParam }, { additionalProperties: false }),
      method: "vault/read_file",
      toParams: (args) => ({ path: args.path }),
      format: (result) => result.content,
      guard: (args) => isProtectedContextPath(args.path) ? PROTECTED_CONTEXT_MESSAGE : undefined,
    }),
    vaultTool(client, sessionId, {
      name: "write_file",
      description: "Write (create or overwrite) a UTF-8 text file in the user's data folder.",
      parameters: Type.Object(
        {
          path: pathParam,
          content: Type.String({ description: "Full new file content." }),
        },
        { additionalProperties: false },
      ),
      method: "vault/write_file",
      toParams: (args) => ({ path: args.path, content: args.content }),
      format: (result) => `Wrote ${result.size} bytes (sha256 ${result.sha256}).`,
    }),
    vaultTool(client, sessionId, {
      name: "list_files",
      description: "List the entries of a directory in the user's data folder.",
      parameters: Type.Object({ path: pathParam }, { additionalProperties: false }),
      method: "vault/list_dir",
      toParams: (args) => ({ path: args.path }),
      format: (result, args) =>
        (result.entries as { name: string; kind: string; size: number }[])
          .filter((entry) => !isProtectedContextPath(`${args.path}/${entry.name}`))
          .map((entry) => `${entry.kind === "dir" ? "d" : "f"} ${String(entry.size).padStart(10)} ${entry.name}`)
          .join("\n") || "(empty directory)",
    }),
    vaultTool(client, sessionId, {
      name: "search_files",
      description: "Search file contents in the user's data folder (returns up to 50 matches).",
      parameters: Type.Object(
        { query: Type.String({ description: "Substring to search for." }) },
        { additionalProperties: false },
      ),
      method: "vault/search_files",
      toParams: (args) => ({ query: args.query }),
      format: (result) =>
        (result.matches as { path: string; line: number; snippet: string }[])
          .filter((match) => !isProtectedContextPath(match.path))
          .map((match) => `${match.path}:${match.line}: ${match.snippet}`)
          .join("\n") || "(no matches)",
    }),
    vaultTool(client, sessionId, {
      name: "delete_file",
      description: "Delete a file from the user's data folder.",
      parameters: Type.Object({ path: pathParam }, { additionalProperties: false }),
      method: "vault/delete_file",
      toParams: (args) => ({ path: args.path }),
      format: () => "Deleted.",
    }),
    vaultTool(client, sessionId, {
      name: "compress",
      description:
        "Create a local .tar.gz archive of a file or directory. This is a safe built-in " +
        "vault action; it never runs shell commands or accesses data outside the vault. " +
        "Use it when the user asks to compress, archive, or package local data.",
      parameters: Type.Object(
        {
          path: pathParam,
          archive_path: Type.Optional(
            Type.String({ description: "Optional output path, relative to the data folder root." }),
          ),
        },
        { additionalProperties: false },
      ),
      method: "vault/compress",
      toParams: (args) => ({ path: args.path, archive_path: args.archive_path }),
      format: (result) =>
        `Compressed ${result.source} into ${result.archive} (${result.files} file(s), ${result.bytes} bytes).`,
    }),
    vaultTool(client, sessionId, {
      name: "propose_memory",
      description: MEMORY_NOTE,
      parameters: Type.Object(
        {
          text: Type.String({ description: "The concise memory statement to propose." }),
          kind: Type.Optional(Type.String({ description: "fact, preference, constraint, procedure, episode or summary." })),
          scope: Type.Optional(Type.String({ description: "Usually team or user; agent:<id> is allowed for private agent memory." })),
          source_refs: Type.Array(Type.String({ description: "Vault paths or entity references supporting this memory." })),
          confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1." })),
        },
        { additionalProperties: false },
      ),
      method: "memory/propose",
      toParams: (args) => ({
        text: args.text,
        kind: args.kind,
        scope: args.scope,
        source_refs: args.source_refs,
        confidence: args.confidence,
        sensitivity: "private",
        engine: "pi",
      }),
      format: (result) => `Memory candidate ${result.id} saved for user confirmation.`,
    }),
    {
      name: "fetch_mail",
      label: "fetch_mail",
      description:
        "Fetch new emails over IMAP for one or all configured mail accounts and save " +
        "them as markdown files under mail/<account name>/ in the user's data folder. " +
        MAIL_CONFIG_NOTE,
      parameters: Type.Object(
        {
          account: Type.Optional(
            Type.String({ description: "Account display name; omit to fetch all accounts." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<any>> => {
        const { account } = args as { account?: string };
        const result = await fetchMail(client, { account });
        const lines = result.accounts.map((a) =>
          a.error
            ? `${a.name}: failed (${a.error})`
            : `${a.name}: ${a.new_messages} new message(s)`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      },
    },
  ];
}

/** Read-only subset used by structured analysis runs. No mutation or network tools are exposed. */
export function createReadOnlyVaultTools(client: VaultClient, sessionId: string): AgentTool<any>[] {
  return createVaultTools(client, sessionId).filter((tool) =>
    tool.name === "read_file" || tool.name === "list_files" || tool.name === "search_files",
  );
}
