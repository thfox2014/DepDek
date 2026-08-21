# DepDek 的 DeepSeek Harness 引擎

DepDek 的 Agent Team 现在支持把单个 Agent 的执行引擎切换为 `deepseek-harness`。这是一个适配层，不会替换 Rust Vault，也不会把 DepDek Home 目录交给 Harness。

## 安装

DeepSeek Harness 当前是 developer preview，要求 Node.js 22.19+（本工程打包的 Node 运行时满足此要求）。在开发机上安装 CLI：

```bash
npm install -g @deepseek-ai/dsh@0.1.0-rc.6
```

验证：

```bash
dsh --profile headless --help
```

如果 `dsh` 不在 PATH，可在启动 DepDek 前设置：

```bash
export DEPDEK_DSH_COMMAND="/absolute/path/to/dsh"
```

从 Finder 启动的 DepDek 不会继承终端里的 nvm PATH。sidecar 会自动探测当前
`PATH`、`~/.nvm/versions/node/*/bin/dsh`、`~/.local/bin/dsh`、Homebrew 等常见
安装位置；如果仍然找不到，会提示上述安装命令和 `DEPDEK_DSH_COMMAND` 配置，
不会在分析时自动通过 npx 下载或执行未知版本。

## 在 DepDek 中启用

1. 打开「Agent Team」，选择或新建 Agent。
2. 在 Agent 配置的「引擎」选择 **DeepSeek Harness**。
3. 选择 DeepSeek/OpenAI provider 并保存配置。
4. 发送消息；任务中心会沿用 DepDek 的会话事件展示，聊天区会显示“启动、只读策略、分析、生成、完成”等安全过程摘要。

成功收到 Harness 返回后，聊天记录会出现“引擎已确认：DeepSeek Harness · dsh --profile headless”状态。该状态只由 sidecar 返回的 `agent/event` 中 `data.engine = "deepseek-harness"` 触发，不是前端配置文字。

Harness 通过 provider 的 API key 传给本地子进程，不写入日志。Anthropic provider 暂不支持此引擎；本地 Ollama 等 OpenAI-compatible provider 也不能直接由 dsh headless 使用，应继续选择 Pi Agent Core。

过程摘要通过统一的 `agent/event` `progress` 事件发送，和 Pi Agent Core 使用同一套前端渲染链。为避免泄露凭据或个人数据，DepDek 不直接展示 Harness 的隐藏链式思维原文；工具调用和阶段状态会保留在当前会话中。

## 安全边界

- 每一轮调用 `dsh --profile headless`，在临时目录执行，并把 `DSH_HOME` 指向该临时目录；只注入当前文本和最近的有限对话历史。
- 自动设置 `DSH_PERMISSION_MODE=read-only`、`DSH_TELEMETRY_DISABLED=1`，并传入 DepDek 生成的 patch，禁用 dsh 的本地文件、shell、web、sub-agent、workflow 等能力。
- Harness 当前没有拿到 Vault RPC，因此不能读取或修改 DepDek 本地文件。需要文件读写、压缩或邮件动作时，应使用 DepDek 自己的 Vault/任务接口和 Pi Agent Core。
- dsh 不可执行、缺少 API key 或请求失败时，界面显示错误；不会静默切回云端，也不会自动执行建议。

## 如何验证

可从终端启动应用并观察 sidecar stderr：

```bash
DEPDEK_DSH_COMMAND="$(command -v dsh)" \
  /Applications/DepDek.app/Contents/MacOS/agent-workbench 2>&1 | tee /tmp/depdek-harness.log
```

选择 Harness Agent 并发送一条消息后，应看到类似：

```text
[depdek-harness] session=... engine=deepseek-harness profile=headless model=deepseek-v4-flash command=dsh
[depdek-harness] session=... completed exit=0
```

若未配置 API key，预期会先看到上面的 Harness 启动行，然后出现 `MISSING_CREDENTIAL`；这已经证明请求进入了 dsh headless，而不是 Pi Agent Core。

## 兼容策略

省略 `SavedAgent.engine` 的旧配置仍使用 Pi Agent Core。Harness 的 headless profile 是一次任务后退出的公开接口，DepDek 在 sidecar 内维护有限历史以提供连续对话；后续如 Harness 发布稳定的可嵌入 Agent/Session API，再替换此进程适配层，不改变前端和 Vault 合同。
