import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TodoEnqueueInput, TodoItem, TodoUpdateInput } from "./todoTypes";

// ---------------------------------------------------------------------------
// Types shared with the Rust core / sidecar (see docs/contract.md).
// ---------------------------------------------------------------------------

export type ProviderConfig =
  | { kind: "openai"; api_key: string; model: string; base_url?: string }
  | { kind: "anthropic"; api_key: string; model: string }
  | { kind: "openai-compatible"; api_key?: string; model: string; base_url: string };

/** Agent execution engine. `deepseek-harness` is an optional local dsh CLI bridge. */
export type AgentEngine = "pi" | "deepseek-harness";

export interface AuditEntry {
  ts_ms: number;
  session_id: string;
  op: "read" | "write" | "list" | "search" | "delete" | "stat";
  path: string;
  ok: boolean;
  error?: string;
  sha256?: string;
  size?: number;
}

export interface SavedAgent {
  id: string;
  label: string;
  provider_name: string;
  system_prompt?: string;
  /** Local, non-executable prompt workspace for this agent. */
  config_dir?: string;
  engine?: AgentEngine;
}

export interface Settings {
  last_root?: string | null;
  obsidian_root?: string | null;
  providers: Record<string, ProviderConfig>;
  agents?: SavedAgent[];
}

export type AgentEventType =
  | "progress"
  | "text_delta"
  | "tool_call_start"
  | "tool_call_end"
  | "message_complete"
  | "error";

export interface AgentEvent {
  session_id: string;
  type: AgentEventType;
  data: Record<string, unknown>;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size: number;
}

export interface ReadFileResult {
  content: string;
  size: number;
  sha256: string;
}

export interface WriteFileResult {
  size: number;
  sha256: string;
}

export interface CompressResult {
  source: string;
  archive: string;
  files: number;
  bytes: number;
  archive_size: number;
}

