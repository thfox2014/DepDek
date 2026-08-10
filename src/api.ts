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
}

export interface Settings {
  last_root?: string | null;
  providers: Record<string, ProviderConfig>;
  agents?: SavedAgent[];
}

export type AgentEventType =
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
export const vaultListDir = (path: string) =>
  invoke<{ entries: DirEntry[] }>("vault_list_dir", { path });
export const vaultSearchFiles = (query: string) =>
  invoke<{ matches: SearchMatch[] }>("vault_search_files", { query });
export const vaultDeleteFile = (path: string) => invoke<void>("vault_delete_file", { path });

export const auditRead = (offset = 0, limit = 100) =>
  invoke<AuditReadResult>("audit_read", { offset, limit });

export const agentCreateSession = (
  sessionId: string,
  provider: ProviderConfig,
  systemPrompt?: string,
) => invoke<{ session_id: string }>("agent_create_session", { sessionId, provider, systemPrompt });
export const agentSend = (sessionId: string, text: string) =>
  invoke<void>("agent_send", { sessionId, text });
export const agentAbort = (sessionId: string) => invoke<void>("agent_abort", { sessionId });
export const agentClose = (sessionId: string) => invoke<void>("agent_close", { sessionId });

export const settingsGet = () => invoke<Settings>("settings_get");
export const settingsSet = (settings: Settings) => invoke<void>("settings_set", { settings });

export const mailFetch = (account?: string, refreshBody = false) =>
  invoke<MailFetchResult>("mail_fetch", { account, refreshBody });

export const mailDelete = (account: string, uids: number[]) =>
  invoke<MailDeleteResult>("mail_delete", { account, uids });

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

export const onTodoEvent = (cb: (payload: Record<string, unknown>) => void): Promise<UnlistenFn> =>
  listen<Record<string, unknown>>("todo://event", (e) => cb(e.payload));
