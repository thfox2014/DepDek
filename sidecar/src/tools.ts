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
  format: (result: any) => string;
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
      const result = await client.request(options.method, {
        session_id: sessionId,
        ...options.toParams(args),
      });
      return {
        content: [{ type: "text", text: options.format(result) }],
        details: result,
      };
    },
  };
}

const pathParam = Type.String({
  description: "Path relative to the data folder root (POSIX style, '.' for the root).",
});

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
      format: (result) =>
        (result.entries as { name: string; kind: string; size: number }[])
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
