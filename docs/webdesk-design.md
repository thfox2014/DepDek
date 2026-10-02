# DepDek Webdesk 设计（远程 Web 管理控制台）

> 状态：v0.2.x（登录 / 四人 Agent 协作室 / 隔离 DeepSeek Harness 服务 / 文件管理 / 性能监控 / 存储与网络 / 审计）
> 相关：`webdesk/`（Rust 服务 + 前端）、[contract.md](contract.md)（桌面端三方契约，本文档不修改该契约）

## 1. 目标与非目标

**目标**

1. appliance 装好之后，同一局域网的任何设备（手机 / 笔记本）打开浏览器就能管理这台机器。
2. 桌面上有**系统性能监控**：CPU、内存、磁盘、网络，以及**每个应用程序**占用的资源。
3. 复用 DepDek 已有的安全习惯：最小权限、只读优先、任何敏感动作留审计。

**非目标（本版本明确不做）**

- 不做 shell / 任意命令执行。Agent 只提供文本分析，不获得文件、shell、Web、子 Agent 或工作流工具；文件应用只允许在显式配置根目录内浏览、文本预览和下载，不提供上传、改名、删除或任意路径访问。
- 不做多用户与 RBAC：单管理员账号 + 密码。
- 不做 NAS 共享、快照、备份的写操作（路线图第 2 阶段）。
- 不自己实现 TLS 终止：本版本经反向代理（nginx/caddy）提供 HTTPS，见 §5.4。

## 2. 与现有系统的边界

| 组件 | 关系 |
|---|---|
| `src-tauri/`（桌面端 Rust 核心） | **不共享进程**。webdesk 是独立二进制，桌面端不启动它、也不依赖它。 |
| vault 沙箱（`vault.rs`） | webdesk 不读写用户的 DepDek Home 数据目录；它只读 `/proc`、`/sys`，自己的 `data_dir`，以及管理员单独配置的只读文件根目录。 |
| `docs/contract.md` | DepDek 桌面端新增 `storage_summary` Tauri 命令；Webdesk 仍是独立服务，不参与桌面端 ↔ sidecar 的 JSON-RPC。 |
| agent 工具 | Webdesk **不注册成 agent 工具，也不执行子进程**；Agent 页面把有界文本请求转给单独的 `depdek-agent`。该服务只通过本机 Unix socket 接入，dsh 运行在临时目录、headless profile 和禁用本地/网络工具的策略下，不访问 DepDek Home/Vault。 |

这样切分的原因：远程管理需要一个**长期在线、可开机自启**的服务，而桌面端是随用户登录会话起停的 GUI；把管理面塞进 GUI 进程会让「关掉窗口 = 失去远程管理」。

## 3. 架构

```
浏览器 (手机/电脑)
   │  HTTP/1.1 + JSON, Cookie 会话
   ▼
webdesk/ (Rust, axum)  ──►  Sampler（后台采样任务，sysinfo + /proc）
   │  /api/agent/* ──Unix socket──► depdek-agent (独立 Rust 服务)
   │                                 └─ dsh --profile headless（只读工具策略）
   │                          └─ 环形缓冲：CPU/内存/磁盘/网络 历史
   │  rust-embed 内嵌 SPA         └─ 进程快照 + 按 cgroup/可执行文件归并的「应用」
   ▼
webdesk/web/ (React + Vite)  ──►  桌面：性能监控小组件 + 应用图标
```

单文件部署：前端构建产物由 `rust-embed` 编进二进制，运行时不需要 Node、不需要静态目录。

### 3.1 目录

