# Agent Workbench 接口契约 v1

可选浏览器电脑、业务授权、Room 动作协议及返回扩展见 [runtime-computer.md](agentos-v2/runtime-computer.md)。桌面旧接口不变；Node SDK 不获得 shell/fs/Docker 工具。

管理员固定短句 Provider 测试与安全错误分类见 [runtime-room.md](agentos-v2/runtime-room.md)；不能用 admin 身份执行任意业务 prompt 或读取私人材料。

可选 R1 Room 控制/业务接口、家庭原件与断言快照以及云端出口扩展，见 [runtime-room.md](agentos-v2/runtime-room.md)。新 sidecar SDK Worker 沿用 engine-bound exact-input；旧桌面兼容 writer 不因该接口自动迁移。

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
| `agent/create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string, engine?: "pi"\|"deepseek-harness", enabled_skills?: AgentSkill[], label?: string, config_dir?: string, mcp_grants?: string[]}` | `{session_id}` |
| `agent/send` | `{session_id: string, text: string}` | `{}`（回复经 `agent/event` 流式下发） |
| `agent/analyze` | `{provider: ProviderConfig, text: string, system_prompt: string, engine?: "pi"\|"deepseek-harness"}` | `{text: string}`（一次性只读分析；不创建持久会话，不暴露写入/删除/外部调用工具） |
| `content/analyze` | `{provider: ProviderConfig, category: "photos"\|"videos"\|"documents", evidence: {text, images: [{data,mimeType,label}], coverage}}` | 结构化描述/标签/观察/不确定项及 total_tokens；单次无工具、无个人上下文，60 秒，详见 [内容分析契约](ai-content-agent.md) |
| `agent/abort` | `{session_id: string}` | `{}` |
| `agent/close_session` | `{session_id: string}` | `{}` |
| `team/list` | `{}` | `{tasks: TeamTask[]}`（持久化在 `team/tasks.json`，sidecar 重启后恢复；见 2.11） |
| `team/cancel` | `{task_id: string}` | `{task: TeamTask}`（未知 id 返回 -32013；已结束的任务原样返回） |
| `team/roster` | `{agents: [{id: string, label: string}]}` | `{updated: number}`（只更新已存在会话的显示名） |
| `team/policy_get` | `{}` | `{policy: TeamPolicy}` |
| `team/policy_set` | `{policy: TeamPolicy}` | `{policy: TeamPolicy}` |
| `approval/list` | `{}` | `{cards: ApprovalCard[]}` |
| `approval/decide` | `{id: string, decision: "approve"\|"deny"}` | `{card: ApprovalCard}`（未知 id 返回 -32014） |
| `schedule/list` | `{}` | `{routines: Routine[]}` |
| `schedule/put` | `{routine: Routine}` | `{routine: Routine}` |
| `schedule/delete` | `{id: string}` | `{deleted: boolean}` |
| `mcp/connectors_get` | `{}` | `{connectors: McpConnector[]}`（不含令牌） |
| `mcp/connector_put` | `{connector: McpConnector}` | `{connector: McpConnector}` |
| `mcp/connector_delete` | `{id: string}` | `{deleted: boolean}` |
| `mcp/oauth_store` | `{connector_id, access_token?, refresh_token?, token_url?, client_id?, client_secret?, token?}` | `{connector_id, stored: string[]}`（只返回写入了哪些字段名） |
| `mcp/oauth_status` | `{connector_id}` | `{connector_id, has_access_token, has_refresh_token, has_bearer_token, has_client_id}` |
| `mcp/list_tools` | `{connector_id}` | `{connector_id, tools: [{name, description}]}`（用户发起的发现，不是 Agent 工具） |
| `mcp/reload` | `{session_id}` | `{grants: string[]}`（按 mcp.md 重新挂载该会话的 MCP 工具） |
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

