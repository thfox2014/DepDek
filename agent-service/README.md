# depdek-agent

独立的 DeepSeek Harness 执行服务。Webdesk 只通过 Unix socket 调用它；服务不读取 DepDek Home/Vault，不给 Harness 文件、shell、Web、sub-agent 或 workflow 工具，也不将 prompt 写入审计/日志。用户提交 Provider 时，API Key 会经 Webdesk 内存短暂转发给专用配置 broker；Webdesk 不持久化、回显或记录密钥。

## 构建与安装（Debian / Ubuntu）

```bash
cd agent-service && cargo test --release && cargo build --release
getent group depdek-agent >/dev/null || sudo groupadd --system depdek-agent
getent group depdek-webdesk >/dev/null || sudo groupadd --system depdek-webdesk
id depdek-agent >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid depdek-agent depdek-agent
sudo install -m 0755 target/release/depdek-agent /usr/local/bin/depdek-agent
sudo install -m 0755 target/release/depdek-agent-config /usr/local/bin/depdek-agent-config
sudo install -d -m 0750 -o root -g depdek-agent /etc/depdek
if [ ! -e /etc/depdek/agent.env ]; then sudo install -m 0600 -o root -g root /dev/null /etc/depdek/agent.env; fi
sudoedit /etc/depdek/agent.env
```

首次启动前可在 `/etc/depdek/agent.env` 中设置 Harness 命令。Provider 的 API Key 可在已启用登录的 Webdesk Agent Team → Provider 页面添加；安全配置服务只接收写入请求，不提供密钥读取接口。配置文件权限为 `0600`（只有 root 可读），Webdesk 不直接读写该文件。

```ini
DEPDEK_DSH_COMMAND=/usr/local/bin/dsh
DEPDEK_AGENT_MODEL=deepseek-v4-flash
```

`dsh` 需预先安装在 appliance 上，建议由发行包管理，不在聊天请求中临时下载/执行。启用服务：

```bash
sudo install -m 0644 deploy/depdek-agent.service /etc/systemd/system/
sudo install -m 0644 deploy/depdek-agent-config.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now depdek-agent
sudo systemctl enable --now depdek-agent-config
sudo systemctl status depdek-agent
```

Webdesk 使用 `DynamicUser`，通过 `depdek-agent` 组访问聊天 socket，并通过独立 `depdek-webdesk` 组访问 Provider 配置 socket。配置服务以 root 运行，但只允许更新固定的 `/etc/depdek/agent.env` 并重启 `depdek-agent.service`；不开放通用文件、命令或网络接口。Webdesk 配置的 `agent_socket` 与 `agent_config_socket` 默认分别是 `/run/depdek-agent/agent.sock` 和 `/run/depdek-agent-config/config.sock`。

### 故障排查

- 保存 Provider 返回 `403`：确认 Webdesk 不是以 `--insecure-no-auth` 启动；该模式会拒绝切换模型或提交密钥。
- 返回“Provider 安全配置服务未连接”：确认 `depdek-agent-config` 已安装并启用，Webdesk 服务账号属于 `depdek-webdesk` 组，且 `agent_config_socket` 指向同一个 socket。
- 保存成功但测试对话失败：先检查 `depdek-agent` 是否运行、`DEPDEK_DSH_COMMAND` 是否指向已安装的 `dsh`，再检查 Provider 的 URL、协议和模型 ID。

## 信任边界

- 聊天服务监听本机 Unix socket，不暴露 TCP 端口；Provider 配置 broker 使用另一只本机 socket，仅 Webdesk 专属组可访问。
- `/etc/depdek/agent.env` 为 root-only；API Key 经登录和 CSRF 校验后由 Webdesk 短暂转发至配置 broker，日志、列表和 API 响应均不含密钥。当前监听器不直接提供 TLS，远端配置密钥须使用受信 HTTPS 反向代理连接本机回环；不能仅填写 TLS 配置字段就认为 HTTP 已加密。
- 每个请求用短生命周期、`0700` 临时工作目录；dsh 子进程只获得当前 Provider 的 API Key、模型、隔离目录和代理网络环境。
- dsh 以 `--profile headless` 启动，并应用禁用 fs/bash/web/sub-agent/workflow 的 patch；工作目录之外的 DepDek 数据不可用。
- Harness 的隐藏链式思维不回传。Webdesk 显示的是执行中状态和最终 Markdown 回复。
- DeepSeek 是云端 provider；Webdesk 每轮发送前要求用户单独确认外发。`DEEPSEEK_API_KEY` 只由 systemd 环境文件注入服务进程。
- 并行执行上限为 2，每个请求最长 120 秒、输入/输出都有限长。

## 本地调试

macOS 等没有 systemd 的环境，可显式启用非 root 私有配置模式。先创建两个当前用户拥有、权限为 `0700` 的目录（例如用 `mktemp -d` 得到路径）。设 `DEPDEK_LOCAL_CONFIG_DIR` 为配置目录、`DEPDEK_LOCAL_RUNTIME_DIR` 为 socket 目录；配置文件名固定为 `agent.env`，不存在时允许从空列表启动：

```bash
DEPDEK_AGENT_LOCAL_ENV_PATH="$DEPDEK_LOCAL_CONFIG_DIR/agent.env" \
DEPDEK_AGENT_SOCKET="$DEPDEK_LOCAL_RUNTIME_DIR/agent.sock" \
DEPDEK_DSH_COMMAND="$(command -v dsh)" \
agent-service/target/release/depdek-agent
```

另一个终端启动写入服务：

```bash
DEPDEK_AGENT_CONFIG_MODE=local-private \
DEPDEK_AGENT_ENV_PATH="$DEPDEK_LOCAL_CONFIG_DIR/agent.env" \
DEPDEK_AGENT_CONFIG_SOCKET="$DEPDEK_LOCAL_RUNTIME_DIR/config.sock" \
DEPDEK_AGENT_CONFIG_APPLY_SOCKET="$DEPDEK_LOCAL_RUNTIME_DIR/agent.sock" \
agent-service/target/release/depdek-agent-config
```

Webdesk 的 `agent_socket`、`agent_config_socket` 分别填写上述两个实际 socket 的绝对路径，并启用管理员登录。三项服务以同一 Unix 用户运行，Webdesk 绑定 `127.0.0.1`。保存后配置服务仅用固定的 `status` 请求确认执行器已载入所选 Provider，不发起模型测试或产生云端费用。执行器每轮读取最新快照，不需要 `systemctl restart`。

本机模式的固定文件读写与权限、别名和审计校验在 Rust Vault 边界中完成；`agent.env` 为 `0600`，符号链接、硬链接、宽松权限或不可写审计均拒绝。它是旧执行器的私有明文/base64 配置兼容模式，**不是加密 Secret Store**，也不会自动迁移现有凭据。正常 SIGTERM/Ctrl+C 会清理本实例 socket；异常终止留下 socket 时需显式确认进程已停止后恢复，不能覆盖其他文件。生产 Linux 仍使用 root broker + systemd，不要将本机开发模式暴露到局域网。