```
webdesk/
├─ Cargo.toml                     依赖：axum 0.8 / tokio / sysinfo 0.39 / argon2 0.6 / rust-embed
├─ build.rs                       注入 VERSION（DEPDEK_VERSION）；web/dist 缺失时写占位页
├─ webdesk.example.toml           配置样例
├─ deploy/depdek-webdesk.service  systemd 单元（appliance 开机自启）
├─ scripts/e2e.sh                 端到端 HTTP 冒烟测试（curl + python 断言）
├─ scripts/screenshot.sh          无头 Firefox 截图（设计 QA）
├─ src/
│  ├─ main.rs                     CLI：serve / hash-password / check-config / version
│  ├─ config.rs                   webdesk.toml 解析 + 校验 + 环境变量覆盖
│  ├─ state.rs                    AppState（配置、会话、限流、指标、审计）
│  ├─ auth.rs                     Argon2 哈希、会话存储、登录退避、Cookie
│  ├─ audit.rs                    append-only JSONL 审计
│  ├─ util.rs                     时间工具
│  ├─ web.rs                      内嵌 SPA / 开发期磁盘目录 / SPA fallback
│  ├─ metrics/
│  │  ├─ mod.rs                   采样循环、采样点类型、环形缓冲、排序
│  │  ├─ host.rs                  CPU/内存/磁盘/网络（含 /proc/diskstats 速率）
│  │  └─ processes.rs             进程快照 + 应用归并（cgroup → 命令 → 可执行文件）
│  └─ api/
│     ├─ mod.rs                   路由装配（限流中间件层）
│     ├─ session.rs               登录/登出/会话 + 鉴权与 CSRF 守卫
│     ├─ system.rs                health/summary/series/disks/network/audit
│     ├─ files.rs                 配置根目录下的只读列表/预览/下载与审计
│     └─ processes.rs             /api/apps、/api/processes
└─ web/                           前端（Vite + React + TS，无 UI 库、无图表库）
   └─ src/
      ├─ api.ts                   类型化客户端 + 浏览器预览开关
      ├─ demo.ts                  `?demo=1` 示例数据
      ├─ components/              charts.tsx（SVG 折线/环/进度条）、Login.tsx
      ├─ desktop/                 DesktopShell.tsx、FloatingWindow.tsx、PerformanceWidget.tsx
      └─ apps/                    Agent / Overview / Performance / Processes / StorageNetwork / Files / SystemInfo
agent-service/                    独立 depdek-agent crate、systemd 单元与 Key 安装说明
```

## 4. 指标与「应用程序」归并

| 指标 | 来源 | 说明 |
|---|---|---|
| CPU 总量 / 每核 | `sysinfo`（`/proc/stat` 差分） | 采样间隔 ≥ 500ms，默认 2000ms |
| 内存 / Swap | `/proc/meminfo` | 已用 = total − available |
| 负载 | `/proc/loadavg` | 1 / 5 / 15 分钟 |
| 磁盘容量 | `sysinfo`（`/proc/mounts` + `statfs`） | 每个挂载点一条 |
| 磁盘吞吐 | `/proc/diskstats` | 只统计整盘（`sda`、`nvme0n1`…），跳过分区与 loop/zram |
| 网络速率 | `sysinfo`（`/proc/net/dev`） | 相邻采样差分，单位 B/s |
| 进程 | `sysinfo` | PID、名称、可执行文件、命令、CPU%、RSS、状态、运行时长、IO |
| 每应用 | `cgroup_unit` + 命令启发 + 可执行文件名 | 见下 |

**应用归并优先级**

1. `/proc/<pid>/cgroup` 的叶子是 **`.service`**（systemd 服务）→ 用单元名，例如 `ollama.service` → 「Ollama 模型服务」。
2. 命令启发（`command_key`）：`node … sidecar.mjs` → `depdek-sidecar`，`depdek-webdesk`、`ollama` 同理。这一步解决「一堆 Node 进程会被算成一个应用」。
3. 否则用可执行文件名（`firefox` → 「Firefox」）。

不使用 `app-*.scope` / `dsh-subprocess-*.scope` 这类**瞬时 scope**：它们的名字只描述登录会话或启动方式，对用户没有意义（在容器/沙箱里更是会把成百上千个进程合成一组）。`app_label()` 内置了一张已知组件表（DepDek 主程序、Sidecar、Ollama、GNOME Shell、Samba、Nginx、PostgreSQL…），未知名字做词首大写美化。