**凭据保护（按 session）**：trusted session 集合为 `"user" | "mail" | "calendar" | "settings" | "team" | "mcp" | "schedule"`。后三个只由 sidecar 的团队、MCP 和调度模块使用，Agent 工具不能自行选择 session id。agent session（其余任何 id）对受保护路径（`tasks/history.json`、`mail/accounts.json`、`calendar/accounts.json`、`settings/settings.json`、`team/tasks.json`、`team/policy.json`、`mcp/connectors.json`、`schedule/routines.json`、`mail/outgoing-drafts.json`，以及 `secrets/` 整棵子树——`master.key` 与所有 `<scope>.enc.json` 密文 blob）的全部操作（read/write/binary/list/search/stat/delete/compress）一律拒绝 -32001，且这些文件与目录对 agent 的目录列举和全文搜索不可见、目录压缩时被排除。trusted session 不受此限制。`myinfo/profile.json`（agent 上下文有意读取的用户自述）与 `todo/queue.json`（sidecar 以 TODO_SESSION_ID 维护）不在此列。会话历史位于 `agent/<id>/conversations.json`（Vault 明文，见 6.2），是 agent 自身会话的可读写文件，不在保护名单内。

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
| -32006 | AI-OS 本机空间尚未登录或已锁定 |
| -32601 | 未知方法 |
| -32010 | session id 重复（sidecar 返回） |
| -32011 | 未知 session（sidecar 返回） |
| -32012 | session 忙（上一个请求未完成，sidecar 返回） |
| -32013 | 未知的团队协作任务（`team/cancel`，sidecar 返回） |
| -32014 | 未知的审批卡（`approval/decide`，sidecar 返回） |

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
```

### 2.11 Agent 团队协作（委托与互发消息）

Pi 会话在原有技能工具之外，额外拥有三个协作工具：`list_teammates`、`delegate_task`、`send_agent_message`。它们**不**属于 `enabled_skills` 白名单，也**不**增加 shell 或任意文件系统能力。被委托的会话只使用它自己已经启用的工具；DeepSeek Harness 会话没有这些工具，但可以被委托（只做文本回合）。只读 `agent/analyze` 不注册协作工具。

- `delegate_task` 立即返回任务 id，发起方继续当前对话。任务在目标会话空闲后异步执行。
- `send_agent_message` 走同一条队列，区别只是提示词把内容当作消息而不是待办工作。
- 状态：`queued` → `running` → `done` | `failed` | `cancelled`。每次变化发 `team/event`，Rust 转发为 `team://event`。
- 结束后把一段结果提示送回发起方会话（该回合 `origin=result`，协作工具会拒绝再次委托，避免结果回传把环重新打开）。
- 循环防护：深度上限 3；链上已出现的 session 不能再次成为目标；不能委托给自己；每个发起方同时最多 4 个未完成任务，全局最多 16 个；相同发起方、目标和正文视为重复，不新建任务。委托正文上限 4000 字符，消息上限 2000 字符。
- 用户从团队面板调用 `team/cancel`。排队中的任务直接取消；执行中的任务只中止这次协作回合，不把用户自己的对话误停掉。
- 目标必须已经有会话。未启动的 Agent 不会被自动创建。目标暂时不在线时任务保持 `queued`，直到会话出现或被关闭；关闭会话仍会取消指向它的排队任务。
- 委托策略见 `team/policy.json`（受保护文件，session id `team`）。`mode: "allow"` 时默认允许，`mode: "deny"` 时默认拒绝。规则 `{from, to, allow}` 用 session id、显示名或 `*` 匹配；更具体的一端优先（id 高于显示名，高于 `*`），同样具体时以后写的规则为准。策略同时约束 `delegate_task` 和 `send_agent_message`。文件缺失时按允许处理，以保持旧配置可运行。
- 队列持久化在受保护文件 `team/tasks.json`。sidecar 重启后恢复未结束任务：`running` 改回 `queued` 再执行一次（副作用可能重复，这是重启恢复的边界）。`pending_delivery: true` 的已结束任务会再次把结果送回发起方。审计日志仍然是追加的轨迹，不是队列本身。
- 每次接受、拒绝和状态变化都由 sidecar 调用 Rust `team/audit`。Rust 追加一条 `op: "team"` 的审计记录，`path` 为逻辑主体 `team/<task_id>/<kind>/<status>/<peer>`，不是数据文件夹里的文件。`task_id` 必须匹配 `tsk_` + 8–32 位十六进制；session id 只允许 `A-Za-z0-9_.:-`，避免把审计路径写成逃逸路径。审计失败不阻断协作。

