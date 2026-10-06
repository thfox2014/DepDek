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
| `agent/create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string, engine?: "pi"\|"deepseek-harness", enabled_skills?: AgentSkill[]}` | `{session_id}` |
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
| `message_complete` | `{stop_reason: string, engine?: AgentEngine, usage?: {input: number, output: number, total: number}}`（仅在引擎返回真实 usage 时提供） |
| `error` | `{message: string, engine?: AgentEngine}` |

### 2.3 sidecar → Rust：`vault/*` 请求

所有方法 params 均含 `session_id`（用于审计归属，前端用户操作记为 `"user"`）。`path` 一律为**相对数据文件夹根**的 POSIX 风格相对路径（`.` 表示根）。

**凭据保护（按 session）**：trusted session 集合为 `"user" | "mail" | "calendar" | "settings"`；agent session（其余任何 id）对受保护路径（`tasks/history.json`、`mail/accounts.json`、`calendar/accounts.json`、`settings/settings.json`，以及 `secrets/` 整棵子树——`master.key` 与所有 `<scope>.enc.json` 密文 blob）的全部操作（read/write/binary/list/search/stat/delete/compress）一律拒绝 -32001，且这些文件与目录对 agent 的目录列举和全文搜索不可见、目录压缩时被排除。trusted session 不受此限制。`myinfo/profile.json`（agent 上下文有意读取的用户自述）与 `todo/queue.json`（sidecar 以 TODO_SESSION_ID 维护）不在此列。会话历史位于 `agent/<id>/conversations.json`（Vault 明文，见 6.2），是 agent 自身会话的可读写文件，不在保护名单内。

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

`vault/compress` 是唯一的内置压缩动作：在数据文件夹内生成 `.tar.gz`，跳过符号链接和审计文件，最多处理 10,000 个文件、512 MiB 未压缩内容；不调用 shell，审计为 `op: "write"`。agent session 的压缩会额外排除受保护凭据文件（见 2.3 凭据保护）。sidecar 将其注册为 `compress` 工具，前端输入 `/compress <相对路径>` 时直接走同一 RPC。

sidecar 另注册 `propose_memory` 工具（必须提供 `source_refs`），它只调用
`memory/propose` 写入候选，不会直接改变 Agent 上下文；确认动作只能由用户界面执行。

### 2.4 错误码（Rust 返回）

| code | 含义 |
|---|---|
| -32001 | 路径越出数据文件夹根（含 `..`、绝对路径、逃逸 symlink），或 agent session 触碰受保护凭据文件 / `secrets/` 加密子树 |
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

- 邮箱账号配置存放在 vault 的 `mail/accounts.json`（schema 见第 7 节）。该文件属于受保护路径（2.3 凭据保护）：由用户在 Settings UI 中管理（或手工编辑文件），sidecar 以 `session_id: "mail"` 读写；agent 工具无法读取或写入任何受保护文件，避免凭据进入模型上下文。
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
| `vault_init_home` | — | `string`（创建并设置当前用户 `~/DepDek-Home`；目录操作由 Rust 执行） |
| `storage_summary` | — | `{sampled_at_ms, volumes: [{name, file_system, mount_point, kind, removable, total_bytes, available_bytes, used_bytes, used_pct}]}`（本机挂载卷只读容量信息；不遍历文件、不执行磁盘写入） |
| `voice_transcribe` | `{audioBase64: string}` | `string`（本地 Vosk 中文识别文本；不保存录音、不联网） |
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
| `agent_create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string, engine?: AgentEngine, enabled_skills?: AgentSkill[]}` | `{session_id}` |
| `agent_send` | `{session_id: string, text: string}` | — |
| `agent_analyze` | `{provider: ProviderConfig, text: string, systemPrompt: string, engine?: AgentEngine}` | `{text: string}`（转发 `agent/analyze`） |
| `agent_abort` | `{session_id: string}` | — |
| `agent_close` | `{session_id: string}` | — |
| `settings_get` | — | `Settings` |
| `settings_set` | `{settings: Settings}` | —（迁移：新写入的明文 provider api_key 自动加密到 `secrets/providers.enc.json` 并落为 `$secret:` 引用，见 6.1） |
| `credentials_set` | `{scope: string, key: string, value: string}` | —（value 为空字符串时删除该条目） |
| `credentials_has` | `{scope: string, key: string}` | `boolean`（scope/key 是否存在密文条目，供 Settings UI 判断“已加密”） |
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

