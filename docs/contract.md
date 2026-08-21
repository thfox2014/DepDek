# Agent Workbench 接口契约 v1

本文件是 Rust 核心（`src-tauri/`）、Node sidecar（`sidecar/`）、前端（`src/`）三部分之间的**唯一接口标准**。三部分可独立开发，但不得偏离本契约；任何变更需三方同步更新本文件。

## 1. 总体架构

```
前端 (React)  <--Tauri commands/events-->  Rust 核心  <--stdio JSON-RPC-->  Node sidecar (Pi / DeepSeek Harness)
                                              |
                                              +--> Vault 服务（数据文件夹沙箱读写 + 审计日志）
```

- Agent 对数据文件夹**没有任何直接 fs 访问**；所有文件操作由 sidecar 通过 `vault/*` RPC 请求 Rust 执行。
- Rust 是唯一的信任边界：路径校验、大小限制、审计日志全在 Rust 侧。
- MVP 不提供 shell/bash 工具。需要压缩等本地动作时，只能使用 Rust vault
  提供的受限内置动作，不能把任意命令交给 Agent 执行。

## 2. Sidecar stdio 协议（Rust ↔ sidecar）

- 传输：子进程 stdio，**每条消息一行 JSON**（NDJSON），UTF-8，无内嵌换行。
- 格式：JSON-RPC 2.0。请求 `{"jsonrpc":"2.0","id":<int>,"method":<str>,"params":<obj>}`；成功响应 `{"jsonrpc":"2.0","id":<int>,"result":<any>}`；错误响应 `{"jsonrpc":"2.0","id":<int>,"error":{"code":<int>,"message":<str>,"data":<any?>}}`；通知（无 id）`{"jsonrpc":"2.0","method":<str>,"params":<obj>}`。
- 双方都是 server 也都是 client：Rust 可请求 sidecar 的 `agent/*` 方法；sidecar 可请求 Rust 的 `vault/*` 方法；sidecar 向 Rust 发 `agent/event` 通知。
- sidecar 的 `id` 空间从 100000 起，避免与 Rust 的 id 冲突。

### 2.1 Rust → sidecar：`agent/*` 请求

| 方法 | params | result |
|---|---|---|
| `agent/create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string, engine?: "pi"\|"deepseek-harness"}` | `{session_id}` |
| `agent/send` | `{session_id: string, text: string}` | `{}`（回复经 `agent/event` 流式下发） |
| `agent/analyze` | `{provider: ProviderConfig, text: string, system_prompt: string, engine?: "pi"\|"deepseek-harness"}` | `{text: string}`（一次性只读分析；不创建持久会话，不暴露写入/删除/外部调用工具） |
| `agent/abort` | `{session_id: string}` | `{}` |
| `agent/close_session` | `{session_id: string}` | `{}` |
| `mail/fetch` | `{account?: string, refresh_body?: boolean}`（账号显示名，缺省收全部；`refresh_body` 用于修复旧缓存的正文占位符） | `{fetched: number, accounts: [{name: string, new_messages: number, error?: string}]}` |
| `mail/delete` | `{account: string, uids: number[]}` | `{account: string, deleted: number}`（仅在 IMAP UIDPLUS 可安全定位删除目标时执行） |
| `mail/list_mailboxes` | `{account: string}` | `{account: string, mailboxes: [{path, special_use?, subscribed?, messages?, unseen?}]}` |
| `mail/action` | `{account: string, action: mark_read\|mark_unread\|star\|unstar\|move\|archive\|trash, uids: number[], destination?: string, mailbox?: string}` | `{account: string, action: string, processed: number, destination?: string}`（同一请求内按 UID 串行执行） |
| `mail/send` | `{account: string, to: string, cc?: string, bcc?: string, subject?: string, text: string, html?: string, attachments?: [{name, content_base64, mime?, size?}]}` | `{account: string, message_id: string}`（经账号 SMTP 发送；附件总大小不超过 64 MiB） |
| `calendar/sync` | `{account?: string}` | `{imported: number, accounts: [{id, name, imported, error?}]}` |
| `calendar/push` | `{account: string, event: CalendarEvent}` | `{account: string, event_id: string, remote_id: string}` |
| `todo/list` | `{}` | `{version: 1, updatedAt: string, items: TodoItem[]}` |
| `todo/enqueue` | `{input: TodoEnqueueInput}` | `{item: TodoItem, duplicate?: boolean}` |
| `todo/update` | `{input: TodoUpdateInput}` | `{item: TodoItem}` |