```ts
type TeamTask = {
  id: string;
  kind: "delegate" | "message";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
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
};

type TeamPolicy = {
  version: 1;
  mode: "allow" | "deny";
  rules: Array<{ from: string; to: string; allow: boolean }>;
};
```

`agent/create_session` 可额外带 `label`，供名称解析。前端在会话或显示名变化时调用 `team/roster` 刷新标签。名称解析先精确匹配 session id，再按显示名大小写不敏感匹配；重名则拒绝并要求改用 id。`config_dir` 指向该 Agent 的 `mcp.md`，授权规则见 2.12。

### 2.12 MCP 连接器（HTTP）

sidecar 内置 MCP 客户端，只使用 HTTP JSON-RPC（`initialize`、`notifications/initialized`、`tools/list`、`tools/call`）。不启动进程，不接受命令行，不把 stdio MCP server 当作连接器。

- 连接器清单在受保护文件 `mcp/connectors.json`：`{id, label, url, auth}`。`url` 只能是不带 userinfo 的 `http:` 或 `https:`。`auth` 为 `none`、`bearer` 或 `oauth`。
- 令牌放在现有加密凭据里，scope 为 `mcp`，键为 `<id>.token`、`<id>.access_token`、`<id>.refresh_token`、`<id>.token_url`、`<id>.client_id`、`<id>.client_secret`。`mcp/oauth_store` 与 `mcp/oauth_status` 只写或报告有无，响应、审计和 UI 都不回显令牌。刷新只在 HTTP 401 时尝试一次。
- 授权来自 Agent 配置目录里的 `mcp.md`。只有整行匹配 `连接器/工具`（各段 1–64 位字母数字、`_` 或 `-`）才是授权；标题和说明文字不会变成工具。`agent/create_session` 若同时给出 `config_dir` 和 `mcp_grants`，生效集合是二者的交集；只有文件时用文件；没有 `config_dir` 时才用参数。空文件表示没有 MCP 工具。
- 注册到 Pi 会话的工具名是 `mcp__<connector>__<tool>`。调用前再次核对授权，未授权或连接器不存在时不发网络请求。通过后先走审批卡（2.13），用户批准才 `tools/call`。
- 每次尝试由 sidecar 调用 Rust `mcp/audit`，`op: "mcp"`，逻辑路径 `mcp/<connector>/<tool>/<ok|denied|error>`。`mcp/list_tools` 是用户按钮触发的发现，不是 Agent 工具。
- 只读分析（`agent/analyze`）不注册这些工具。DeepSeek Harness 会话同样不注册。

### 2.13 审批与邮件草稿

写入和外部动作在真正执行前要等用户批准。卡片经 `approval/event` 推到前端，Rust 转发为 `approval://event`。

- 需要批准的内置动作：`write_file`、`delete_file`、`compress`（kind `write`），`fetch_mail` 和已授权的 MCP 调用（kind `external`）。读文件、列目录、搜索和记忆提案不拦截。
- Agent 不能直接发 SMTP。邮件技能额外提供 `draft_email`，它把草稿写入受保护的 `mail/outgoing-drafts.json` 并打开 kind `email` 的卡片。用户批准后才调用既有 `mail/send`。用户自己在写信窗口点发送，仍走原来的 `mail/send`，那是用户动作，不是 Agent 工具。
- `approval/decide` 的 `approve` / `deny` 会结束等待。10 分钟没有决定则记为 `expired`，邮件不发送。sidecar 重启后，仍为 pending 的邮件草稿会重新出现在卡片里；此时没有存活的工具等待者，由用户批准直接发送。同一次批准只发送一次。
- 卡片预览会截断正文，并隐藏字段名像 token、password、secret、authorization、api_key 的值。
- 每次决定调用 Rust `approval/audit`，`op: "approval"`，逻辑路径 `approval/<apr_id>/<kind>/<pending|approved|denied|expired>`。

