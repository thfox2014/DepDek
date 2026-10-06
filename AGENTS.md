# AGENTS.md

## 项目概况

Agent Workbench：Tauri 2 跨平台多 agent 工作台。Rust 核心（信任边界）+ Node sidecar（pi-agent-core）+ React 前端。三方接口**唯一标准**是 `docs/contract.md`——改动任何一方接口前必须同步更新契约并检查另两方。

## 结构与职责

- `src-tauri/src/vault.rs` — 数据文件夹沙箱。所有安全校验只在这里做，不得在别处绕过。
- `src-tauri/src/vault/access.rs` — Vault 内部业务会话/目录授权边界；不接受请求体角色，不把 Webdesk admin/进程 uid 当作业务用户。第三批固定代理仅限 loopback，实际契约见 `docs/agentos-v2/runtime-r1-access.md`。
- `src-tauri/src/vault/access/workers.rs`、`vault/profiles.rs` — 第四批受信同 uid Worker 的短期只读票据与控制 Profile 引用检查；权限、预算、撤销和审计仍在 Vault 内。不是生产进程隔离/模型 Gateway，禁止自动接入非可信 Agent 或释放 API Key，契约见 `docs/agentos-v2/runtime-r1-workers.md`。
- `vault/access/gateway.rs`、`secrets/provider_use.rs` — 第五批可选 exact-input 本机模型出口；Key 仅 core 内部有界回调使用，无 getter，默认禁用云端/DNS/自动重试。Linux Worker 独立 uid 固定通道仅接受文件/模型 invoke；真实 Engine/Context/BFF/迁移接线仍待验收，契约见 `docs/agentos-v2/runtime-r1-gateway.md`。
- `src-tauri/src/audit.rs` — append-only 审计（`.vault-audit.jsonl`）。每个 vault 操作无论成败都必须记录。
- `services/depdekd/` — R1 本机只读业务服务 + 可选加密凭据管理 + `depdek` CLI，依赖禁用 GUI 的现有 Rust 核心。数据/凭据文件访问只经 `vault.rs::ManagedReadVault/SecretFiles`；Unix peer 身份不可从 JSON 声明。协议见 `docs/agentos-v2/runtime-r1.md` 与 `runtime-r1-secrets.md`，不等于完整 V2 HTTP API。凭据管理禁止 Agent 注册/明文 getter/秘密 argv，不改源或自动启用旧配置。
- `src-tauri/src/rpc.rs` — stdio NDJSON JSON-RPC。Rust id 空间 1..99999，sidecar 从 100000 起。
- `src-tauri/src/app.rs` — Tauri commands（feature `tauri-app` 门控，默认开启）。
- `sidecar/src/` — agent 运行时。**禁止**给 agent 注册直接 fs/bash 工具；文件工具只能转发 `vault/*` RPC。stdout 只走协议行，日志一律 stderr。
- `sidecar/src/mail.ts` — IMAP 收邮件（imapflow + mailparser）。账号配置在 vault `mail/accounts.json`（契约 §7），邮件经 `vault/*` RPC 落盘到 `mail/`，审计 session_id 记 `"mail"`。
- `src/` — React 前端。Tauri 2 参数传 camelCase（invoke 自动映射 Rust snake_case）。
- `webdesk/` — 独立 Rust 远程管理服务（axum + sysinfo + 内嵌 React SPA）。**不共享桌面进程、不读写 DepDek Home 数据目录、不修改 `docs/contract.md`**；只读 `/proc`、`/sys` 与自己的 `data_dir`，不提供 shell，写操作必须校验 CSRF 并写审计。设计见 `docs/webdesk-design.md`。

## 常用命令

```bash
# Rust（不需要 webkit 系统依赖即可跑）
cd src-tauri && cargo test --no-default-features

# R1 业务服务与 CLI（Unix；不需要 GUI）
cargo test --manifest-path services/depdekd/Cargo.toml

# sidecar
npm --prefix sidecar install && npm --prefix sidecar run build && npm --prefix sidecar test

# 前端
npm install && npm run build

# webdesk 远程管理服务（独立 crate，单测 + 端到端）
cd webdesk && cargo test && cargo build --release
npm --prefix webdesk/web install && npm --prefix webdesk/web run build   # 前端 → webdesk/web/dist（被 rust-embed 编进二进制）
bash webdesk/scripts/e2e.sh                                            # 真实 HTTP + /proc 的 26 项断言

# 完整桌面开发（需 webkit2gtk-4.1-dev 等系统库）
npm run tauri dev
```

## 版本号

`VERSION`（仓库根）是唯一来源，由 `scripts/version.mjs` 同步到 `package.json`、`sidecar/package.json`、
`webdesk/web/package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` + `Cargo.lock`、
`webdesk/Cargo.toml` + `Cargo.lock`；`space-service/`、`agent-service/`、`services/depdekd/` 的 manifest/lock 同样受管。改动版本必须用脚本，不要手改单个 manifest：

```bash
npm run version:check                 # 校验一致性（npm run build 已内置）
npm run version:bump -- minor --note "本次变更"
```

## 约定

- Rust：错误码遵循契约 2.4 节（`VaultError::code()`）；command 错误字符串格式 `E32xxx message`。
- TypeScript：strict 模式；sidecar 为 NodeNext ESM。
- 测试纪律：改 vault 安全逻辑必须补逃逸/越界用例；改 sidecar 协议必须补 rpc 层测试。
- UI：AI-OS（`VITE_DEPDEK_OS=1`）主页面是 `DepDekAiOsShell`，需与桌面端 `DepDekHome` 互相可达；
  两个页面都必须显示 `APP_VERSION`（`src/version.ts`）。
- 环境：node 在 `~/.local/node/bin`，cargo 在 `~/.cargo/bin`。