```ts
// ProviderConfig（三方共用同一形状）
type ProviderConfig =
  | { kind: "openai"; api_key: string; model: string; base_url?: string }
  | { kind: "anthropic"; api_key: string; model: string }
  | { kind: "openai-compatible"; api_key?: string; model: string; base_url: string }; // 覆盖 Ollama 等本地端点

type AgentEngine = "pi" | "deepseek-harness";

// SavedAgent.engine selects the sidecar runtime. Omitted means `pi` for
// backwards compatibility. The Harness bridge runs dsh headless in a
// throw-away read-only directory with local filesystem/shell/web/sub-agent
// rows disabled; it never receives the DepDek Home path.
```

### 2.2 sidecar → Rust：`agent/event` 通知

`params = { session_id: string, type: EventType, data: object }`

| type | data |
|---|---|
| `progress` | `{phase: string, message: string, engine?: AgentEngine}`（安全的执行阶段摘要；不包含模型隐藏思维原文） |
| `text_delta` | `{delta: string, engine?: AgentEngine}` |
| `tool_call_start` | `{tool_call_id: string, name: string, args: object}` |
| `tool_call_end` | `{tool_call_id: string, name: string, ok: boolean, result_preview: string}`（preview 截断至 500 字符） |
| `message_complete` | `{stop_reason: string, engine?: AgentEngine}` |
| `error` | `{message: string, engine?: AgentEngine}` |

### 2.3 sidecar → Rust：`vault/*` 请求

所有方法 params 均含 `session_id`（用于审计归属，前端用户操作记为 `"user"`）。`path` 一律为**相对数据文件夹根**的 POSIX 风格相对路径（`.` 表示根）。

| 方法 | params | result |
|---|---|---|
| `vault/read_file` | `{session_id, path}` | `{content: string, size: number, sha256: string}` |
| `vault/write_file` | `{session_id, path, content: string}` | `{size: number, sha256: string}` |
| `vault/list_dir` | `{session_id, path}` | `{entries: [{name: string, kind: "file"\|"dir", size: number}]}` |
| `vault/search_files` | `{session_id, query: string}` | `{matches: [{path: string, line: number, snippet: string}]}`（上限 50 条） |
| `vault/delete_file` | `{session_id, path}` | `{}` |
| `vault/stat` | `{session_id, path}` | `{kind: "file"\|"dir", size: number, modified_ms: number}` |
| `vault/read_binary` | `{session_id, path}` | `{data_base64: string, size: number, sha256: string, mime: string}` |
| `vault/write_binary` | `{session_id, path, data_base64: string}` | `{size: number, sha256: string}` |
| `vault/compress` | `{session_id, path, archive_path?: string}` | `{source, archive, files, bytes, archive_size}` |

`vault/read_binary` 说明：为前端图片/视频/邮件附件预览与下载提供；MIME 按扩展名推断（未知为 `application/octet-stream`）；上限 64 MiB（超出 -32003）；审计记 `op: "read"`。`vault/write_binary` 供邮件 sidecar 导入和用户显式保存发件附件副本，使用相同的 64 MiB 上限并审计为 `op: "write"`。**两者均不注册为 agent 工具**。