### 2.14 例程调度

例程存在受保护文件 `schedule/routines.json`，由团队页面管理。

- 触发器二选一：五段 cron（本机本地时间；日和星期都不是 `*` 时，满足其一即触发），或事件 `mail`（`mail/fetch` 收到新邮件）/ `todo`（待办入队）。事件可用 `match` 做大小写不敏感的子串过滤。
- 触发时若目标会话在线且空闲，就用 `origin: "schedule"` 跑一轮，使用该 Agent 已有工具。审批仍然生效，所以无人值守的例程不能自己批准写入或发信。会话不存在不会被自动创建，这次记为 `skipped`。正忙或同一例程一小时超过 8 次也跳过。
- 每次触发调用 Rust `schedule/audit`，`op: "schedule"`，逻辑路径 `schedule/<rtn_id>/<ran|skipped|failed>`。状态变化经 `schedule/event` 转发为 `schedule://event`。

## 3. Tauri commands（前端 → Rust）

| command | 参数 | 返回 |
|---|---|---|
| `vault_set_root` | `{path: string}` | `string`（规范化后的根路径） |
| `vault_get_root` | — | `string \| null` |
| `vault_init_home` | — | `string`（创建并设置当前用户 `~/DepDek-Home`；目录操作由 Rust 执行） |
| `storage_summary` | — | `{sampled_at_ms, volumes: [{name, file_system, mount_point, kind, removable, total_bytes, available_bytes, used_bytes, used_pct}]}`（本机挂载卷只读容量信息；不遍历文件、不执行磁盘写入） |
| `voice_transcribe` | `{audioBase64: string}` | `string`（本地 Vosk 中文识别文本；不保存录音、不联网） |
| `ai_os_model_status` | `{providerName: string}` | `{state: "available"\|"unavailable"\|"unknown", reason: string}`；只对已保存的 Provider 做有界模型列表 GET，要求所选模型实际列出；不发送 prompt/文件，不启动推理，见下方连接状态约定 |
| `vault_read_file` | `{path: string}` | `{content, size, sha256}` |
| `vault_write_file` | `{path: string, content: string}` | `{size, sha256}` |
| `vault_list_dir` | `{path: string}` | `{entries: [...]}` |
| `vault_search_files` | `{query: string}` | `{matches: [...]}` |
| `vault_delete_file` | `{path: string}` | — |
| `vault_compress` | `{path: string, archivePath?: string}` | `{source, archive, files, bytes, archive_size}` |
| `file_index_refresh` | — | `FileIndexSummary`（用户显式触发 Home 文件 SHA-256 扫描及原子索引更新；不搬动原件） |
| `file_library_import` | `{input: {libraryId: string, operationId: string, name: string, dataBase64: string}}` | `{file: FileIndexRecord, summary: FileIndexSummary, status: "indexed"}`；用户选择文件后保存独立副本并增量登记 KV，不扫描其它 Home 文件；libraryId 来自当前查询摘要，用于拒绝切换 Home 后的旧导入；同 operationId 同参可重试、变参拒绝，详见 [文件索引契约](file-index.md) |
| `file_index_query` | `{filter?: {category?, query?, sha256?, path_prefix?, offset?, limit?}}` | `{items: FileIndexRecord[], total, summary: FileIndexSummary}`（类型、分类规则与限制见 [文件索引契约](file-index.md)） |
| `content_annotation_get` | `{input:{libraryId,reference:{path,sha256}}}` | `ContentAnnotation\|null`；当前文件引用的 AI 标注，详见 [内容分析契约](ai-content-agent.md) |
| `content_analyze` | `{input:{libraryId,reference,providerName,evidence,expectedRevision}}` | `ContentAnnotation`；Vault 复核原件、解析保存的 Provider、调用 content/analyze、复核并落本机 KV；不覆盖人工标签 |
| `content_annotation_update` | `{input:{libraryId,reference,expectedRevision,title,description,tags}}` | `ContentAnnotation`；用户修正描述/标签，保留模型和证据来源 |
| `photo_library_query` | `{filter?: {query?, sha256?, offset?, limit?}}` | `{items: [{file: FileIndexRecord, tags: PhotoTag[]}], total, summary}`；仅照片，文件名/路径及用户标签搜索，分页最多 100 |
| `photo_preview` | `{path, expectedSha256}` | `ReadBinaryResult`；Vault no-follow 打开已索引照片，12 MiB 上限，复验内容 SHA 与图片魔数，仅原生用户预览 |
| `photo_tags_set` | `{path, expectedSha256, tags: [{kind, value}]}` | `{path, sha256, tags, updated_at_ms}`；确认的用户标签，最多 16 条，每值 120 字；kind 为 `person|place|event|captured_date|note|selection`，selection 仅 `keep` |
| `video_library_query` | `{filter?: {query?, sha256?, offset?, limit?}}` | `{items: [{file, tags, revision}], total, summary, stories}`；仅视频名称/路径/SHA/人工标签检索，分页最多 100，故事最多 100；不做内容理解，见 [视频契约](video-library.md) |
| `video_preview` | `{input: {libraryId, reference: {path, sha256}}}` | `ReadBinaryResult`；本机用户 nofollow/SHA/视频容器签名复核，单片最多 64 MiB，不是 Range 流媒体服务 |
| `video_tags_set` | `{input: {libraryId, reference: {path, sha256}, tags: PhotoTag[], expectedRevision}}` | `{path, sha256, tags, revision, updated_at_ms}`；复验原件及乐观版本后保存本机视频标签，与照片标签独立 |
| `video_story_put` | `{input: {libraryId, id, title, references: [{path, sha256}], expectedRevision}}` | `{id, title, references, revision, updated_at_ms}`；有序原片引用草稿，最多 20 段/合计 256 MiB、每片 64 MiB，最多 100 个故事；保存前复验每个原件，不生成成片 |
| `document_library_state` | — | `{library_id, favorites: DocumentFavorite[], collections: DocumentCollection[]}`；本机资料人工记录，见 [资料契约](document-library.md) |
| `document_search` | `{input: {libraryId, query}}` | `{items: [{file, snippet?, line?}], catalog_total, body_examined, skipped, incomplete}`；查询已索引文档名称/路径，显式有界检索 UTF-8 原文，不调用模型 |
| `document_preview` | `{input: {libraryId, reference: {path, sha256}}}` | `{kind: "text"\|"pdf"\|"unsupported", content?, data_base64?, size, sha256, truncated}`；16 MiB、nofollow、内容 SHA 复核；文本最多 128 KiB，PDF 本机渲染，不执行文档指令 |
| `document_favorite_set` | `{input: {libraryId, reference, favorite, expectedRevision}}` | `DocumentFavorite`；内容引用、乐观版本检查后持久保存常用标记 |
| `document_collection_put` | `{input: {libraryId, id, expectedRevision, kind, status, title, references: [{path, sha256, group?}], missing: string[]}}` | `DocumentCollection`；本机 KV 智能分组或事项清单，active/reverted 状态可撤销，不移动/重命名/删除原件 |
| `document_bundle_export` | `{input: {libraryId, references: [{path, sha256}], title, missing: string[]}}` | `{data_base64, size, sha256, mime}`；核验全部原件后生成内存 tar.gz，含来源清单，交给用户下载；不写 Home、不外发 |
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
| `agent_create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string, engine?: AgentEngine, enabled_skills?: AgentSkill[], label?: string, config_dir?: string}` | `{session_id}` |
| `agent_send` | `{session_id: string, text: string}` | — |
| `agent_analyze` | `{provider: ProviderConfig, text: string, systemPrompt: string, engine?: AgentEngine}` | `{text: string}`（转发 `agent/analyze`） |
| `agent_abort` | `{session_id: string}` | — |
| `agent_close` | `{session_id: string}` | — |
| `team_list` | — | `{tasks: TeamTask[]}` |
| `team_cancel` | `{taskId: string}` | `{task: TeamTask}` |
| `team_roster` | `{agents: [{id, label}]}` | `{updated: number}` |
| `team_policy_get` | — | `{policy: TeamPolicy}` |
| `team_policy_set` | `{policy: TeamPolicy}` | `{policy: TeamPolicy}` |
| `approval_list` | — | `{cards: ApprovalCard[]}` |
| `approval_decide` | `{id: string, decision: "approve"\|"deny"}` | `{card: ApprovalCard}` |
| `schedule_list` | — | `{routines: Routine[]}` |
| `schedule_put` | `{routine: Routine}` | `{routine: Routine}` |
| `schedule_delete` | `{id: string}` | `{deleted: boolean}` |
| `mcp_connectors_get` | — | `{connectors: McpConnector[]}` |
| `mcp_connector_put` | `{connector: McpConnector}` | `{connector: McpConnector}` |
| `mcp_connector_delete` | `{id: string}` | `{deleted: boolean}` |
| `mcp_oauth_store` | `{body: object}` | `{connector_id, stored: string[]}`（body 里的令牌不回显） |
| `mcp_oauth_status` | `{connectorId: string}` | 只含布尔值，见 `mcp/oauth_status` |
| `mcp_list_tools` | `{connectorId: string}` | `{connector_id, tools}` |
| `mcp_reload` | `{sessionId: string}` | `{grants: string[]}` |
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
  op: "read"|"write"|"list"|"search"|"delete"|"stat"|"team"|"mcp"|"approval"|"schedule";
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