export interface ReadBinaryResult {
  data_base64: string;
  size: number;
  sha256: string;
  mime: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface ObsidianNote {
  path: string;
  title: string;
  folder: string;
  size: number;
  modified_ms: number;
}

export interface ObsidianReadResult {
  path: string;
  content: string;
  size: number;
  sha256: string;
}

export type MemoryStatus = "candidate" | "confirmed" | "rejected" | "expired" | "tombstoned";

export interface MemoryRecord {
  id: string;
  scope: string;
  kind: string;
  text: string;
  status: MemoryStatus;
  sensitivity: string;
  confidence: number;
  source_refs: string[];
  created_by?: { type: "user" | "agent"; engine?: string; session_id: string };
  valid_from?: string;
  valid_until?: string;
  supersedes?: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryQueryInput {
  query?: string;
  scopes?: string[];
  statuses?: MemoryStatus[];
  sourceDomains?: string[];
  limit?: number;
  maxChars?: number;
}

export interface MemoryQueryResult {
  items: MemoryRecord[];
  total: number;
  index_version: string;
}

export interface MemoryStats {
  total: number;
  by_status: Record<string, number>;
  by_scope: Record<string, number>;
  malformed_events: number;
  index_version: string;
}

// Mail (contract sections 2.5 and 7).
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

export interface MailFetchAccountResult {
  name: string;
  new_messages: number;
  error?: string;
}

export interface MailFetchResult {
  fetched: number;
  accounts: MailFetchAccountResult[];
}

export type MailProgressPhase = "connecting" | "connected" | "reading" | "saving" | "completed" | "error";

export interface MailProgressEvent {
  account: string;
  phase: MailProgressPhase;
  message: string;
  current?: number;
  total?: number;
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

export type CalendarProvider = "google" | "microsoft" | "apple" | "caldav" | "ics";

export interface CalendarAccount {
  id: string;
  name: string;
  provider: CalendarProvider;
  endpoint?: string;
  write_endpoint?: string;
  calendar_id?: string;
  user?: string;
  password?: string;
  access_token?: string;
  enabled?: boolean;
  readonly?: boolean;
}

export interface CalendarEvent {
  id: string;
  remote_id?: string;
  source_account_id?: string;
  source_name?: string;
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  updated_at?: string;
}

export interface CalendarSyncAccountResult {
  id: string;
  name: string;
  imported: number;
  error?: string;
}

export interface CalendarSyncResult {
  imported: number;
  accounts: CalendarSyncAccountResult[];
}

export interface CalendarPushResult {
  account: string;
  event_id: string;
  remote_id: string;
}

// Canonical todo queue (contract sections 2.7 and 9).
export interface TodoListResult {
  version: 1;
  updatedAt: string;
  items: TodoItem[];
}

export interface TodoEnqueueResult {
  item: TodoItem;
  duplicate?: boolean;
}

export interface TodoUpdateResult {
  item: TodoItem;
}

export interface AuditReadResult {
  entries: AuditEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Tauri commands (contract section 3).
//
// Tauri 2 converts camelCase JS argument keys to snake_case Rust command
// parameters, so multi-word args are sent as sessionId / systemPrompt.
// ---------------------------------------------------------------------------

export const vaultSetRoot = (path: string) => invoke<string>("vault_set_root", { path });
export const vaultGetRoot = () => invoke<string | null>("vault_get_root");
export const vaultReadFile = (path: string) =>
  invoke<ReadFileResult>("vault_read_file", { path });
export const vaultReadBinary = (path: string) =>
  invoke<ReadBinaryResult>("vault_read_binary", { path });
export const vaultWriteFile = (path: string, content: string) =>
  invoke<WriteFileResult>("vault_write_file", { path, content });
export const vaultWriteBinary = (path: string, dataBase64: string) =>
  invoke<WriteFileResult>("vault_write_binary", { path, dataBase64 });
export const vaultListDir = (path: string) =>
  invoke<{ entries: DirEntry[] }>("vault_list_dir", { path });
export const vaultSearchFiles = (query: string) =>
  invoke<{ matches: SearchMatch[] }>("vault_search_files", { query });
export const vaultDeleteFile = (path: string) => invoke<void>("vault_delete_file", { path });
export const vaultCompress = (path: string, archivePath?: string) =>
  invoke<CompressResult>("vault_compress", { path, archivePath });

export const auditRead = (offset = 0, limit = 100) =>
  invoke<AuditReadResult>("audit_read", { offset, limit });

export const agentCreateSession = (
  sessionId: string,
  provider: ProviderConfig,
  systemPrompt?: string,
  engine?: AgentEngine,
) => invoke<{ session_id: string }>("agent_create_session", { sessionId, provider, systemPrompt, engine });
export const agentSend = (sessionId: string, text: string) =>
  invoke<void>("agent_send", { sessionId, text });
export const agentAnalyze = (provider: ProviderConfig, text: string, systemPrompt: string, engine?: AgentEngine) =>
  invoke<{ text: string }>("agent_analyze", { provider, text, systemPrompt, engine });
export const agentAbort = (sessionId: string) => invoke<void>("agent_abort", { sessionId });
export const agentClose = (sessionId: string) => invoke<void>("agent_close", { sessionId });

export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (settings: Settings) => invoke<void>("settings_set", { settings });
export const obsidianSetRoot = (path: string) => invoke<string>("obsidian_set_root", { path });
export const obsidianGetRoot = () => invoke<string | null>("obsidian_get_root");
export const obsidianClearRoot = () => invoke<void>("obsidian_clear_root");
export const obsidianListNotes = (query?: string) => invoke<{ notes: ObsidianNote[] }>("obsidian_list_notes", { query });
export const obsidianReadNote = (path: string) => invoke<ObsidianReadResult>("obsidian_read_note", { path });

export const memoryQuery = (input: MemoryQueryInput = {}) =>
  invoke<MemoryQueryResult>("memory_query", input as Record<string, unknown>);
export const memoryGet = (id: string) => invoke<{ memory: MemoryRecord }>("memory_get", { id });
export const memoryPropose = (input: {
  text: string;
  kind?: string;
  scope?: string;
  sourceRefs?: string[];
  sensitivity?: string;
  confidence?: number;
  engine?: string;
}) => invoke<MemoryRecord>("memory_propose", input);
export const memoryConfirm = (id: string, text?: string, scope?: string) =>
  invoke<MemoryRecord>("memory_confirm", { id, text, scope });
export const memoryReject = (id: string) => invoke<MemoryRecord>("memory_reject", { id });
export const memoryTombstone = (id: string) => invoke<MemoryRecord>("memory_tombstone", { id });
export const memoryStats = () => invoke<MemoryStats>("memory_stats");
export const memoryRebuildIndex = () => invoke<Record<string, unknown>>("memory_rebuild_index");

export const mailFetch = (account?: string, refreshBody = false) =>
  invoke<MailFetchResult>("mail_fetch", { account, refreshBody });

export const mailDelete = (account: string, uids: number[]) =>
  invoke<MailDeleteResult>("mail_delete", { account, uids });
export const mailListMailboxes = (account: string) =>
  invoke<{ account: string; mailboxes: MailboxInfo[] }>("mail_list_mailboxes", { account });
export const mailAction = (
  account: string,
  action: MailActionName,
  uids: number[],
  options: { destination?: string; mailbox?: string } = {},
) => invoke<MailActionResult>("mail_action", { account, action, uids, ...options });
export const mailSend = (input: MailSendInput) =>
  invoke<MailSendResult>("mail_send", { ...input } as Record<string, unknown>);

export const calendarSync = (account?: string) =>
  invoke<CalendarSyncResult>("calendar_sync", { account });

export const calendarPush = (account: string, event: CalendarEvent) =>
  invoke<CalendarPushResult>("calendar_push", { account, event });

export const todoList = () => invoke<TodoListResult>("todo_list");
export const todoEnqueue = (input: TodoEnqueueInput) =>
  invoke<TodoEnqueueResult>("todo_enqueue", { input });
export const todoUpdate = (input: TodoUpdateInput) =>
  invoke<TodoUpdateResult>("todo_update", { input });

// ---------------------------------------------------------------------------
// Tauri events (contract section 4).
// ---------------------------------------------------------------------------

export const onAgentEvent = (cb: (ev: AgentEvent) => void): Promise<UnlistenFn> =>
  listen<AgentEvent>("agent://event", (e) => cb(e.payload));

export const onAuditEntry = (cb: (entry: AuditEntry) => void): Promise<UnlistenFn> =>
  listen<AuditEntry>("vault://audit", (e) => cb(e.payload));

export const onMailEvent = (cb: (payload: MailProgressEvent) => void): Promise<UnlistenFn> =>
  listen<MailProgressEvent>("mail://event", (e) => cb(e.payload));

export const onMailActionEvent = (cb: (payload: MailActionProgressEvent) => void): Promise<UnlistenFn> =>
  listen<MailActionProgressEvent>("mail://action-event", (e) => cb(e.payload));

export const onTodoEvent = (cb: (payload: Record<string, unknown>) => void): Promise<UnlistenFn> =>
  listen<Record<string, unknown>>("todo://event", (e) => cb(e.payload));