`vault/compress` 是唯一的内置压缩动作：在数据文件夹内生成 `.tar.gz`，跳过符号链接和审计文件，最多处理 10,000 个文件、512 MiB 未压缩内容；不调用 shell，审计为 `op: "write"`。sidecar 将其注册为 `compress` 工具，前端输入 `/compress <相对路径>` 时直接走同一 RPC。

sidecar 另注册 `propose_memory` 工具（必须提供 `source_refs`），它只调用
`memory/propose` 写入候选，不会直接改变 Agent 上下文；确认动作只能由用户界面执行。

### 2.4 错误码（Rust 返回）

| code | 含义 |
|---|---|
| -32001 | 路径越出数据文件夹根（含 `..`、绝对路径、逃逸 symlink） |
| -32002 | 路径不存在 |
| -32003 | 超过大小限制（单文件读/写上限 10 MiB） |
| -32004 | 数据文件夹根未设置 |
| -32005 | 非 UTF-8 文本（MVP 只支持文本文件） |
| -32601 | 未知方法 |
| -32010 | session id 重复（sidecar 返回） |
| -32011 | 未知 session（sidecar 返回） |
| -32012 | session 忙（上一个请求未完成，sidecar 返回） |

sidecar 级致命错误（不归属于某个会话）用 `session_id: "system"` 的 `agent/event` error 通知上报。

### 2.5 邮件收取（`mail/fetch`）

- 邮箱账号配置存放在 vault 的 `mail/accounts.json`（schema 见第 7 节），由 agent 用 `write_file` 工具按用户提供的 邮箱地址/授权码/IMAP 服务器 写入，或用户手工编辑。
- sidecar 收到 `mail/fetch` 后：读 `mail/accounts.json` → 逐账号走 IMAP 增量拉取 INBOX 新邮件 → 附件经 `vault/write_binary` 落盘到 `mail/<name>/attachments/<uid>/` → 每封邮件渲染为 Markdown 经 `vault/write_file` 落盘到 `mail/<name>/` → 回写 `accounts.json` 更新 `last_uid`。
- sidecar 收取时的所有 vault 读写操作审计 session_id 记为 `"mail"`。每封本地 Markdown 副本写入 `Folder` 元数据：默认收件箱为 `inbox`，非默认收件箱配置写为 `remote:<mailbox>`；前端以该字段和 `mail/index.json` 的 UI 状态索引合并判定唯一所属文件夹，避免同一副本被误显示到多个主文件夹。
- 单账号失败只在其结果项记 `error`，不中断其他账号；未配置邮箱（`mail/accounts.json` 不存在）返回 -32002。
- 收取过程通过 `mail/event` 通知上报 `connecting`、`connected`、`reading`、`saving`、`completed`、`error` 阶段；IMAP 连接和打开文件夹均有 30 秒超时，避免任务无限停留在执行中。
- sidecar 另注册 agent 工具 `fetch_mail`（params `{account?: string}`），与 `mail/fetch` 同一实现。该工具不属于 fs/bash 工具：网络仅访问配置中的 IMAP 服务器，落盘只经 `vault/*` RPC。
- 用户在前端确认“同步删除远端邮箱”后，Rust 转发 `mail/delete`；sidecar 使用邮件 UID 执行远端永久删除，多封邮件必须按 UID 串行发送删除指令。若服务器不支持 UIDPLUS，必须拒绝操作，避免普通 EXPUNGE 误删其他已标记邮件。
- `mail/list_mailboxes` 只读取远端文件夹元数据，不读正文；`mail/action` 支持远端已读/未读、星标、移动、归档和移入垃圾箱。每个 UID 单独发出 IMAP 指令，完成边界通过 `mail/action_event` 通知上报；归档/垃圾箱未指定目标时优先使用服务器 `SPECIAL-USE` 标记，找不到时回退到 `Archive`/`Trash`。
- 用户在写信窗口点击发送后，Rust 转发 `mail/send`；sidecar 使用当前账号配置的 SMTP（`smtp_host` 留空时由 `imap.*` 自动推断为 `smtp.*`）发送纯文本和可选 HTML 邮件。发送成功后前端在本地 `mail/<name>/sent-<epoch_ms>.md` 保存副本，并在 `mail/index.json` 标记为 `sent`；发送失败不删除草稿。
- 新邮件、回复、转发共用同一写信窗口，可选择多个附件；附件在发送前仅保留于当前界面，点击发送后才随 SMTP 请求发出。草稿或已发送副本会把附件写入 `mail/<name>/attachments/outgoing/<epoch_ms>/` 并在 Markdown 头部记录元数据。单个附件由前端限制为 32 MiB，单次总大小由 sidecar 限制为 64 MiB。
- 未安装/未运行的 sidecar 无法收邮件，Rust 按 sidecar 不可用错误透传。