`enabled_skills` is enforced by the sidecar as an allow-list over built-in tools: `documents` grants read/list/search/write/compress; `photos`, `music`, and `videos` grant `search_media`/`open_media` restricted to that media kind; `mail` grants configured IMAP fetch and `draft_email` (SMTP only after an approval card); `memory` grants source-backed memory proposals. An explicit empty array grants no vault/media/mail/memory tools. Team tools (`list_teammates`, `delegate_task`, `send_agent_message`) are attached to every Pi session regardless of that allow-list; they only enqueue work on another live session and do not widen the caller's own file or network tools. The callee still runs with its own skill allow-list. Omitted values are interpreted as legacy configuration for backward compatibility. Media bytes are read only through `vault/read_binary`; the UI playback read is separately audited by Rust. `mcp.md` grant lines authorize HTTP MCP tools for Pi sessions (section 2.12). They do not launch local servers, and write/external calls still wait for approval.

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
| `team://event` | `{task: TeamTask}`（原样转发 sidecar 的 `team/event`） |
| `approval://event` | `{card: ApprovalCard}`（原样转发 sidecar 的 `approval/event`） |
| `schedule://event` | `{phase: string, routine: Routine}`（原样转发 sidecar 的 `schedule/event`） |

## 5. 审计日志

- 文件：`<数据文件夹根>/.vault-audit.jsonl`，append-only，每行一个 `AuditEntry` JSON。
- 该文件本身对所有 vault 操作不可见（`list_dir` 过滤，读写 `/.vault-audit.jsonl` 一律拒绝，错误码 -32001）。
- 换根后审计文件随新根创建；旧根的日志保留在原处。
- `op: "team"` 只记录协作生命周期，`path` 是 `team/<task_id>/...` 逻辑主体，vault 读写不会把它当成文件打开。

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

