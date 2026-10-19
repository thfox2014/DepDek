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

export type AiOsConnectionMode = "online" | "local";
export interface AiOsStatus {
  enabled: boolean; initialized: boolean; authenticated: boolean; configured: boolean;
  username: string | null; balance: number; grant_points: number; chat_cost: number;
  model_ready?: boolean; connection_mode?: AiOsConnectionMode; mode_locked?: boolean;
  preferences?: { display_name: string; language: string; purpose: string };
  /** Persisted platform association, not a live cloud session or permission grant. */
  bitbay?: { email: string; user_id: number } | null;
}
export interface AiOsNetworkStatus {
  platform: string; interfaces: { name: string; addresses: string[] }[]; settings_available: boolean;
  /** Successful bounded HTTPS probe, no usable address, or unconfirmed reachability. */
  connectivity: "online" | "offline" | "limited";
}
export const aiOsStatus = () => invoke<AiOsStatus>("ai_os_status");
export const aiOsLogin = (username: string, password: string, register: boolean) => invoke<AiOsStatus>(register ? "ai_os_register" : "ai_os_login", { username, password });
export const aiOsSetConnectionMode = (mode: AiOsConnectionMode) => invoke<AiOsStatus>("ai_os_set_connection_mode", { mode });
export const aiOsNetworkStatus = () => invoke<AiOsNetworkStatus>("ai_os_network_status");
export const aiOsOpenNetworkSettings = () => invoke<void>("ai_os_open_network_settings");
export const aiOsBitBaySendCode = (email: string) => invoke<{ sent: true; retry_after_seconds: number }>("ai_os_bitbay_send_code", { email });
export const aiOsBitBayRegister = (email: string, code: string, password: string) => invoke<AiOsStatus>("ai_os_bitbay_register", { email, code, password });
export const aiOsBitBayLogin = (email: string, password: string, localPassword?: string) => invoke<AiOsStatus>("ai_os_bitbay_login", { email, password, localPassword });
export const aiOsComplete = (displayName: string, language: string, purpose: string) => invoke<AiOsStatus>("ai_os_complete", { displayName, language, purpose });

export interface AuditEntry {
  ts_ms: number;
  session_id: string;
  op: "read" | "write" | "list" | "search" | "delete" | "stat" | "team" | "mcp" | "approval" | "schedule";
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
  /** Enabled capability groups; runtime tools are filtered from this allow-list. */
  enabled_skills?: AgentSkill[];
}

export type AgentSkill = "documents" | "photos" | "music" | "videos" | "mail" | "memory";

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

export type TeamTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type TeamTaskKind = "delegate" | "message";

/** One delegated task or agent-to-agent message. See contract section 2.11. */
export interface TeamTask {
  id: string;
  kind: TeamTaskKind;
  status: TeamTaskStatus;
  from_session_id: string;
  from_label: string;
  to_session_id: string;
  to_label: string;
  instruction: string;
  depth: number;
  chain: string[];
  created_at: string;
  updated_at: string;
  result_preview?: string;
  error?: string;
  pending_delivery?: boolean;
}

export interface TeamPolicyRule {
  from: string;
  to: string;
  allow: boolean;
}

export interface TeamPolicy {
  version: 1;
  mode: "allow" | "deny";
  rules: TeamPolicyRule[];
}

export type ApprovalKind = "write" | "external" | "email";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalCard {
  id: string;
  session_id: string;
  kind: ApprovalKind;
  tool: string;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  status: ApprovalStatus;
  created_at: string;
  decided_at?: string;
}

export interface McpConnector {
  id: string;
  label: string;
  url: string;
  auth: "none" | "bearer" | "oauth";
}

export interface Routine {
  id: string;
  label: string;
  agent_id: string;
  prompt: string;
  enabled: boolean;
  trigger: { type: "cron"; expr: string } | { type: "event"; source: "mail" | "todo"; match?: string };
  created_at: string;
  updated_at: string;
  last_fired_at?: string;
  last_status?: "ran" | "skipped" | "failed";
  last_error?: string;
}