### 2.6 日历中枢（`calendar/sync` / `calendar/push`）

- 日历连接配置存放在 vault 的 `calendar/accounts.json`，支持 Google Calendar、Microsoft Outlook、Apple/iCloud、ICS 订阅和 CalDAV 五类连接。
- `calendar/sync` 通过用户配置的 ICS/CalDAV endpoint 读取 VEVENT，将事件合并到本地 `calendar/events.json`；本地事件不会被远端导入覆盖。Apple/iCloud 账户若使用 `https://caldav.icloud.com/`，sidecar 会用 Basic Auth + 应用专用密码执行 `PROPFIND` principal/calendar-home 发现，再用 CalDAV `REPORT` 读取 VEVENT；`webcal://` 公开订阅会自动转为 HTTPS。
- `calendar/push` 只在用户新建日程时主动勾选“保存后立即同步”才调用。当前 CalDAV 连接支持通过 PUT 写回；Apple/iCloud CalDAV 读取使用应用专用密码，仍按只读处理；Google、Microsoft 连接在 OAuth 接通前按只读处理。
- 所有日历网络请求均由 sidecar 发起，Vault 读写使用 `session_id: "calendar"` 审计；浏览器预览不访问外部服务。

### 2.7 统一待办消息队列（`todo/list` / `todo/enqueue` / `todo/update`）

- 邮件、日历事件、Agent 和外部连接器都以 `TodoEnqueueInput` 发布消息；sidecar 的 TodoBus 将消息归一化为 `TodoItem`，写入 `todo/queue.json`。
- 四个泳道由 `lane` 表达：`backlog`（待办）、`now`（马上办）、`blocked`（等待中）、`done`（已办完）。重要/紧急矩阵由 `priority` 表达：`important_urgent`、`important_not_urgent`、`urgent_not_important`、`other`。
- `dedupeKey` 用于邮件 UID、日历事件 ID 等来源的幂等加入；重复发布不会产生第二条待办。
- `TodoBus.subscribe(name, hook)` 是 sidecar 内部的回调订阅接口。发布后由总线调用匹配的 hook，业务方不需要轮询或反向调用发布者（“you don't call me, I'll call you”）。
- 每次入队和更新都会发送 `todo/event` 通知，Rust 转发为 `todo://event`，前端据此刷新队列。

### 2.8 DeepSeek Harness 引擎

- Agent Team 可把 `SavedAgent.engine` 设为 `deepseek-harness`。sidecar 使用本机已安装的 `dsh --profile headless`（可通过 `DEPDEK_DSH_COMMAND` 指定路径）执行每轮文本请求；未设置时仍使用 Pi Agent Core，保证旧配置可继续运行。
- Harness 运行时使用 Node 子进程的临时工作目录、`DSH_PERMISSION_MODE=read-only` 和 `DSH_TELEMETRY_DISABLED=1`，并通过 patch 禁用 dsh 的本地文件、shell、web、sub-agent、workflow 等能力。它只能接收当前会话文本和有限历史，不会获得 DepDek Home 路径或 Vault RPC。
- DeepSeek Harness 当前是 developer preview 的 Cordis profile/插件运行时；它的 headless profile 是“一次任务后退出”，因此 DepDek 在 sidecar 内维护有限会话历史，再逐轮调用该 profile。Harness 不可执行或未配置时，前端显示明确错误，不会静默外发数据。