## 14. AgentOS R1 第六批：受控 SDK Engine Worker

新增独立 `sidecar/dist/r1-engine-worker.mjs` 入口，不改变旧 main/stdin RPC、SessionManager、ProviderConfig 或 Webdesk/React 路由。该入口仅运行新核心签发的单次、单 user 文本授权，无工具/历史/自动个人 Context，不加载现有 Settings、Home 或 dsh 默认 profile；不接收真实 Key、endpoint 或任意命令路径。

`v2/delegated.model.issue` 可显式指定 `engine:pi|deepseek-harness`，响应增加已绑定的 engine/provider_id/model/max_tokens 元数据。默认 engine:null 保持第五批兼容；engine 绑定的授权必须以 `ModelCall.context={engine,provider_id,model,max_tokens,system,messages:[{role:user,content}]}` 调用。Vault 在消费授权后验证引擎/模型/预算、空 system、唯一 user 内容逐字节相等；不能在 Worker 里校验后就绕过 core，也不能用旧无 context 调用绕过绑定。未知字段拒绝，失败后无自动重试。

Pi 使用实际 Agent 的自定义 streamFn，Harness 使用实际 AgentLoop + 最小 Cordis services + 自定义 LlmAdapter；两者都通过同一个固定 Rust Worker model.invoke 客户端，Key 仅 core 使用。SDK 运行时事件统一投影为有序安全阶段、最终结果和实际 usage（缺失仍 unknown），不把隐藏思维或合成 Provider 当成真实模型。新 Worker 的协议与隔离验收见 [第六批契约](agentos-v2/runtime-r1-engines.md)。

