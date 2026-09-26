# AGENTS.md

## 项目概况

Agent Workbench：Tauri 2 跨平台多 agent 工作台。Rust 核心（信任边界）+ Node sidecar（pi-agent-core）+ React 前端。三方接口**唯一标准**是 `docs/contract.md`——改动任何一方接口前必须同步更新契约并检查另两方。

## 结构与职责

- `src-tauri/src/vault.rs` — 数据文件夹沙箱。所有安全校验只在这里做，不得在别处绕过。
- `src-tauri/src/audit.rs` — append-only 审计（`.vault-audit.jsonl`）。每个 vault 操作无论成败都必须记录。
- `src-tauri/src/rpc.rs` — stdio NDJSON JSON-RPC。Rust id 空间 1..99999，sidecar 从 100000 起。
- `src-tauri/src/app.rs` — Tauri commands（feature `tauri-app` 门控，默认开启）。
- `sidecar/src/` — agent 运行时。**禁止**给 agent 注册直接 fs/bash 工具；文件工具只能转发 `vault/*` RPC。stdout 只走协议行，日志一律 stderr。
- `sidecar/src/mail.ts` — IMAP 收邮件（imapflow + mailparser）。账号配置在 vault `mail/accounts.json`（契约 §7），邮件经 `vault/*` RPC 落盘到 `mail/`，审计 session_id 记 `"mail"`。
- `src/` — React 前端。Tauri 2 参数传 camelCase（invoke 自动映射 Rust snake_case）。

## 常用命令

```bash
# Rust（不需要 webkit 系统依赖即可跑）
cd src-tauri && cargo test --no-default-features

# sidecar
npm --prefix sidecar install && npm --prefix sidecar run build && npm --prefix sidecar test

# 前端
npm install && npm run build

# 完整桌面开发（需 webkit2gtk-4.1-dev 等系统库）
npm run tauri dev
```

## 版本号

`VERSION`（仓库根）是唯一来源，由 `scripts/version.mjs` 同步到 `package.json`、`sidecar/package.json`、
`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。改动版本必须用脚本，
不要手改单个 manifest：

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
