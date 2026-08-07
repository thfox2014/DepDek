# Agent Workbench

跨平台多 Agent 工作台客户端：基于 **Tauri 2**（Linux 优先，同一代码可打包 Mac/Windows），agent 框架为 badlogic 的 **pi-agent-core**。用户指定一个本地**数据文件夹**，agent 对其中文件的所有读写都必须经过 Rust 侧的安全可审计接口——路径沙箱 + append-only 审计日志。

## 架构

```
前端 (React + Vite + TS)
   │  Tauri commands / events
   ▼
Rust 核心 (src-tauri/)  ──► Vault 服务：数据文件夹沙箱读写 + .vault-audit.jsonl
   │  stdio NDJSON JSON-RPC
   ▼
Node sidecar (sidecar/)  ──► pi-agent-core / pi-ai：多 agent 会话、流式事件
```

- **信任边界在 Rust**：agent 没有任何直接 fs/bash 能力，5 个文件工具（read/write/list/search/delete）全部经 RPC 由 Rust 校验执行并审计。
- 三方接口以 [docs/contract.md](docs/contract.md) 为唯一标准。
- 模型接入：OpenAI / Anthropic / OpenAI-compatible 端点（base_url 可配，覆盖 Ollama 等本地模型）。API key 存应用配置目录（tauri-plugin-store），不进数据文件夹。

## 目录

| 路径 | 说明 |
|---|---|
| `src-tauri/` | Rust 核心：vault.rs（沙箱）、audit.rs（审计）、rpc.rs（sidecar 通信）、app.rs（Tauri commands） |
| `sidecar/` | Node sidecar：rpc.ts、tools.ts（vault 工具）、providers.ts、sessions.ts（pi-agent-core 会话管理） |
| `src/` | React 前端：FolderPicker / FileTree / SessionList / ChatPanel / AuditViewer / SettingsPanel |
| `docs/contract.md` | 三方接口契约 |

## 环境准备（Linux / Ubuntu 24.04）

```bash
# Rust（rustup，用户目录）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Node 22（任意方式；本项目用 ~/.local/node）
# 下载 node-v22.x-linux-x64.tar.xz 解压到 ~/.local/node，并把 ~/.local/node/bin 加入 PATH

# Tauri 系统依赖（需要 sudo）
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev build-essential pkg-config libssl-dev
```

Mac：Xcode CLT + Node + Rust 即可；Windows：MSVC Build Tools + WebView2（Win10/11 自带）+ Node + Rust。

## 开发

```bash
npm install                 # 前端依赖
npm --prefix sidecar install && npm --prefix sidecar run build   # sidecar
npm run tauri dev           # 启动开发窗口（需已安装 webkit 系统依赖）
```

## 测试

```bash
cd src-tauri && cargo test --no-default-features   # Rust：vault 安全 + 审计 + RPC 集成（无需 webkit）
cd sidecar && npm test                             # sidecar：36 个测试（rpc/tools/events/sessions）
npm run build                                      # 前端：tsc 类型检查 + vite 构建
```

## 打包

```bash
npm run tauri build   # 在目标系统上执行；产出平台安装包（Linux: deb/AppImage, Mac: dmg, Windows: msi）
```

跨平台发布需在对应系统（或 CI matrix）上构建。

## 安全模型

1. 所有文件路径相对数据文件夹根；拒绝绝对路径、空路径、`..` 越顶、逃逸 symlink（错误码 -32001）。
2. 单文件读写上限 10 MiB（-32003）；仅 UTF-8 文本（-32005）。
3. 审计日志 `<根>/.vault-audit.jsonl` append-only，记录时间/session/操作/路径/结果/sha256；该文件对 agent 不可见。
4. MVP 不向 agent 提供 shell/bash 工具。

## 后续路线

- sidecar 单文件打包进安装包（Tauri sidecar/SEA 机制）
- shell 工具（默认关闭，需用户逐次确认）
- agent 间消息互通、会话持久化