CPU 百分比沿用 `sysinfo` 语义：单核占比（多核可 > 100%），同时给出 `cpu_pct_total = cpu_pct / 逻辑核数`，UI 显示两者。

## 5. 安全模型

### 5.1 认证与会话

- 密码以 **Argon2id PHC** 字符串存放在配置里（`depdek-webdesk hash-password` 生成），默认参数。
- 会话 Cookie `depdek_webdesk_session`：`HttpOnly` + `SameSite=Strict` + `Path=/`，TLS 时自动加 `Secure`。
- 双超时：绝对 TTL（默认 12h）+ 空闲超时（默认 2h），后台惰性清理。
- 会话只存在内存里：进程重启即全部失效。

### 5.2 暴力破解与 CSRF

- 同一来源地址连续失败 `max_failures`（默认 5）次后封禁 60s，之后指数退避至最多 15 分钟。
- 所有**写操作**（登出、Agent 对话等）必须带 `x-depdek-csrf`，值与会话绑定；缺失或不匹配返回 403。
- 请求体上限 64 KiB（`DefaultBodyLimit`），避免大 body 打满内存。

### 5.3 审计

`<data_dir>/webdesk-audit.jsonl`，一行一个 JSON 对象，只追加：`ts` / `ts_ms` / `action` / `actor` / `ip` / `ok` / `detail`。
当前动作：`service.start`、`service.stop`、`login.success`、`login.failure`、`login.blocked`、`session.logout`、`agent.chat`。Agent 审计仅记录 actor、时间、provider/model、消息长度和轮数，不写入 prompt、对话正文或 Key。
审计写入失败只打印到 stderr，**不会**让请求失败（与桌面端 vault 审计一致的取舍）。当前动作包括登录/会话和 `files.list` / `files.preview` / `files.download`；`/api/audit` 只回读末尾 256 KiB。

### 5.4 网络暴露