### 2.9 MyInfo / MyData 上下文

- 用户确认的稳定信息存放在 `myinfo/profile.json`；确认后的长期记忆以 JSONL 存放在 `mydata/long_term.jsonl`，均通过 Rust Vault 读写并审计。
- sidecar 每轮只组装有界的 confirmed 快照，不允许 Agent 自己遍历整个 Home。loopback 本地 provider（例如 Ollama）可默认使用快照；云端 Pi/Harness 默认不注入，必须由上层按当前请求单独取得外发确认。
- 快照包含来源引用，模型只能把它当作上下文，不能当作可执行指令。候选记忆必须在用户确认后才进入快照。

### 2.10 Agent Team 共享长期记忆

- 记忆事实源为 `<Home>/mydata/memory/events.jsonl`，使用追加事件记录 upsert、状态变化和撤销；索引是可重建派生物。
- 记忆范围为 `user`、`team`、`agent:<id>`、`session:<id>`。Pi 与 DeepSeek Harness 使用同一查询接口。
- Agent 只能调用 `memory/propose` 写入 `candidate`；只有用户侧确认调用才能变为 `confirmed`。凭据、token 和 `secret` 敏感级别不得进入记忆。
- 记忆查询结果必须带 `source_refs`、`scope`、`status`、`confidence` 和 `index_version`，用于上下文裁剪和 UI 来源回溯。
- 所有 `memory/*` 请求都带 `session_id`，由 Rust Vault 读写并产生审计记录；sidecar 不得直接打开 JSONL 或未来的 SQLite 索引。

| `memory/query` | `{session_id, query?, scopes?, statuses?, source_domains?, limit?, max_chars?}` | `{items: MemoryRecord[], total, index_version}` |
| `memory/get` | `{session_id, id}` | `{memory: MemoryRecord}` |
| `memory/propose` | `{session_id, text, kind?, scope?, source_refs?, sensitivity?, confidence?, engine?}` | `MemoryRecord`（固定为 `candidate`） |
| `memory/confirm` | `{session_id, id, text?, scope?}` | `MemoryRecord`（状态 `confirmed`） |
| `memory/reject` | `{session_id, id}` | `MemoryRecord`（状态 `rejected`） |
| `memory/tombstone` | `{session_id, id}` | `MemoryRecord`（状态 `tombstoned`） |
| `memory/stats` | `{session_id}` | `{total, by_status, by_scope, malformed_events, index_version}` |
| `memory/rebuild_index` | `{session_id}` | `{rebuilt, items, malformed_events, index_version}` |