`voice_transcribe` 仅接收前端生成的 16 kHz、单声道、16-bit PCM WAV，录音最多 30 秒。Rust 校验 WAV 头和大小后将内存中的数据经 stdin 交给系统预装的本地 Vosk 运行时，UI 必须由用户点击麦克风后才能录音，识别结果先回填输入框供用户检查；识别不自动发送给模型。此接口不访问 Vault，也不开放文件或命令执行能力。

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
  enabled_skills?: AgentSkill[]; // 由 sidecar 按能力组筛选 Vault 工具；缺省值用于旧配置兼容
};

type AgentSkill = "documents" | "photos" | "music" | "videos" | "mail" | "memory";
```

`enabled_skills` is enforced by the sidecar as an allow-list over built-in tools: `documents` grants read/list/search/write/compress; `photos`, `music`, and `videos` grant `search_media`/`open_media` restricted to that media kind; `mail` grants configured IMAP fetch; `memory` grants source-backed memory proposals. An explicit empty array grants no tools. Omitted values are interpreted as legacy configuration for backward compatibility. Media bytes are read only through `vault/read_binary`; the UI playback read is separately audited by Rust. The current MCP editor stores explanatory `mcp.md` text only and does not launch arbitrary MCP servers.

所有 vault_* commands 与 sidecar 走**同一个 Vault 服务**，同样写审计日志（session_id="user"）。command 错误以字符串 message 返回（Tauri `Result<T, String>`），message 中包含错误码文本，如 `E32001 path escapes root`。

### 3.1 Linux depdek-space 服务（首期）

depdek-space 是独立于 Tauri 桌面进程的 Linux 逻辑存储服务，不改变现有 storage_summary 行为。首期二进制位于 space-service/，可通过 systemd user service 常驻运行。

- 资源类型：hot（高速本地）、durable（本地长期）、cloud（云资源登记）。
- 用户对象地址：逻辑 space_id/key，不暴露物理资源路径。
- 首期真实读写：hot 和 durable；cloud 仅登记、保存 endpoint/bucket 并做健康检查。
- 状态文件：服务 root 下的 state.json；对象数据以 SHA-256 内容地址保存到资源目录的隐藏 .depdek-space/objects/。
- 服务 socket：Unix socket，一行一个 JSON-RPC 2.0 请求，默认权限 0600。

首期方法：

| method | params | 说明 |
|---|---|---|
| space/init | {} | 初始化服务状态 |
| space/resource/add | ResourceAddArgs | 登记 hot/durable/cloud 资源 |
| space/resource/list | {} | 列出资源 |
| space/space/create | {name, primary_class} | 创建逻辑空间 |
| space/space/list | {} | 列出逻辑空间 |
| space/object/put | {space_id, key, file} | 写入本地对象并生成版本 |
| space/object/get | {space_id, key, output} | 读取最新版本 |
| space/object/list | {space_id} | 列出逻辑对象 |
| space/summary | {} | 服务摘要 |
| space/health | {} | 资源健康状态 |

CLI 可以在没有 daemon 时直接操作同一状态；指定 --socket 后改为通过常驻服务操作。该服务不获得 Agent 的任意 fs/bash 权限，后续接入 Agent 时仍需通过受控的 space/* capability。

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
6. 凭据保护名单：`tasks/history.json`、`mail/accounts.json`、`calendar/accounts.json`、`settings/settings.json` 及 `secrets/` 子树（master key + 密文 blob）仅对 trusted session（`user`/`mail`/`calendar`/`settings`）开放；agent session 对名单内路径的任何操作返回 -32001 并照常审计，名单内文件同时从目录列举、内容搜索和 agent 压缩中排除。`myinfo/profile.json`（agent 上下文有意读取）与 `todo/queue.json`（sidecar 自管）不在名单内。

### 6.1 凭据加密存储（P1，Rust 与 Node 同一格式）

- 明文不再写入配置。`secrets/` 目录存放：`master.key`（32 字节随机，Unix 权限 0600）+ 每个 scope 一个 `secrets/<scope>.enc.json` 密文 blob。
- blob 格式：`{version: 1, entries: { "<key>": "<b64(nonce(12) || ciphertext || tag(16))>" }}`，AES-256-GCM，nonce 每次随机。桌面端 Rust `credentials.rs`、浏览器预览 Node `sidecar/src/credentials.ts`、迁移脚本 `scripts/migrate-credentials.mjs` 共用完全相同的格式，可互相解密。
- 配置中的引用格式为 `$secret:<scope>.<key>`；`********` 仍是脱敏占位符（读写回环保留旧值）。读取时遇到 `$secret:` 引用在内存中解密使用，不写回配置文件，因此引用在磁盘上持续保持。
- scope/key 约定：`mail`（`<name>.password`）、`calendar`（`<id>.password` / `<id>.access_token`）、`providers`（`<name>.api_key`，对应 settings/providers）。
- 旧明文兼容：`mail/accounts.json`、`calendar/accounts.json`、`settings/settings.json` 中遗留的明文密码 / api_key 读取时仍可用（fallback），仅新写入时加密；`node scripts/migrate-credentials.mjs --root <Home>` 可将现存明文一次性迁移为 `$secret:` 引用（幂等：先写密文再写回配置，写回失败保留明文并告警）。
- 写入路径：桌面 `settings_set` 与 HTTP `PUT /v1/settings` 收到非占位符、非引用的新明文 api_key 时自动加密；Settings UI 亦可用 `credentials_set`/`credentials_has` 直接管理密文条目。

### 6.2 会话历史持久化（P1）

- 会话历史文件为 `<Home>/agent/<id>/conversations.json`（Vault 明文，README 附带的压缩/搜索/备份等既有能力直接生效），仅用户界面与 Rust 通过 `vault_read_file`/`vault_write_file` 读写；浏览器预览经 `GET/PUT /v1/vault/read|write`（仅限该路径模式，见第 9 节）。
- 前端启动时先尝试从该文件引导历史（bootstrap），后续变更以 800ms 节流后台落盘；localStorage 降级为崩溃缓存（仅在 Vault 不可用时兜底，且能恢复时同步回 Vault），不再是会话历史的权威存储。

## 7. 邮件存储约定

- 配置文件：`mail/accounts.json`，仅由用户在 Settings UI 管理（或手工编辑），sidecar 内部以 `session_id: "mail"` 读写；agent 工具不能访问该文件（凭据保护，见 2.3）。

```ts
type MailAccountsFile = { accounts: MailAccount[] };

