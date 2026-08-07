# Agent Workbench 接口契约 v1

本文件是 Rust 核心（`src-tauri/`）、Node sidecar（`sidecar/`）、前端（`src/`）三部分之间的**唯一接口标准**。三部分可独立开发，但不得偏离本契约；任何变更需三方同步更新本文件。

## 1. 总体架构

```
前端 (React)  <--Tauri commands/events-->  Rust 核心  <--stdio JSON-RPC-->  Node sidecar (pi-agent-core)
                                              |
                                              +--> Vault 服务（数据文件夹沙箱读写 + 审计日志）
```

- Agent 对数据文件夹**没有任何直接 fs 访问**；所有文件操作由 sidecar 通过 `vault/*` RPC 请求 Rust 执行。
- Rust 是唯一的信任边界：路径校验、大小限制、审计日志全在 Rust 侧。
- MVP 不提供 shell/bash 工具。

## 2. Sidecar stdio 协议（Rust ↔ sidecar）

- 传输：子进程 stdio，**每条消息一行 JSON**（NDJSON），UTF-8，无内嵌换行。
- 格式：JSON-RPC 2.0。请求 `{"jsonrpc":"2.0","id":<int>,"method":<str>,"params":<obj>}`；成功响应 `{"jsonrpc":"2.0","id":<int>,"result":<any>}`；错误响应 `{"jsonrpc":"2.0","id":<int>,"error":{"code":<int>,"message":<str>,"data":<any?>}}`；通知（无 id）`{"jsonrpc":"2.0","method":<str>,"params":<obj>}`。
- 双方都是 server 也都是 client：Rust 可请求 sidecar 的 `agent/*` 方法；sidecar 可请求 Rust 的 `vault/*` 方法；sidecar 向 Rust 发 `agent/event` 通知。
- sidecar 的 `id` 空间从 100000 起，避免与 Rust 的 id 冲突。

### 2.1 Rust → sidecar：`agent/*` 请求

| 方法 | params | result |
|---|---|---|
| `agent/create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string}` | `{session_id}` |
| `agent/send` | `{session_id: string, text: string}` | `{}`（回复经 `agent/event` 流式下发） |
| `agent/abort` | `{session_id: string}` | `{}` |
| `agent/close_session` | `{session_id: string}` | `{}` |
| `mail/fetch` | `{account?: string}`（账号显示名，缺省收全部） | `{fetched: number, accounts: [{name: string, new_messages: number, error?: string}]}` |

```ts
// ProviderConfig（三方共用同一形状）
type ProviderConfig =
  | { kind: "openai"; api_key: string; model: string; base_url?: string }
  | { kind: "anthropic"; api_key: string; model: string }
  | { kind: "openai-compatible"; api_key?: string; model: string; base_url: string }; // 覆盖 Ollama 等本地端点
```

### 2.2 sidecar → Rust：`agent/event` 通知

`params = { session_id: string, type: EventType, data: object }`

| type | data |
|---|---|
| `text_delta` | `{delta: string}` |
| `tool_call_start` | `{tool_call_id: string, name: string, args: object}` |
| `tool_call_end` | `{tool_call_id: string, name: string, ok: boolean, result_preview: string}`（preview 截断至 500 字符） |
| `message_complete` | `{stop_reason: string}` |
| `error` | `{message: string}` |

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

`vault/read_binary` 说明：为前端图片/视频预览提供；MIME 按扩展名推断（未知为 `application/octet-stream`）；上限 64 MiB（超出 -32003）；审计记 `op: "read"`。**不注册为 agent 工具**（sidecar 不暴露），仅经 Tauri command 供前端使用。

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
- sidecar 收到 `mail/fetch` 后：读 `mail/accounts.json` → 逐账号走 IMAP 增量拉取 INBOX 新邮件 → 每封邮件渲染为 Markdown 经 `vault/write_file` 落盘到 `mail/<name>/` → 回写 `accounts.json` 更新 `last_uid`。
- sidecar 收取时的所有 vault 读写操作审计 session_id 记为 `"mail"`。
- 单账号失败只在其结果项记 `error`，不中断其他账号；未配置邮箱（`mail/accounts.json` 不存在）返回 -32002。
- sidecar 另注册 agent 工具 `fetch_mail`（params `{account?: string}`），与 `mail/fetch` 同一实现。该工具不属于 fs/bash 工具：网络仅访问配置中的 IMAP 服务器，落盘只经 `vault/*` RPC。
- 未安装/未运行的 sidecar 无法收邮件，Rust 按 sidecar 不可用错误透传。

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
| `vault_read_binary` | `{path: string}` | `{data_base64, size, sha256, mime}` |
| `audit_read` | `{offset?: number, limit?: number}` | `{entries: AuditEntry[], total: number}` |
| `agent_create_session` | `{session_id: string, provider: ProviderConfig, system_prompt?: string}` | `{session_id}` |
| `agent_send` | `{session_id: string, text: string}` | — |
| `agent_abort` | `{session_id: string}` | — |
| `agent_close` | `{session_id: string}` | — |
| `settings_get` | — | `Settings` |
| `settings_set` | `{settings: Settings}` | — |
| `mail_fetch` | `{account?: string}` | `{fetched: number, accounts: [...]}`（同 `mail/fetch` result，转发 sidecar） |

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
  providers: Record<string, ProviderConfig>;  // key 为显示名
  agents?: SavedAgent[];                      // 已保存的 agent 会话配置，下次启动自动重建
};

type SavedAgent = {
  id: string;
  label: string;
  provider_name: string;       // 指向 providers 的 key
  system_prompt?: string;
};
```

所有 vault_* commands 与 sidecar 走**同一个 Vault 服务**，同样写审计日志（session_id="user"）。command 错误以字符串 message 返回（Tauri `Result<T, String>`），message 中包含错误码文本，如 `E32001 path escapes root`。

## 4. Tauri events（Rust → 前端）

| event | payload |
|---|---|
| `agent://event` | `{session_id, type, data}`（原样转发 sidecar 的 `agent/event`） |
| `vault://audit` | `AuditEntry`（每写一条审计记录即发一次，供审计查看器实时刷新） |

## 5. 审计日志

- 文件：`<数据文件夹根>/.vault-audit.jsonl`，append-only，每行一个 `AuditEntry` JSON。
- 该文件本身对所有 vault 操作不可见（`list_dir` 过滤，读写 `/.vault-audit.jsonl` 一律拒绝，错误码 -32001）。
- 换根后审计文件随新根创建；旧根的日志保留在原处。

## 6. 路径与安全规则（Rust 侧实现）

1. 收到相对路径 → 与 root 拼接 → 解析 `.`/`..` → 若任一级是 symlink，canonicalize 后必须仍以 canonicalized root 为前缀，否则 -32001。
2. 拒绝绝对路径与空路径。
3. read/write 单文件上限 10 MiB（-32003）；read_binary 上限 64 MiB。
4. 仅处理 UTF-8 文本（-32005）。
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
};
```

- 邮件文件：`mail/<name>/<epoch_ms>-<uid>.md`，内容为头部（From/To/Date/Subject/附件文件名列表）+ 正文 text/plain；附件不落盘（契约无二进制写接口）。
- `mail/fetch` 只增量拉取 `uid > last_uid` 的邮件，首次收取以当次拉到的邮件为准。