```ts
type MemoryRecord = {
  id: string;
  scope: "user" | "team" | `agent:${string}` | `session:${string}`;
  kind: "fact" | "preference" | "constraint" | "procedure" | "episode" | "summary" | string;
  text: string;
  status: "candidate" | "confirmed" | "rejected" | "expired" | "tombstoned";
  sensitivity: "public" | "private" | "sensitive" | "secret" | string;
  confidence: number;
  source_refs: string[];
  created_by?: { type: "user" | "agent"; engine?: string; session_id: string };
  valid_from?: string;
  valid_until?: string;
  supersedes?: string;
  created_at: string;
  updated_at: string;
};

## 3. Tauri commands（前端 → Rust）

| command | 参数 | 返回 |
|---|---|---|
| `vault_set_root` | `{path: string}` | `string`（规范化后的根路径） |
| `vault_get_root` | — | `string \| null` |
| `vault_read_file` | `{path: string}` | `{content, size, sha256}` |
| `vault_write_file` | `{path: string, content: string}` | `{size, sha256}` |
| `vault_list_dir` | `{path: string}` | `{entries: [...]}` |
| `vault_search_files` | `{query: string}` | `{matches: [...]}` |
| `vault_delete_file` | `{path: string}` | — |
| `vault_compress` | `{path: string, archivePath?: string}` | `{source, archive, files, bytes, archive_size}` |
| `vault_read_binary` | `{path: string}` | `{data_base64, size, sha256, mime}` |
| `vault_write_binary` | `{path: string, dataBase64: string}` | `{size, sha256}`（前端显式保存邮件附件副本） |
| `obsidian_set_root` | `{path: string}` | `string`（规范化后的只读 Obsidian Vault 路径） |
| `obsidian_get_root` | — | `string \| null` |
| `obsidian_clear_root` | — | — |
| `obsidian_list_notes` | `{query?: string}` | `{notes: [{path, title, folder, size, modified_ms}]}`（最多 5000 篇 Markdown） |
| `obsidian_read_note` | `{path: string}` | `{path, content, size, sha256}`（只读 Markdown，单文件上限 10 MiB） |
| `audit_read` | `{offset?: number, limit?: number}` | `{entries: AuditEntry[], total: number}` |
| `memory_query` | `{query?, scopes?, statuses?, sourceDomains?, limit?, maxChars?}` | `{items: MemoryRecord[], total, index_version}` |
| `memory_get` | `{id: string}` | `{memory: MemoryRecord}` |
| `memory_propose` | `{text, kind?, scope?, sourceRefs?, sensitivity?, confidence?, engine?}` | `MemoryRecord`（candidate） |
| `memory_confirm` | `{id: string, text?, scope?}` | `MemoryRecord`（confirmed） |
| `memory_reject` | `{id: string}` | `MemoryRecord`（rejected） |
| `memory_tombstone` | `{id: string}` | `MemoryRecord`（tombstoned） |
| `memory_stats` | — | `{total, by_status, by_scope, malformed_events, index_version}` |
| `memory_rebuild_index` | — | `{rebuilt, items, malformed_events, index_version}` |
| `agent_create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string, engine?: AgentEngine}` | `{session_id}` |
| `agent_send` | `{session_id: string, text: string}` | — |
| `agent_analyze` | `{provider: ProviderConfig, text: string, systemPrompt: string, engine?: AgentEngine}` | `{text: string}`（转发 `agent/analyze`） |
| `agent_abort` | `{session_id: string}` | — |
| `agent_close` | `{session_id: string}` | — |
| `settings_get` | — | `Settings` |
| `settings_set` | `{settings: Settings}` | — |
| `mail_fetch` | `{account?: string, refreshBody?: boolean}` | `{fetched: number, accounts: [...]}`（同 `mail/fetch` result，转发 sidecar） |
| `mail_delete` | `{account: string, uids: number[]}` | `{account: string, deleted: number}`（转发 `mail/delete`） |
| `mail_list_mailboxes` | `{account: string}` | `{account: string, mailboxes: [...]}`（转发 `mail/list_mailboxes`） |
| `mail_action` | `{account: string, action: string, uids: number[], destination?: string, mailbox?: string}` | `{account: string, action: string, processed: number, destination?: string}`（转发 `mail/action`） |
| `mail_send` | `{account: string, to: string, cc?: string, bcc?: string, subject?: string, text: string, html?: string, attachments?: [...]}` | `{account: string, message_id: string}`（转发 `mail/send`） |
| `calendar_sync` | `{account?: string}` | `{imported: number, accounts: [...]}`（转发 `calendar/sync`） |
| `calendar_push` | `{account: string, event: CalendarEvent}` | `{account: string, event_id: string, remote_id: string}`（转发 `calendar/push`） |
| `todo_list` | — | `{version: 1, updatedAt: string, items: TodoItem[]}` |
| `todo_enqueue` | `{input: TodoEnqueueInput}` | `{item: TodoItem, duplicate?: boolean}` |
| `todo_update` | `{input: TodoUpdateInput}` | `{item: TodoItem}` |

```ts
type AuditEntry = {
  ts_ms: number;           // Unix 毫秒
  session_id: string;      // "user" 或 agent session id
  op: "read"|"write"|"list"|"search"|"delete"|"stat";
  path: string;            // 相对根路径
  ok: boolean;
  error?: string;
  sha256?: string;         // read/write 时记录
  size?: number;
};