type MailAccount = {
  name: string;        // 显示名，同时用作邮件目录名（不得含 "/"）
  host: string;        // IMAP 服务器，如 imap.qq.com
  port?: number;       // 默认 993
  secure?: boolean;    // 默认 true（TLS）
  user: string;        // 邮箱地址
  password: string;    // 密码或客户端授权码；P1 起为 `$secret:mail.<name>.password` 引用（密文存 `secrets/mail.enc.json`），旧明文仍可读（兼容回退），新写入一律加密
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

`calendar/accounts.json` 的 `password`/`access_token` 自 P1 起为 `$secret:calendar.<id>.password` / `$secret:calendar.<id>.access_token` 引用（密文存 `secrets/calendar.enc.json`），旧明文仍可读（兼容回退），新写入一律加密。`calendar/events.json` 是本地中枢的当前聚合视图；事件先落本地，外部写回永远是显式动作。

`todo/queue.json` 是待办中枢的当前队列；来源记录不覆盖原始邮件或日历事件，移动泳道只更新待办本身。

## 9. AgentOS R1 本地只读服务（增量入口）

`services/depdekd` 复用本 crate（禁用 tauri-app）中的 Vault，新增本机 Unix socket 的版本化 JSON-RPC 入口；它不是新的 sidecar 方法，不改变 §2–§8 的旧接口或 ID 空间。桌面与 sidecar 保持旧调用，Webdesk 本批尚未接入。

- 第一批实现 `v2/health`、`v2/commands.list` 和 `v2/command.invoke`；文件命令为 `file.list/read/stat@1.0`，只查询启动配置登记的目录。实际协议与启动说明见 [R1 本地服务契约](agentos-v2/runtime-r1.md)。第二批可选本机凭据入口见 §10；其它 V2 API/Plan/Job 未实现。
- 身份来自 Unix peer uid，只有与 daemon 相同的非 root OS 用户可连接；principal 由服务生成，JSON 不能声明 actor/role/session_id。当前仅支持单用户本机，只读入口不能被当作家庭多用户认证或浏览器委托。
- 数据权限、路径、受管资产过滤全部在 `vault.rs::ManagedReadVault`；新服务不得直接打开数据文件。登记目录必须明确指定，不允许整个根。隐藏路径、现有凭据/记忆/策略等内部目录、数据库文件、symlink 和硬链接文件不通过新入口暴露。
- Linux/macOS 下通过根目录 fd 和逐级 `openat(O_NOFOLLOW)` 读取；目录列表在返回前过滤不可见项，文本实际读取上限 128 KiB，目录扫描/输出有上限。
- 每次受管文件查询成功或拒绝均持久写审计（沿用 AuditEntry，session_id 带服务生成的 principal/request_id）。写入/同步失败时不返回数据，错误 `AUDIT_UNAVAILABLE`；重启时损坏的最后一条日志拒绝接续，不自动修复/删证据；旧入口的审计行为暂不改变。
- 本批无业务写操作、无数据迁移、无模型外发，不形成第二个领域主写者。不要将 R1 只读切片宣称为完整 V2 服务；可信多用户委托、完整 Secret Broker 与主写切换另行验收。

## 10. AgentOS R1 第二批：可选本机 Secret Store

增量实现 `services/depdekd` 的专用凭据管理入口；不注册为 Agent 工具，不改变旧 ProviderConfig、§7 邮件/§8 日历或 Webdesk 接口。`secret_dir` 为可选启动配置，默认禁用，必须为数据根之外的独立私有目录。实际协议见 [第二批运行时契约](agentos-v2/runtime-r1-secrets.md)。

- 本机 owner 身份与 workspace 规则沿用 §9，不接受 JSON 自填角色。路径/目录/文件权限、nofollow、硬链接、独占锁和原子落盘检查仍集中 `vault.rs`。
- Secret Store 使用 Argon2id 派生内存密钥与 XChaCha20-Poly1305 加密；没有硬编码主密码、磁盘明文主密钥或自动解锁。重启为锁定态，空闲超时清除内存状态；当前不是平台 Keychain/TPM 或无人值守解锁方案。
- `v2/credentials.status/init/unlock/lock/list/put/revoke/receipt/import.preview/import.apply` 为专用方法；秘密只作为请求输入，不提供 get/export/租约取值接口。响应、审计、错误只含允许的元数据，不含 key/password/token/主密码或其摘要。
- put/revoke 使用 operation_id 与 expected_revision，拒绝覆盖冲突；幂等回执与秘密同一加密快照原子提交。持久化不确定或后续审计失败不宣称成功，锁定后通过重启/解锁/回执查证，禁止盲目生成新 operation_id 重试。
- 显式导入只接收有界、调用者主动提供的旧配置 JSON，支持预览与整批冲突拒绝。只暂存凭据与绑定映射，源不修改、不删除、不自动启用模型；真实旧配置迁移、备份、Worker 租约与客户端 Adapter 尚未切换，明文兼容债务仍存在。
- CLI 的敏感输入使用无回显 TTY 或显式 stdin JSON，不允许把秘密放在 --input/argv/环境变量。服务只支持私有 Unix socket；可信浏览器委托与家庭多用户 ACL 仍待实现，不开放网络管理。

## 11. AgentOS R1 第三批：独立业务会话与目录授权

增量提供单工作空间内的显式业务用户注册（受信启动配置）、密码认证、短期不透明会话、会话撤销和目录范围查询；不把 Webdesk admin 或服务 Unix uid 当作终端业务用户。具体接口见 `agentos-v2/runtime-r1-access.md`。

- 业务用户、密码 PHC 与可读目录由可信操作员在启动配置 `access_users` 登记，默认空/禁用。无默认业务密码、不通过请求体设角色。注册/密码参数约束、目录范围检查、会话签发/检验/撤销、文件返回前重验均在 `vault.rs` 及其内部 access 模块。
- `v2/auth.login/session/logout` 与 `v2/delegated.workspaces/commands/invoke` 为固定方法。业务会话只能读本人登记的目录、只能调用三个 file 查询命令；不能管理凭据或读取普通本机 owner 命令。RPC 的 Unix peer 校验仍必需，会话 token 仅证明注册业务用户。
- Webdesk 为可选 BFF，只代理这六类固定方法；通过独立 HttpOnly/SameSite cookie 持有会话，POST 校验精确 Origin 与 CSRF。BFF 不读 Home、秘密、配置或业务文件，不提供任意 RPC/shell 转发；接口独立登记在 webdesk-design.md。
- 会话有绝对/空闲超时、容量、登录冷却，重启失效；logout 撤销后不能继续查询。查询授权锁覆盖读取和严格审计，返回前重验期限。目录 ACL 不是对象级 ACL、持久 membership 或多 workspace 注册；修改成员/目录需受控重启。
- 不自动开启网络或改现有登录/文件/Agent 界面；无认证模式拒绝新业务代理入口。旧 Provider、租约、客户端主写切换和真实迁移仍待后续发布门，不因本批新增会话而开放模型或业务写入。
## 12. AgentOS R1 第四批：Worker 文件委托与控制 Profile

`depdekd` 增量提供 `v2/delegated.worker.issue/revoke` 与 `v2/worker.invoke`：业务 session + CSRF 签发短期、目录子集、次数受限的 file-query bearer；Worker 不持用户 session/CSRF/密码或 API Key。签发/撤销、scope 检查、调用预算和返回前复验均在 Vault 内，注销/过期/重启失效，审计失败不放行。该通道不注册到旧 sidecar，不改变桌面/React 旧接口或 ID 空间。

可选可信启动 `provider_profiles` 只登记凭据引用，owner-only `v2/providers.list` 检查 Secret Store 的脱敏元数据、用途/revision/锁定/撤销。没有明文 getter、Credential Lease、模型外发或客户端切换。实际协议与预算见 [第四批运行时契约](agentos-v2/runtime-r1-workers.md)。本机同 uid 不等于生产 Worker 隔离。

## 13. AgentOS R1 第五批：受限进程通道与一次性本机模型出口

可选 `worker_transport` 为 Linux 独立 uid 提供单独 Unix listener，仅接受 `v2/worker.invoke` 和 `v2/model.invoke`；owner 控制 socket 不接受 Worker uid。目录/凭据/授权仍由 Vault 控制，Worker 不获得 Home、Secret Store 或管理 RPC。实际配置与验收见 [第五批契约](agentos-v2/runtime-r1-gateway.md)。此增量不修改旧 Tauri/sidecar/React/Webdesk 接口，也不自动接入已有 Pi/Harness。

默认关闭的 `local_model_profiles` 只允许明确登记、数值回环 HTTP `/v1` Profile，用于本机模型/合成 Provider 验收，不支持云端或 DNS endpoint。业务 session + CSRF 显式调用 `v2/delegated.model.issue`，把单次 prompt、Provider/Profile revision、输出预算和 TTL 绑定到不可扩大的 bearer；`revoke`/logout/过期/重启使其失效。`v2/model.invoke` 只接收 bearer/workspace/run/call_id，不接收 prompt、Key、endpoint、工具或 messages。

API Key 仅由 core 内部限定用途回调使用，仍无 getter/export；密钥库锁覆盖有界请求，轮换/撤销等待当前请求排空后生效。意图先持久审计再外发，失败/超时不自动重试；任何已尝试的授权均被消费。返回只解析选定文本和合法 usage，禁止回显当前 Key；服务返回前复核用户/授权期限。该单次开发出口不是持久 Job/外部行动回执、远程 TLS Gateway 或完整生产沙箱。

## 14. 浏览器预览 HTTP 服务（standalone sidecar）

浏览器无法调用 Tauri commands，standalone sidecar 提供一个最小 HTTP API（仅绑定 `127.0.0.1`）承载浏览器预览；所有读写都经 `vault/*`（settings 落盘在数据文件夹内，不进入浏览器存储）：

| 路由 | 说明 | 鉴权 |
|---|---|---|
| `GET /v1/health` | `{ok: true}` | 无 |
| `GET /v1/settings` | 当前 Settings；返回前所有 provider 的 `api_key` 脱敏为 `********` | `x-depdek-token` |
| `PUT /v1/settings` | 补丁合并：`********`/空/缺失的 `api_key` 保留旧值，其余字段覆盖，`agents` 数组整体替换；字段值为非占位符的新明文 api_key 时自动加密到 `secrets/providers.enc.json` 并落为 `$secret:providers.<name>.api_key` 引用 | `x-depdek-token` |
| `GET /v1/vault/read?path=...` | 读取会话历史：`path` 必须匹配 `agent/<id>/conversations.json`，返回 `{content: string, size: number}`；文件不存在返回 `{error: "not found"}`（404） | `x-depdek-token` |
| `PUT /v1/vault/write` | 写入会话历史：body `{path, content}`，同样仅限 `agent/<id>/conversations.json` 模式；返回 `{size: number, sha256: string}` | `x-depdek-token` |

安全模型：

1. 服务只监听 `127.0.0.1`。
2. CORS 只对 `http://localhost:1420`（Vite dev origin）放行；其余 origin 不返回 `access-control-allow-origin`，浏览器会阻断响应读取。
3. 每次启动生成随机 per-launch token（`randomBytes(24).toString("hex")`），settings 与会话历史（vault）读写必须携带 `x-depdek-token`（恒定时间比较），缺失或错误返回 401。
4. token 由 `scripts/dev-preview.mjs` 从 sidecar stderr 捕获并写入 `.preview-token`（0600），Vite proxy 在转发 `/v1/*` 时注入该请求头；浏览器 JS 永远接触不到 token。
