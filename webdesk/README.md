# DepDek Webdesk

类飞牛的**远程 Web 管理控制台**：同一个局域网里的任何设备打开浏览器就能看这台机器的
CPU / 内存 / 磁盘 / 网络，以及**每个应用程序**占用的资源。桌面第一屏就是系统性能监控小组件。

Rust（axum + sysinfo）后端 + React 前端，前端构建产物用 `rust-embed` 编进二进制 —— 单文件部署，
运行时不需要 Node，也不需要静态目录。

设计说明见 [docs/webdesk-design.md](../docs/webdesk-design.md)。

## 快速开始

```bash
# 1) 构建前端（产物进入 webdesk/web/dist）
npm --prefix webdesk/web install
npm --prefix webdesk/web run build

# 2) 构建服务（把前端编进二进制）
cd webdesk && cargo build --release

# 3) 生成密码哈希
./target/release/depdek-webdesk hash-password

# 4) 写配置
cp webdesk.example.toml /etc/depdek/webdesk.toml   # 把上一步的 password_hash 填进 [auth]
./target/release/depdek-webdesk check-config --config /etc/depdek/webdesk.toml

# 5) 启动
./target/release/depdek-webdesk serve --config /etc/depdek/webdesk.toml
#   → http://<主机局域网 IP>:8787/
```

`--insecure-no-auth` 只用于本机调试；配置了证书时请由反向代理终止 TLS（见设计文档 §5.4）。

## 命令行

| 命令 | 说明 |
|---|---|
| `depdek-webdesk serve [--config PATH] [--insecure-no-auth]` | 启动控制台（默认命令） |
| `depdek-webdesk hash-password [PASSWORD]` | 输出 Argon2id PHC 哈希，写入 `[auth] password_hash` |
| `depdek-webdesk check-config [--config PATH]` | 校验配置并打印解析后的路径/端口/采样参数 |
| `depdek-webdesk version` | 打印仓库 `VERSION` |

配置查找顺序：`--config` → `$DEPDEK_WEBDESK_CONFIG` → `/etc/depdek/webdesk.toml` → 内置默认值。
环境变量覆盖：`DEPDEK_WEBDESK_BIND`、`DEPDEK_WEBDESK_PASSWORD_HASH`、`DEPDEK_WEBDESK_DATA_DIR`。

## 部署为开机自启

```bash
sudo install -m 0755 webdesk/target/release/depdek-webdesk /usr/local/bin/depdek-webdesk
sudo mkdir -p /etc/depdek && sudo cp webdesk/webdesk.example.toml /etc/depdek/webdesk.toml
sudo install -m 0644 webdesk/deploy/depdek-webdesk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now depdek-webdesk
systemctl status depdek-webdesk && journalctl -u depdek-webdesk -f
```

## 开发

```bash
# 后端：热重启 + 前端从磁盘读取，不需要重新编译 Rust
cd webdesk
cargo run -- serve --config .run/dev.toml        # web_root 指向 web/dist

# 前端：Vite 开发服务，/api 代理到 127.0.0.1:8787
npm --prefix webdesk/web run dev                 # http://127.0.0.1:5280
# 纯界面预览（示例数据，不需要后端）
open http://127.0.0.1:5280/?demo=1
```

## 测试

```bash
cd webdesk && cargo test            # 30 个单测
bash webdesk/scripts/e2e.sh         # 26 项端到端 HTTP 断言
bash webdesk/scripts/screenshot.sh  # 无头 Firefox 截图 → design-qa/webdesk-<日期>/
```

## 安全要点（详见设计文档）

- Argon2id 密码 + HttpOnly / SameSite=Strict 会话 Cookie + 绝对与空闲双超时；
- 写操作校验 CSRF 令牌，登录失败按来源地址指数退避；
- 只读 `/proc`、`/sys` 与自己的 `data_dir`，不需要 root，不提供 shell；
- 所有登录与管理动作写入 append-only 审计 `webdesk-audit.jsonl`；
- 本版本是明文 HTTP：仅建议可信局域网，或在前端加反向代理终止 TLS。
