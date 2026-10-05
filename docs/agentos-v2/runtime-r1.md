# R1 本地只读服务：已实现的运行时契约

> 2026-10-04；软件版本仍为 0.2.0。本文描述 `services/depdekd` 第一批只读切片，第二批扩展见 [本机凭据契约](runtime-r1-secrets.md)。完整 V2 HTTP 设计仍是草案。正式登记见 [桌面契约 §9](../contract.md#9-agentos-r1-本地只读服务增量入口)。

## 1. 已实现与未实现

```text
depdek CLI / 本机 socket 客户端
             │ OS peer uid + 有界 JSON-RPC
             ▼
depdekd：固定 workspace / principal / 命令版本
             │ ReadAuthority（不能由 JSON 声明）
             ▼
src-tauri::vault::ManagedReadVault
       目录范围 / 逐级 no-follow / 内部资产过滤
             │
       读取 → 持久审计 → 才返回结果
```

实现三个只读命令：`file.list/read/stat@1.0`。无模型依赖、无网络监听、无业务写入、无数据库 migration；未启用可选凭据管理时只有审计日志会追加。

它不是完整 Command Hub、家庭多用户服务或新 sidecar。没有 HTTP/OpenAPI 路由、Webdesk 代理、Tauri daemon 切换、业务 Plan/Grant/Job/Receipt、SourceRevision、动态权限撤销或共享记忆迁移。第二批仅增加独立 SecretStore 管理回执，不等于业务行动回执；现有桌面与 sidecar 保持原调用。

## 2. 启动与身份

从仓库根目录构建：

```bash
npm run daemon:test
npm run daemon:build
services/depdekd/target/release/depdekd --version
```

两个二进制为 `depdekd` 和 `depdek`。当前开发机产物为 macOS；Linux 产物需在 Linux 构建与验收，不能把本机二进制部署到 NAS。

按 [配置示例](../../services/depdekd/config.example.json) 填写一个**独立测试空间**：

```json
{
  "workspace_id": "family-demo",
  "root": "/srv/depdek/demo-workspace",
  "read_paths": ["documents"],
  "socket": "/run/user/1000/depdekd/command.sock"
}
```

- 使用实际非 root OS 账号的目录与 uid，不固定为 1000。macOS 需改为本机私有运行目录。
- `root`、`socket` 必须是绝对路径。root 与 `documents` 等可读目录必须预先存在，服务不创建业务目录。配置文件由可信操作员控制，不含密钥。
- 只登记明确的相对目录，1–32 项；不能登记 `.`、空根、文件、保留目录或 symlink。不要把整个家目录当作测试 root。
- socket 父目录已存在时必须属于运行账号、非 symlink，且 group/other 没有权限；典型模式 0700。不自动 chmod 现有目录。若末级父目录不存在，只创建该一级，其父必须已存在。
- socket 模式 0600；已有 socket/普通文件一律不覆盖、不自动清理。退出只删除自己创建且 inode/dev 未改变的 socket。
- daemon 拒绝 root。服务端和 CLI 都验证对端 uid，principal 固定为 `local:<daemon uid>`；请求不能自填 actor、role、session_id。
- 一次启动固定一个 workspace 和 `policy_revision=1`；更改配置需受控停机重启，不支持热更新。

启动和查询：

```bash
services/depdekd/target/release/depdekd serve --config /absolute/path/config.json

# 另一个终端，同一个 OS 用户
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock health
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock commands --workspace family-demo
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock command file.list --workspace family-demo --input '{"path":"documents","limit":20}' --json
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock command file.read --workspace family-demo --input '{"path":"documents/receipt.md"}' --json
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock command file.stat --workspace family-demo --input '{"path":"documents/receipt.md"}' --json
```

CLI 可用 `DEPDEKD_SOCKET` 替代 `--socket`，始终将 JSON 结果打印到 stdout，诊断到 stderr。服务业务拒绝退出码 2；连接/参数失败非零。没有直接文件读取或 shell fallback。

## 3. 传输和 envelope

Unix stream，一连接一个以换行结束的 UTF-8 JSON-RPC 2.0 请求与响应；不支持通知、batch 或流水线。请求 `id` 为 u64，不是 v1 stdio 的 ID 空间。

| 方法 | params | 返回的 data |
|---|---|---|
| `v2/health` | `{}` | ready/version/mode；模型与业务写入均为 false |
| `v2/commands.list` | `{workspace_id}` | 三个版本化 Manifest |
| `v2/command.invoke` | `{workspace_id, command, command_version, input}` | completed/result/freshness/source_revisions_available |

请求对象与 params/input 拒绝未知字段。`v2/health` 也要求本机身份，不是设计 OpenAPI 的匿名公共健康端点。

```json
{"jsonrpc":"2.0","id":1,"method":"v2/command.invoke","params":{"workspace_id":"family-demo","command":"file.read","command_version":"1.0","input":{"path":"documents/receipt.md"}}}
```

成功 envelope 示例（request/trace 由服务生成）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0",
    "request_id": "r1-123-abc-1",
    "trace_id": "r1-123-abc-1",
    "workspace_id": "family-demo",
    "policy_revision": 1,
    "data": {
      "status": "completed",
      "result": {"content": "example", "size": 7, "sha256": "<64 hex characters>"},
      "freshness": "live",
      "source_revisions_available": false
    }
  }
}
```

`completed` 表示本次查询完成，不是持久 Job/行动回执。hash 对应本次实际读出的字节；目录、文件可被其他进程改变，不承诺跨查询快照一致性。

业务错误：JSON-RPC `error.code=-32000`，`error.data` 含 api_version/request_id/trace_id 与 `error:{code,message,retryable}`。不返回绝对 root、内容、原始系统错误或密钥。

| 业务码 | 含义 |
|---|---|
| `INVALID_INPUT` | 参数形状、资源预算参数或文本编码不合法 |
| `FORBIDDEN` | 身份/空间/目录范围/资产不允许 |
| `NOT_FOUND` | 已授权路径不存在 |
| `POLICY_CHANGED` | 核心入口 authority 版本不匹配；当前 RPC 不允许自行传版本 |
| `LIMIT_EXCEEDED` | 文本读取超出预算 |
| `AUDIT_UNAVAILABLE` | 审计写入/同步失败，不释放查询结果 |
| `RESOURCE_UNAVAILABLE` | 文件 I/O 失败；只读查询可重试 |
| `CAPABILITY_UNAVAILABLE` | 方法、命令或版本尚未支持，绝不降级为写操作 |

帧/JSON 形状错误为 `-32600`、`id:null`；对端身份错误在传输入口被拒绝。前置协议拒绝和健康查询未进入 Vault，不计作文件审计。后续统一安全审计/outbox 仍是 R1 待办。

## 4. Manifest 和文件语义

Manifest 返回 inline `input_schema/output_schema`，关闭额外字段；含 `name/version/capabilities/effect/authorization/idempotency/compensation/offline/engine_required/limits`。这是当前本机格式，不宣称已满足设计 HTTP 的所有 Schema 引用与版本发现字段。

| 命令 | input | result |
|---|---|---|
| `file.list@1.0` | path；limit 可选，默认 100，范围 1–100 | entries:[name,kind,size]、truncated、coverage |
| `file.read@1.0` | path | UTF-8 content、实际 size、sha256 |
| `file.stat@1.0` | path | kind、size、modified_ms |

- 每个路径最多 1024 UTF-8 字节。拒绝绝对路径、越顶、NUL、反斜线；归一化后按目录分量判断范围，`documents-other` 不属于 `documents`。
- 路径每一级用根 fd 相对 `openat(O_NOFOLLOW)`，包括最后读取的 fd；读文件与 stat 使用同一已验证句柄，不先检查后重新按绝对路径打开。
- 拒绝所有 symlink（即使指向根内）、多硬链接的普通文件、socket/device/FIFO 等特殊节点。隐藏组件、内部配置/记忆/策略目录、数据库和常见凭据文件按 Vault 规则拒绝并从列表中过滤。
- 文件名过滤不是通用秘密检测：不能把含密钥的任意 Markdown 放进可读目录再期待系统识别。当前不提供家庭成员 ACL，也不禁止受信操作员建立的 mount point。
- 文本读取最多 128 KiB，读取本身也执行预算检查；非 UTF-8 和二进制不支持。不提供图片/PDF/大文件下载。
- 目录最多扫描 5000 个条目、输出 100 项，排序后截断；`coverage=bounded_live_directory`，`truncated=true` 可能由扫描或输出预算触发。没有完整总数、分页游标或递归搜索。
- stat 的 kind 为 file/dir，目录 size 为 0；修改时间早于 Unix epoch 时为 0。

## 5. 严格审计与恢复边界

审计路径仍为 root 下 `.vault-audit.jsonl`，沿用 AuditEntry 字段；session_id 含 `v2:<principal>:<request_id>`。记录操作、相对请求路径、结果、读取 hash/字节数，不记录文件正文。

1. 审计通过已持有的 root fd 打开；要求当前账号拥有、regular file、单硬链接、无 group/other 权限。新文件模式 0600，不自动修改旧文件权限。
2. 启动时检查最后一条有界记录完整、合法；损坏/截断尾部拒绝启动，保留原文件。不是全历史验证、签名链或防同 uid 篡改。
3. 文件查询成功与授权拒绝都需完成 write + sync_data，再返回。首次使用还同步 root 目录项。
4. 写/同步失败使当前审计流锁死，不回显内容，也不发布成功 listener。修复需要先保留故障证据，再受控恢复；服务不删除/截断日志或自动把失败改成功。
5. 客户端断线/超时不取消已经开始的只读 I/O；已完成读取可能已审计但未被客户端收到。这不是写操作 receipt，也不能当成模型已经看过内容。

旧桌面日志可能为 0644，新服务会拒绝接入而非静默 chmod；本批不要直接复用正在运行的 Home。旧 v1 的 best-effort 审计仍存在，需后续切换统一修复。尚无轮转/保留、跨进程日志协调或 audit outbox；每次 sync 的低端设备成本待实测。

## 6. 资源与威胁边界

请求 64 KiB、响应 2 MiB；16 个并发连接。帧读/写超时 5 秒，查询等候 15 秒；超时不会强行停止已进入内核的阻塞文件 I/O。因此仅登记受信本地文件系统，不能据此承诺恶意/失联网络挂载下的服务可用性。

假定操作员、内核和同 uid 运行账号可信；这不是同账号恶意进程、root 入侵、硬盘篡改或家庭私人内容隔离方案。禁止直接把 socket 暴露为网络服务，禁止把 Webdesk 后台同 uid 当作浏览器用户身份。可信多用户委托、隔离账号、Gateway、写锁与 ACL 必须另行实现验收后再接入客户端。

## 7. 验证入口

```bash
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
npm run daemon:test
cargo clippy --manifest-path services/depdekd/Cargo.toml --all-targets -- -D warnings
npm run version:check
```

合成资料包含中文、完整邮箱字符串、内部文件、symlink/hardlink、故障审计；真实 daemon + CLI 端到端覆盖实际 socket、Manifest、查询/拒绝、伪造身份字段、未知版本、UTF-8 分块、帧预算、重复启动与退出清理。详情见 [实施记录](implementation-status.md)。