type Settings = {
  last_root?: string | null;
  obsidian_root?: string | null; // 只读 Obsidian Vault 的规范化路径
  providers: Record<string, ProviderConfig>;  // key 为显示名
  agents?: SavedAgent[];                      // 已保存的 agent 会话配置，下次启动自动重建
};

type SavedAgent = {
  id: string;
  label: string;
  provider_name: string;       // 指向 providers 的 key
  system_prompt?: string;
  config_dir?: string;         // 本地 vault 中 agent.md/skill.md/mcp.md 所在目录
  engine?: AgentEngine;         // 缺省 pi，可选 deepseek-harness
};
```

所有 vault_* commands 与 sidecar 走**同一个 Vault 服务**，同样写审计日志（session_id="user"）。command 错误以字符串 message 返回（Tauri `Result<T, String>`），message 中包含错误码文本，如 `E32001 path escapes root`。

## 4. Tauri events（Rust → 前端）

| event | payload |
|---|---|
| `agent://event` | `{session_id, type, data}`（原样转发 sidecar 的 `agent/event`） |
| `vault://audit` | `AuditEntry`（每写一条审计记录即发一次，供审计查看器实时刷新） |
| `mail://event` | `{account, phase, message, current?, total?}`（原样转发 sidecar 的 `mail/event`，供收取任务展示进度） |
| `mail://action-event` | `{account, action, uid, current, total, message}`（原样转发 sidecar 的 `mail/action_event`，供远端批处理任务展示串行进度） |
| `todo://event` | `{type, item, emittedAt}`（原样转发 sidecar 的 `todo/event`） |

## 5. 审计日志

- 文件：`<数据文件夹根>/.vault-audit.jsonl`，append-only，每行一个 `AuditEntry` JSON。
- 该文件本身对所有 vault 操作不可见（`list_dir` 过滤，读写 `/.vault-audit.jsonl` 一律拒绝，错误码 -32001）。
- 换根后审计文件随新根创建；旧根的日志保留在原处。

## 6. 路径与安全规则（Rust 侧实现）

1. 收到相对路径 → 与 root 拼接 → 解析 `.`/`..` → 若任一级是 symlink，canonicalize 后必须仍以 canonicalized root 为前缀，否则 -32001。
2. 拒绝绝对路径与空路径。
3. 文本 read/write 单文件上限 10 MiB（-32003）；binary read/write 上限 64 MiB。
4. 文本接口仅处理 UTF-8（-32005）；二进制接口通过 base64 传输。
5. 每个 vault 操作无论成功失败都写审计。

## 7. 邮件存储约定

- 配置文件：`mail/accounts.json`，由 agent 按用户口述信息写入（或用户手工编辑）。

```ts
type MailAccountsFile = { accounts: MailAccount[] };

type MailAccount = {
  name: string;        // 显示名，同时用作邮件目录名（不得含 "/"）
  host: string;        // IMAP 服务器，如 imap.qq.com
  port?: number;       // 默认 993
  secure?: boolean;    // 默认 true（TLS）
  user: string;        // 邮箱地址
  password: string;    // 密码或客户端授权码（明文存于本地 vault，与 settings 中 API key 一致）
  mailbox?: string;    // 默认 "INBOX"
  last_uid?: number;   // 增量同步状态，由 sidecar 维护，用户/agent 勿改
  smtp_host?: string;  // SMTP 服务器；留空时由 IMAP host 自动推断
  smtp_port?: number;  // 默认 465
  smtp_secure?: boolean; // 默认 true；465 用 SSL，587 通常设为 false
};

type MailActionName = "mark_read" | "mark_unread" | "star" | "unstar" | "move" | "archive" | "trash";
```