export interface TeamEvent {
  task: TeamTask;
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

export interface StorageVolume {
  name: string;
  file_system: string;
  mount_point: string;
  kind: string;
  removable: boolean;
  total_bytes: number;
  available_bytes: number;
  used_bytes: number;
  used_pct: number;
}

export interface StorageSnapshot {
  sampled_at_ms: number;
  volumes: StorageVolume[];
}

// ---------------------------------------------------------------------------
// Tauri commands (contract section 3).
//
// Tauri 2 converts camelCase JS argument keys to snake_case Rust command
// parameters, so multi-word args are sent as sessionId / systemPrompt.
// ---------------------------------------------------------------------------

export const vaultSetRoot = (path: string) => invoke<string>("vault_set_root", { path });
export const vaultGetRoot = () => invoke<string | null>("vault_get_root");
export const vaultInitHome = () => invoke<string>("vault_init_home");
export const storageSummary = () => invoke<StorageSnapshot>("storage_summary");
export const voiceTranscribe = (audioBase64: string) => invoke<string>("voice_transcribe", { audioBase64 });
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

export type FileCategory = "photos" | "documents" | "videos" | "mail" | "other";
export interface FileIndexRecord {
  path: string;
  original_path: string;
  name: string;
  sha256: string;
  category: FileCategory;
  detected_by: "signature" | "extension" | "depdek_mail" | "fallback";
  size: number;
  modified_ms: number;
  indexed_at_ms: number;
}
export interface FileIndexSummary {
  indexed_at_ms: number;
  total: number;
  total_bytes: number;
  categories: Record<FileCategory, number>;
  skipped: number;
}
export interface FileIndexFilter {
  category?: FileCategory;
  query?: string;
  sha256?: string;
  path_prefix?: string;
  offset?: number;
  limit?: number;
}
export interface FileIndexResult {
  items: FileIndexRecord[];
  total: number;
  summary: FileIndexSummary;
}
export const fileIndexQuery = (filter: FileIndexFilter = {}) => invoke<FileIndexResult>("file_index_query", { filter });
export const fileIndexRefresh = () => invoke<FileIndexSummary>("file_index_refresh");

export type PhotoTagKind = "person" | "place" | "event" | "captured_date" | "note" | "selection";
export interface PhotoTag { kind: PhotoTagKind; value: string }
export interface PhotoLibraryItem { file: FileIndexRecord; tags: PhotoTag[] }
export interface PhotoTagRecord { path: string; sha256: string; tags: PhotoTag[]; updated_at_ms: number }
export interface PhotoLibraryFilter { query?: string; sha256?: string; offset?: number; limit?: number }
export interface PhotoLibraryResult { items: PhotoLibraryItem[]; total: number; summary: FileIndexSummary }
export const photoLibraryQuery = (filter: PhotoLibraryFilter = {}) => invoke<PhotoLibraryResult>("photo_library_query", { filter });
export const photoPreview = (path: string, expectedSha256: string) => invoke<ReadBinaryResult>("photo_preview", { path, expectedSha256 });
export const photoTagsSet = (path: string, expectedSha256: string, tags: PhotoTag[]) => invoke<PhotoTagRecord>("photo_tags_set", { path, expectedSha256, tags });

export const auditRead = (offset = 0, limit = 100) =>
  invoke<AuditReadResult>("audit_read", { offset, limit });

export const agentCreateSession = (
  sessionId: string,
  provider: ProviderConfig,
  systemPrompt?: string,
  engine?: AgentEngine,
  enabledSkills?: AgentSkill[],
  label?: string,
  configDir?: string,
) => invoke<{ session_id: string }>("agent_create_session", { sessionId, provider, systemPrompt, engine, enabledSkills, label, configDir });
export const teamList = () => invoke<{ tasks: TeamTask[] }>("team_list");
export const teamCancel = (taskId: string) => invoke<{ task: TeamTask }>("team_cancel", { taskId });
export const teamRoster = (agents: Array<{ id: string; label: string }>) =>
  invoke<{ updated: number }>("team_roster", { agents });
export const teamPolicyGet = () => invoke<{ policy: TeamPolicy }>("team_policy_get");
export const teamPolicySet = (policy: TeamPolicy) => invoke<{ policy: TeamPolicy }>("team_policy_set", { policy });
export const approvalList = () => invoke<{ cards: ApprovalCard[] }>("approval_list");
export const approvalDecide = (id: string, decision: "approve" | "deny") =>
  invoke<{ card: ApprovalCard }>("approval_decide", { id, decision });
export const scheduleList = () => invoke<{ routines: Routine[] }>("schedule_list");
export const schedulePut = (routine: Partial<Routine> & Pick<Routine, "label" | "agent_id" | "prompt" | "trigger">) =>
  invoke<{ routine: Routine }>("schedule_put", { routine });
export const scheduleDelete = (id: string) => invoke<{ deleted: boolean }>("schedule_delete", { id });
export const mcpConnectorsGet = () => invoke<{ connectors: McpConnector[] }>("mcp_connectors_get");
export const mcpConnectorPut = (connector: McpConnector) => invoke<{ connector: McpConnector }>("mcp_connector_put", { connector });
export const mcpConnectorDelete = (id: string) => invoke<{ deleted: boolean }>("mcp_connector_delete", { id });
export const mcpOauthStore = (body: {
  connector_id: string;
  access_token?: string;
  refresh_token?: string;
  token_url?: string;
  client_id?: string;
  client_secret?: string;
  token?: string;
}) => invoke<{ connector_id: string; stored: string[] }>("mcp_oauth_store", { body });
export const mcpOauthStatus = (connectorId: string) => invoke<{
  connector_id: string;
  has_access_token: boolean;
  has_refresh_token: boolean;
  has_bearer_token: boolean;
  has_client_id: boolean;
}>("mcp_oauth_status", { connectorId });
export const mcpListTools = (connectorId: string) => invoke<{
  connector_id: string;
  tools: Array<{ name: string; description: string }>;
}>("mcp_list_tools", { connectorId });
export const mcpReload = (sessionId: string) => invoke<{ grants: string[] }>("mcp_reload", { sessionId });
export const agentSend = (sessionId: string, text: string) =>
  invoke<void>("agent_send", { sessionId, text });
export const agentAnalyze = (provider: ProviderConfig, text: string, systemPrompt: string, engine?: AgentEngine) =>
  invoke<{ text: string }>("agent_analyze", { provider, text, systemPrompt, engine });
export const agentAbort = (sessionId: string) => invoke<void>("agent_abort", { sessionId });
export const agentClose = (sessionId: string) => invoke<void>("agent_close", { sessionId });

// Browser-only UX preview: Tauri commands are unavailable in Vite. Settings
// are then read and written through the standalone agent HTTP service, which
// persists them as files in the local data folder (never in browser storage).
const AGENT_HTTP_BASE = "/v1";
const isBrowserPreview = () => typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

async function agentService<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AGENT_HTTP_BASE}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `agent 服务请求失败：${init?.method ?? "GET"} ${path} → HTTP ${response.status}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const settingsGet = async (): Promise<Settings> => {
  if (isBrowserPreview()) return agentService<Settings>("/settings");
  return invoke<Settings>("settings_get");
};

export const settingsSet = async (settings: Settings): Promise<void> => {
  if (isBrowserPreview()) {
    await agentService<void>("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    return;
  }
  return invoke<void>("settings_set", { settings });
};

// Conversation history (contract 6.2): the authoritative copy lives in the
// vault as `agent/<id>/conversations.json`. Desktop reads it through the Rust
// vault commands; the browser preview goes through the agent HTTP service
// (vault route, same path pattern). Returns null when no history exists yet.
export const conversationRead = async (agentId: string): Promise<string | null> => {
  const path = `agent/${agentId}/conversations.json`;
  if (isBrowserPreview()) {
    try {
      const result = await agentService<{ content: string; size: number }>(
        `/vault/read?path=${encodeURIComponent(path)}`,
      );
      return result.content;
    } catch (err) {
      if (String(err).includes("404") || String(err).includes("not found")) return null;
      throw err;
    }
  }
  try {
    const result = await invoke<ReadFileResult>("vault_read_file", { path });
    return result.content;
  } catch (err) {
    // -32002 = path does not exist (no history yet).
    if (String(err).includes("-32002") || String(err).toLowerCase().includes("not found")) return null;
    throw err;
  }
};

export const conversationWrite = async (agentId: string, content: string): Promise<void> => {
  const path = `agent/${agentId}/conversations.json`;
  if (isBrowserPreview()) {
    await agentService<void>("/vault/write", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    return;
  }
  await invoke<WriteFileResult>("vault_write_file", { path, content });
};
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

export const onTeamEvent = (cb: (ev: TeamEvent) => void): Promise<UnlistenFn> =>
  listen<TeamEvent>("team://event", (e) => cb(e.payload));

export const onApprovalEvent = (cb: (ev: { card: ApprovalCard }) => void): Promise<UnlistenFn> =>
  listen<{ card: ApprovalCard }>("approval://event", (e) => cb(e.payload));

export const onScheduleEvent = (cb: (ev: { phase: string; routine: Routine }) => void): Promise<UnlistenFn> =>
  listen<{ phase: string; routine: Routine }>("schedule://event", (e) => cb(e.payload));

export const onAuditEntry = (cb: (entry: AuditEntry) => void): Promise<UnlistenFn> =>
  listen<AuditEntry>("vault://audit", (e) => cb(e.payload));

export const onMailEvent = (cb: (payload: MailProgressEvent) => void): Promise<UnlistenFn> =>
  listen<MailProgressEvent>("mail://event", (e) => cb(e.payload));

export const onMailActionEvent = (cb: (payload: MailActionProgressEvent) => void): Promise<UnlistenFn> =>
  listen<MailActionProgressEvent>("mail://action-event", (e) => cb(e.payload));

export const onTodoEvent = (cb: (payload: Record<string, unknown>) => void): Promise<UnlistenFn> =>
  listen<Record<string, unknown>>("todo://event", (e) => cb(e.payload));