- 默认监听 `0.0.0.0:8787`（局域网可达），可用配置或 `DEPDEK_WEBDESK_BIND` 改为 `127.0.0.1:8787`。
- **本版本是明文 HTTP**：请只在可信局域网使用，或在前端放一层反向代理终止 TLS：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header X-Forwarded-For $remote_addr;   # 登录限流按真实来源计
}
```

- 配了 `tls_cert` / `tls_key` 时服务会启动并**明确警告**当前需要反代终止 TLS，而不是假装已经在加密。内置 TLS 终端是路线图第 1 项。
- `--insecure-no-auth` 只用于本机调试：UI 顶栏与状态栏会打「无认证」标记，审计里也会记录。

### 5.5 权限

Webdesk 本身不需要 root：只读 `/proc`、`/sys`，写自己的 `data_dir`，并只读显式授权的 `files_root`。生产部署应把 `files_root` 指向专用共享目录，并确保服务账号只有读取权限；无认证调试模式下文件 API 一律禁用。
`deploy/depdek-webdesk.service` 用 `DynamicUser=yes` + `ProtectSystem=strict` + `ProtectHome=read-only` 等限制，加入 `depdek-agent` 组访问聊天 socket，并加入 `depdek-webdesk` 组访问仅提供 Provider 配置的受限 socket。独立 `depdek-agent` 使用专用系统用户、`ProtectHome=yes`、私有临时目录与最小环境；Harness 的 API Key 只从 `/etc/depdek/agent.env` 注入。密钥在用户提交时会经 Webdesk 内存短暂转发给 root 配置 broker；Webdesk 不读取密钥文件、不持久化、不回显或记录密钥。dsh 使用 120 秒超时、并发上限 2、请求/响应大小上限，并禁用文件、shell、Web、sub-agent/workflow 工具。用户每轮需单独确认云端外发；语音输入调用浏览器 Web Speech API，需 HTTPS/localhost 并由浏览器申请麦克风权限。识别音频是否发送到浏览器供应商服务取决于浏览器实现；Webdesk 不会上传原始音频，但识别出的文本也不会自动发送给 DeepSeek。

## 6. HTTP API

除文件下载外，响应为 JSON；未鉴权访问受保护接口返回 `401 {"error": "..."}`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 存活探针：版本、运行时长、采样数、是否配了密码、是否 TLS |
| GET | `/api/session` | 否 | 当前会话（`authenticated` / `user` / `csrf` / `version` / `tls`） |
| POST | `/api/login` | 否 | `{"password": "…"}`，成功写 Cookie，失败 401/429 |
| POST | `/api/logout` | 是 + CSRF | 注销当前会话并清 Cookie |
| GET | `/api/system/summary` | 是 | 设备、CPU、内存、磁盘、网络、应用、进程数 |
| GET | `/api/system/series?window=N` | 是 | 最近 N 个采样点（默认 120，上限 2000） |
| GET | `/api/system/disks` | 是 | 挂载点与磁盘吞吐 |
| GET | `/api/system/network` | 是 | 网卡速率与累计流量 |
| GET | `/api/apps?limit=N` | 是 | 每应用聚合（CPU/内存/IO/PID） |
| GET | `/api/processes?sort=cpu\|mem\|disk&limit=N` | 是 | 进程明细，默认 50 |
| GET | `/api/audit?limit=N` | 是 | 审计日志尾部（默认 50） |
| GET | `/api/files?path=相对路径` | 是 | 浏览配置根目录；最多返回 500 项，忽略隐藏文件与符号链接 |
| GET | `/api/files/preview?path=相对路径` | 是 | 预览允许类型的 UTF-8 文本，单文件上限 256 KiB |
| GET | `/api/files/download?path=相对路径` | 是 | 下载配置根目录内普通文件，最大 4 GiB；流式传输 |
| GET | `/api/agent/status` | 是 | 独立 Agent 服务连接与配置状态（不返回 API Key） |
| POST | `/api/agent/chat` | 是 + CSRF | `{agent?, message, history}` 有界文本；`agent` 可为 `wukong` / `bajie` / `master` / `shaseng`，缺省 `wukong`；服务端审计元数据但不记录正文；交由 `depdek-agent`/DeepSeek Harness 单轮执行 |
| GET | `/`、静态资源 | 否 | 内嵌 SPA；未知 `/api/*` 返回 JSON 404，不会被 SPA 吞掉 |

## 7. 前端

- **桌面（`DesktopShell`）**：以桌面图标启动应用，以可并存的浮动窗口展示详情；窗口支持最小化到 Dock、最大化/还原，并可拖动右下角缩放。Dock 可恢复最小化窗口或切换前台。
- **Agent Team（`apps/Agent`）**：桌面图标打开默认的“西游协作室”，左侧可切换悟空、八戒、师傅、沙僧并查看服务/忙闲状态；中间是各角色独立的会话记录、Markdown 回复与文字/语音输入；右侧可收起和拖动调整宽度的交互面板，从最新回复提取线索，并将跟进问题填入草稿，不代替用户执行动作。四个角色共享同一个隔离的 `depdek-agent`/DeepSeek Harness 执行器，仅 system prompt 人设不同；每轮发送前单独确认。语音识别可能由浏览器供应商服务处理音频，识别结果只进入草稿。
- **性能监控小窗（`PerformanceWidget`）**：常驻桌面的紧凑浮窗，呈现 CPU / 内存、近期 CPU 趋势、每核占用、网络与磁盘实时速率及资源占用热点；支持最小化、最大化/还原、右下角缩放、从 Dock 恢复，或展开完整「性能监控」应用。
- **拖动体验（`FloatingWindow`）**：使用 Pointer Events 与 `requestAnimationFrame` 批量直接更新 `translate3d`，拖动过程中不逐帧触发 React 渲染；松手时才提交位置并保存到浏览器本地。位置随视口变化约束在桌面可视区内，也支持聚焦标题栏后按住 `Alt` + 方向键移动（`Shift` 加速）。
- **存储空间应用**：按挂载卷展示容量、已用/可用空间与空间偏紧状态；卷合计不代表物理盘容量（共享容器可能重复）。DepDek 桌面通过只读 `storage_summary` 读取本机挂载卷，Webdesk 通过已有受保护的 `/api/system/disks` / `/api/system/summary` 展示同一主机的独立采样。两端均不扫描文件内容，不提供分区写操作。
- **文件管理应用**：Webdesk 通过 `files_root` 沙箱目录浏览文件夹、按当前目录名称筛选、预览小型 UTF-8 文本并下载文件；操作记录在 Webdesk append-only 审计日志。此版本只读，不允许创建、上传、移动、改名或删除；不跟随符号链接，也拒绝越出根目录的路径。
- **其他应用**：概览（设备事实 + 全部指标卡片）、性能监控（2/4/10 分钟窗口）、进程与占用（应用聚合 + 进程表，可排序/搜索）、网络接口、审计与关于。
- 轮询：`series` 2s、`summary`+`apps` 3s、进程表 3s（仅在该应用打开时）。
- 图表是手写 SVG（`components/charts.tsx`），不引入图表库；桌面端打包产物约 184 kB JS / 24 kB CSS（gzip 约 59 / 6 kB）。
- `?demo=1`（或 `VITE_WEBDESK_DEMO=1`）用 `demo.ts` 的示例数据渲染整套界面，用于纯浏览器评审与截图；`webdesk/scripts/screenshot.sh` 分别截取桌面与完整性能应用。

## 8. 构建、发布与版本

```bash
# 前端（产物 webdesk/web/dist）
npm --prefix webdesk/web install && npm --prefix webdesk/web run build

# 服务（把前端编进二进制）
cd webdesk && cargo build --release        # 产物 webdesk/target/release/depdek-webdesk

# 生成密码并配置
webdesk/target/release/depdek-webdesk hash-password
cp webdesk/webdesk.example.toml /etc/depdek/webdesk.toml && $EDITOR /etc/depdek/webdesk.toml
webdesk/target/release/depdek-webdesk check-config --config /etc/depdek/webdesk.toml
webdesk/target/release/depdek-webdesk serve --config /etc/depdek/webdesk.toml
```

版本号来自仓库根 `VERSION`：`webdesk/build.rs` 把它编成 `DEPDEK_VERSION`（`/api/health`、登录页、桌面均显示），`webdesk/Cargo.toml`、`webdesk/Cargo.lock`、`webdesk/web/package.json` 由 `npm run version:bump` 一并同步。

## 9. 测试

```bash
cd webdesk && cargo test                       # 35 个单测：含文件沙箱路径/预览/下载校验
bash webdesk/scripts/e2e.sh                    # 26 项端到端断言（真实 HTTP + 真实 /proc）
bash webdesk/scripts/screenshot.sh             # 无头 Firefox 截图到 design-qa/webdesk-<日期>/
```

e2e 覆盖：健康检查、未登录 401、未知 API JSON 404、SPA 可访问、错误密码 401、正确密码成功、Cookie 属性（HttpOnly / SameSite）、摘要与内存/应用非空、series 有采样、进程按内存排序、应用聚合、审计含登录、CSRF 缺失 403、登出 200、登出后 401、连续失败 429、审计含失败与登出。

## 10. 路线图

| 阶段 | 内容 |
|---|---|
| 1（当前） | 登录、桌面窗口管理、文件只读浏览/下载、概览、性能监控、进程与每应用占用、存储/网络只读、审计视图 |
| 2 | 内置 TLS 终端（自签 + 上传证书）、磁盘 SMART、温度/风扇、告警阈值与通知、移动端布局打磨 |
| 3 | NAS 能力：共享目录、快照、备份任务；全部写操作二次确认 + 审计 + 逐项能力授权 |
| 4 | systemd 服务管理（启停/重启，白名单单元）、日志查看器、软件更新（签名校验 + 回滚） |
| 5 | 多用户与角色（管理员/只读）、API Token、会话设备列表与远程注销 |
```