Provider HTTP 请求统一发送静态公开产品 User-Agent，版本来自受 VERSION 管理的 core package metadata，不含用户/路径/session/token/prompt；符合 Harness adapter 的白标应用归因要求，不作为实际引擎认证或遥测。

## 15. 浏览器预览 HTTP 服务（standalone sidecar）

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

## 16. Jiaho AI-OS 本机首启入口

悟空“宝箱”复用此原生工作台，三种场景为回忆、挑选、成长选片。上述 `photo_*` 命令只作为 Tauri 用户入口，不注册 sidecar 工具或 R1/Webdesk API；sidecar 与其他运行时权限不变。标签存入文件索引私有 redb 的独立 `photo_tags_v1` 表，绑定路径与内容 SHA，重扫不覆盖确认，源内容变化不继续返回旧标签。没有人脸识别、自动垃圾判定或真实视频渲染回执；场景建议由最近的用户话语在本机匹配，不能据此更改原件或发送照片。完整边界与界面状态见 [宝箱设计](jiaho-wukong-treasure.md)。

2026-10-18 首启交互更新：网络 → 账户 → 大模型 → 工作模式，完成后直接进入悟空；新增 `ai_os_set_connection_mode`、`ai_os_network_status`、`ai_os_open_network_settings` Tauri-only 命令。2026-10-19 网络检测与固定 Wi-Fi 设置入口允许在首启登录前使用，仍由 WelcomeVault 审计，不解锁其他命令；网络结果新增 `connectivity: online|offline|limited`。按用户要求，检测、验证码、注册和登录统一使用 BitBay 已部署的公共 `/v2` 接口：`https://api.bitbay.site/v2/email/send-code`、`/v2/user/register`、`/v2/user/login`；固定枚举 URL，不允许内部路由、任意 URL 或旧 `/api` 自动回退。连通检测只向公共登录接口发送固定空 JSON，要求其缺少必填字段的 HTTP 400/code 400 校验响应；不携带账号、密码或 Token，不产生真实登录，非在线时只自动打开一次 Wi-Fi 设置，返回后复查。不接入尚未部署的 PaaS `/v1/tenants/...` 草案。`ai_os_bitbay_send_code/register/login` 在真实回执验证成功后才关联/首次建立本机账户，不保存/返回平台 Token，不替换旧空间或扩大权限。`ai_os_status.bitbay` 仅已登录时返回 `{email,user_id}` 或 null。`ai_os_status.connection_mode` 为 `online|local`，缺省为 `online`；输入、冷却、失败/不确定结果、数值回环模型校验、会话启动后锁定及网络设置的边界以 [首启契约](agentos-v2/runtime-welcome.md#四步首启向导与-ai-连接模式2026-10-18) 为准。不是断网/防火墙开关，不改变 R1、Webdesk、邮件或 MCP 的接口/权限；不新增 sidecar 工具。

AI-OS 原生构建提供 `ai_os_status/register/login/logout/chat/complete` Tauri commands，参数、积分和持久化语义见 [首启契约](agentos-v2/runtime-welcome.md)。默认禁用于普通桌面构建，不注册成 sidecar 工具或 R1 RPC。编译启用时 Vault 在未登录状态拒绝旧文件入口；首次登录一次性赠送配置体验积分，默认本地助手仅固定回环，不包含商业云端 Key 或余额。简化向导中不再有自由配置对话，模型使用 `settings_get/set` 保存，用户可显式选择测试固定文本（现有只读 `agent_analyze`）；完成后直接进入悟空。不改变兼容 `ai_os_chat` 的固定本机出口或 R1 授权。Key 仍按 §6.1 加密，不在前端持久化/回显，连接测试不得在保存或加载时自动发出。

原生状态与积分由 Rust Vault 验证，不接受前端声明角色、余额、模型地址或赠送额度。`.jiaho-onboarding` 私有子树不通过通用 Vault 的读取、写入、列表、检索或压缩接口暴露，即使用户选择其父目录；指向该子树的符号链接同样拒绝。R1 业务身份/Worker/云端同意边界保持独立。

完成首启后默认进入悟空三栏协作室（左侧 Agent、中间聊天、右侧可收起的操作面板），仍由原生 `DepDekAiOsShell` 承载，可往返完整工作台。新增伙伴默认不授予任何技能；模型保存、会话和审批沿用现有接口，不接入 Webdesk HTTP/业务身份。详见首启契约的“悟空协作室”一节。

AI-OS 前端统一监听既有本机 Vault 登录错误：`E32006` 或 Welcome `LOGIN_REQUIRED` 会在已解锁的工作区上方显示重新登录对话框。对话框使用现有 `ai_os_login` 命令，不改变 Vault 的认证边界；登录成功后保留当前页面与草稿并刷新只读连接状态，不自动重放触发登录错误的操作。模型服务的 HTTP 401/403 不属于本机空间登录错误，不触发此对话框。

2026-10-21 模型连接状态：联网模式且未主动暂停公域模型时，无已配置的本地模型或已配置本地模型检测失败，可将悟空绑定切换到已有的公域 Provider；不注入商业 Key、不自动注册 Provider、不覆盖用户主动选择的本地模式。底部“使用公域大模型”默认勾选，用户取消后记住暂停偏好；实际对话仍只在点击发送后提交，内容分析/家庭文件外发保留各自入口。Tauri-only `ai_os_model_status` 只接收已保存 Provider 的名称，先经 Vault 登录与连接模式校验，再由 Rust 解密并请求对应基础 URL 的 `/models`（Anthropic 为固定 `/v1/models`）。HTTP 仅数值回环允许，其余 HTTPS；禁止 URL 凭据/查询/片段，禁重定向、无自动重试，连接超时 3 秒、总超时 6 秒、响应上限 512 KiB。只有响应明确列出所选模型才返回 available；401/403、不可达、模型缺失为 unavailable；不支持列表或分页未完为 unknown，不能显示绿色已连接。返回/日志不含 Key、URL、模型响应或家庭资料。此只读元数据检查可在已登录协作室加载/配置变化时进行，不调用原来的固定文本推理测试；检查少量本机配置及当前公域路线，30 秒内重用结果，无后台定时轮询，用户可点击右上角重新检测。sidecar 无新增协议或工具，Webdesk/R1 不变。