- 邮件文件：`mail/<name>/<epoch_ms>-<uid>.md`，内容为头部（From/To/Date/Subject/UID/Read/Message-ID/In-Reply-To/References/附件元数据 JSON）+ `depdek:mail-html` 和/或 `depdek:mail-text` 标记包裹的正文。HTML 正文用于富文本展示，plain-text 用于预览和无 HTML 时的回退。IMAP `\\Seen` 标记会保存为 `Read`，让本地列表区分已读与未读；Message-ID/References 用于后续线程归并，不把线程关系交给模型推断。
- 邮件附件：`mail/<name>/attachments/<uid>/<序号>-<安全文件名>`；头部 `Attachments` 字段保存 `[{name,path,size,mime}]` JSON。sidecar 必须去除附件名中的路径和控制字符；每个附件经 `vault/write_binary` 单独写入并由 Rust 沙箱校验。旧版 `Attachments (not saved)` 头部仍可读，用户下次主动“收取邮件”时会回补可下载附件。
- `mail/fetch` 只增量拉取 `uid > last_uid` 的邮件，首次收取以当次拉到的邮件为准。

## 8. 日历存储约定

```ts
type CalendarAccountsFile = { accounts: CalendarAccount[] };
type CalendarAccount = {
  id: string; name: string;
  provider: "google"|"microsoft"|"apple"|"caldav"|"ics";
  endpoint?: string; write_endpoint?: string; calendar_id?: string;
  user?: string; password?: string; access_token?: string;
  enabled?: boolean; readonly?: boolean;
};
type CalendarEventsFile = { version: 1; updated_at: string; events: CalendarEvent[] };
type CalendarEvent = {
  id: string; remote_id?: string; source_account_id?: string; source_name?: string;
  title: string; start: string; end: string; all_day?: boolean;
  location?: string; description?: string; updated_at?: string;
};
type TodoLane = "backlog" | "now" | "blocked" | "done";
type TodoPriority = "important_urgent" | "important_not_urgent" | "urgent_not_important" | "other";
type TodoSourceType = "manual" | "mail" | "calendar" | "agent" | "external";
type TodoSource = { type: TodoSourceType; id?: string; label?: string; path?: string; remoteId?: string };
type TodoHookRef = { name: string; status: "pending" | "running" | "success" | "error"; message?: string; updatedAt?: string };
type TodoItem = {
  id: string; title: string; description?: string; lane: TodoLane; priority: TodoPriority;
  source: TodoSource; dueAt?: string; createdAt: string; updatedAt: string;
  tags?: string[]; dedupeKey?: string; hooks?: TodoHookRef[];
};
type TodoEnqueueInput = {
  title: string; description?: string; lane?: TodoLane; priority?: TodoPriority;
  source: TodoSource; dueAt?: string; tags?: string[]; dedupeKey?: string; hooks?: string[];
};
type TodoUpdateInput = {
  id: string; title?: string; description?: string; lane?: TodoLane;
  priority?: TodoPriority; dueAt?: string; tags?: string[];
};
type TodoQueueFile = { version: 1; updatedAt: string; items: TodoItem[] };
```

`calendar/events.json` 是本地中枢的当前聚合视图；事件先落本地，外部写回永远是显式动作。连接凭据仍属于 V0.2 明文兼容债务，后续迁移到 Credential Broker/OS Keychain。

`todo/queue.json` 是待办中枢的当前队列；来源记录不覆盖原始邮件或日历事件，移动泳道只更新待办本身。
