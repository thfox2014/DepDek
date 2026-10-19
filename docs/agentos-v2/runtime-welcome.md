# Jiaho AI-OS 首启登录与配置体验

本切片只适用于 `VITE_DEPDEK_OS=1` 编译的本机 Tauri appliance。它是本机桌面空间登录，不替代 R1 的业务会话、Webdesk admin 或 Linux 账号，不改变两种 Engine 的授权规则。

## 启动路径

Debian GRUB 品牌画面 → Plymouth 品牌画面 → LightDM 启动普通本机桌面会话 → AI-OS 登录。首启创建本人账号，后续输入密码登录。`depdek-shell` 保留手动入口；GRUB 恢复项进入命令行。Live 介质未启用持久化时，账号与积分随 Live 会话消失；安装到磁盘后保存在用户应用数据目录。

首启顺序为 **网络 → BitBay 邮箱账户 → 大模型 → 工作模式 → 悟空协作室**，不展示自由聊天输入框。网络页打开即检测，不依赖账户登录；账户页以 BitBay 邮箱注册为主入口，按下述已核对的真实平台接口发送验证码/注册/登录；既有本机账户解锁放在独立折叠区，不把本机注册冒充平台身份。模型页可选择已就绪的镜像本地助手、已有 Provider，或新增 OpenAI Chat Completions 兼容 Provider（显示名称、服务地址、模型 ID、可选 API Key）；最后在工作模式页确认联网模式或本地模式。此流程复用 `settings_get/set`、`vault_init_home/set_root`、`agent_analyze`，配合下文受控首启命令。先建立 Home 再重新读取 Settings，保留更新后的 `last_root`、原有 Provider 和其他 Agent，首启只绑定 `depdek-os-assistant`；进入协作室后再按下文创建未授权工具的伙伴。

保存不等于连通：测试仅在用户点击后调用 `agent_analyze`，发送一条固定测试文本，无文件、工具或 Home 自动上下文；不自动测试或重试。自定义/已有非内置模型须显式确认允许把固定测试文本发送给显示的服务，可能产生服务商费用。只保存不要求勾选测试同意，也不消耗配置积分或模型 Token。原 `ai_os_chat` 固定回环/积分接口保留兼容，不再在首启 UI 中使用；不宣称有云端赠金。更换模式重置未保存的模型选择/测试状态，不携带历史或自动测试。

API Key 只在输入表单内短暂驻留，经现有 `settings_set` 加密为 `$secret:` 引用，保存后清空；已有凭据只显示“已保存”，不填回输入框，不写浏览器存储。服务地址要求 HTTPS（数值回环/localhost 可 HTTP），禁止 URL 中携带凭据、查询串和 fragment；这是表单输入约束，不代替 Vault/核心的安全校验。首启模型配置不是系统管理员或 R1 Gateway 授权。

## 四步首启向导与 AI 连接模式（2026-10-18）

首启 UI 改为 **网络 → 账户 → 大模型 → 工作模式 → 悟空**，不再把自由聊天作为必经配置步骤，也不由模型生成“已配置”报告。2026-10-19 修正网络步骤的登录死循环：未登录也可调用下面两个网络命令，仍在 WelcomeVault 内审计，不解锁 Home、设置、模型或 Agent 权限。打开网络页即执行一次只读连通检测，已联网显示“已联网”，无可用接口显示“未联网”，有接口但探测失败显示“尚未确认联网”（可能为认证网络或探测被阻止），不把网卡有 IP 等同于互联网可用。非在线结果只自动打开一次固定 Wi-Fi 设置入口；返回应用、浏览器 online/offline 事件或手动刷新会复查，不后台轮询、不反复弹出设置。

按用户要求，检测改用已部署的 BitBay 公共登录接口 `POST https://api.bitbay.site/v2/user/login`，固定发送空 JSON `{}`；服务端 `ShouldBindJSON` 在访问数据库或校验账户前返回缺少必填字段的 `HTTP 400 / code:400 / message:请求参数错误`。该响应说明公共接口真实可达，不是用户登录失败。检测不携带邮箱、验证码、密码或 Token，不发送验证码、不注册/登录任何账户。总超时 3 秒、连接超时 2 秒、响应最多 1 KiB；无重定向、自动重试、环境代理、Cookie、凭据或 Home 数据；同进程串行并缓存 5 秒。此处“已联网”只证明 BitBay 公共接口可达，不保证模型或邮件投递可用；有接口但检测失败也可能是 BitBay 暂不可用，不武断声称设备断网。网络详情仅在展开时显示有界接口信息。探测同样不代表 AI 本地模式允许云模型。

账户页主入口为“使用邮箱注册 BitBay”，输入使用 email 类型，不复用本机 username 校验或 `ai_os_register` 冒充远端注册。2026-10-19 根据用户指定的 `OPC0608-wechat` 项目，核对 `opc-aicom/docs/independent-site-frontend-auth.md`、`docs/dramaforge-external-integration.md`、`docs/independent-site-tools.md` 及 `backend/internal/handler/{email,user,router_v2}.go`：公网域名 `https://api.bitbay.site`，统一使用公开 `/v2` 的真实邮箱验证码、平台注册及登录接口（不带租户 slug）。旧 `/api` 只为兼容入口，本客户端不自动回退；不使用文档自述尚未部署的 PaaS `/v1/tenants/...` 草案或任何管理员接口。只有用户勾选说明并点击发送/提交时才携带账号资料，不在页面打开时发送邮箱或自动注册。Wi-Fi、IP/DNS、代理配置由操作系统完成，不接收 Wi-Fi 密码，不赋予 Agent 网络管理权限。

第 4 步的“联网模式 / 本地模式”是 **AI 模型路由选择**，不是系统断网开关，不影响邮件、MCP、R1 或其他应用的联网授权。缺省为 `online`；`online` 允许显式选择云端或本机模型；`local` 仅允许 HTTP(S) 数值 loopback Provider（`127.0.0.0/8`、`::1`，无 URL 用户信息、查询或 fragment），拒绝域名、LAN、默认云端和 Anthropic Provider。Core 在解密 Key / 向 sidecar 分发前校验，前端也过滤选项；不把它宣传为防火墙、代理/重定向隔离或独立进程 egress 保证，本机模型服务本身仍需可信。

模式保存在受保护首启 Snapshot，旧记录缺失时兼容 `online`。修改需要登录并持久化审计；一次模型测试期间切换需等待测试完成；首次持久 Agent 会话创建尝试起，模式在本进程锁定（创建失败也不自动解除），需重启应用后在登录页修改，避免现有后台会话越过模式切换。新命令不注册为 Agent/R1/sidecar 工具：

| Tauri command | 参数 | 返回/行为 |
| --- | --- | --- |
| `ai_os_set_connection_mode` | `mode: "online" \| "local"` | status，含 `connection_mode`；未登录拒绝；工作区已启动返回 `CONNECTION_MODE_LOCKED` |
| `ai_os_network_status` | 无 | `platform, interfaces: [{name, addresses}], settings_available, connectivity: "online" \| "offline" \| "limited"`；首启登录前可用；仅固定 HTTPS 探测，审计不得写接口地址 |
| `ai_os_open_network_settings` | 无 | 首启登录前可用；打开固定的系统 Wi-Fi 设置入口（macOS Wi-Fi；Linux 可用的桌面 Wi-Fi/连接管理器），无 shell/任意 argv；不代用户修改网络 |
| `ai_os_bitbay_send_code` | `email` | `{sent: true, retry_after_seconds: 60}`；POST `/v2/email/send-code` 的 `{email}`；丢弃开发模式 code，不把验证码返回 UI；本进程冷却 60 秒 |
| `ai_os_bitbay_register` | `email, code, password` | status；POST `/v2/user/register` 的 `{email, code, password}`，要求 `code:0` 和正整数 `data.userId`；注册密码 12–20 UTF-8 字节（平台 6–20 与本机至少 12 的交集） |
| `ai_os_bitbay_login` | `email, password, localPassword?` | status；POST `/v2/user/login` 的 `{username:email,password}`，要求有效 userId 与返回 username 匹配；首次导入弱于 12 字节的既有平台密码，必须单独提供至少 12 字节的本机空间密码 |

BitBay 命令只在无本机账户的首启或已有本机空间已解锁时使用；旧空间未解锁时拒绝，不能凭另一个平台账户替换既有 Home。绑定前检查输入并先写 durable intent 审计，再做单次固定 HTTPS 请求；禁止调用方指定 URL、环境代理、重定向、Cookie Jar、自动重试，连接超时 5 秒、总超时 15 秒，响应最多 64 KiB。只解析必要回执，不返回平台 Token/Matrix Token，不保存平台密码、验证码或 Token，不反射服务端错误消息。平台角色不转换成本机/Vault/R1/管理员权限。

注册/登录回执验证成功后才持久化 `bitbay: {email,user_id}`，首次空间的 username 使用该邮箱；本机解锁密码仅存 Argon2id 哈希。既有已解锁空间只增添绑定，不替换本机用户名、密码、偏好、Home 或任何 Agent；已绑定身份不可通过该入口替换。状态仅在本机已登录时返回 bitbay 元数据。平台操作和本机保存不是跨系统事务：超时或响应不完整返回 `BITBAY_OUTCOME_UNKNOWN`，平台成功但本机保存失败返回 `BITBAY_LOCAL_SAVE_FAILED`；均提示使用已有账号登录恢复，不自动重试注册。重启仍使用本机密码解锁，显示“已关联”不代表云端登录态仍有效。

`ai_os_status` 对外增加非敏感 `connection_mode`，未登录时也可读以保持已保存模式。`agent_create_session` / `agent_analyze` 增加上述本地模式校验；无 AI-OS 门禁的普通桌面构建不启用此限制。保存 Provider 不发送提示词，测试仅在用户明确点击且同意目标地址后进行。向导完成直接使用已有 `ai_os_complete` 保存账户偏好；原 `ai_os_chat` 积分接口保留兼容，但不再出现在首启自由聊天 UI。

## 悟空协作室（登录后的默认主界面）

完成首启偏好后及后续登录，默认进入 `DepDekAiOsShell` 的悟空三栏界面，不再展示旧黑底绿色 Shell。2026-10-18 收敛为单一悟空入口：左侧只显示悟空，不再自动补齐八戒、师傅、沙僧；中间为独立对话/草稿、Markdown 回复、滚动工具过程与本机语音输入，右侧为可收起/调宽的操作面板。旧角色及自定义配置/历史不删除，保留在完整工作台；AI-OS 启动仅自动恢复悟空会话，不自动启动这些保留角色。普通桌面启动逻辑不变。默认暖白浅色，可切换深色；小屏默认收起右侧面板。两种模式都显示版本，保留完整工作台往返入口。

悟空沿用 `depdek-os-assistant` ID 以保留历史；仅旧的内置配置助手名称/角色改为悟空，用户自定义角色、执行器、技能和数据目录不覆盖。新建悟空默认沿用已选择的模型，`enabled_skills: []`，不因出现头像或修改角色文案而获得工具权限。悟空可选择已有 Provider、Pi 或 DeepSeek Harness；模型弹窗使用同一加密配置与显式测试流程，保存后只更新当前 Agent 的绑定。已有同名 Provider 内容变化也需重建相关运行会话，不把保存状态伪装成连通状态。家庭资料理解与敏感保险箱目前是独立产品提案，见 [悟空家庭资料管家](../jiaho-wukong-family-steward.md)，不因本次角色收敛宣称已经实现。

右侧待确认项复用 `approval_list/decide` 与事件订阅，仅显示当前 Agent 的真实待审批卡；协作任务来自现有 Team 状态。自动提取的本轮线索及快捷提示只填写草稿，不发送、不执行动作。录音复用本机 Vosk `voice_transcribe`，30 秒上限，切换 Agent 时转写仍回填原 Agent，不使用浏览器云端语音兜底。主题偏好可写本机浏览器存储，密钥不可。此界面替换不新增权限、IPC 或 Webdesk 服务依赖。

## 原生 IPC（Rust / React）

| Tauri command | 参数 | 返回 |
| --- | --- | --- |
| `ai_os_status` | 无 | `enabled, initialized, authenticated, username, configured, balance, grant_points, chat_cost, model_ready, preferences, connection_mode, mode_locked, bitbay`（身份字段仅本机已登录时返回） |
| `ai_os_register` | `username, password` | status；只允许首个本机账号，自动登录 |
| `ai_os_login` | `username, password` | status；第一次成功登录原子赠送 1,000 配置积分 |
| `ai_os_logout` | 无 | 退出；锁住旧 Vault 文件入口 |
| `ai_os_chat` | `operationId, prompt` | `reply, balance, operation_id, model, local` |
| `ai_os_complete` | `displayName, language, purpose` | status；保存初始偏好并进入悟空 |

账号、权限、积分与所有持久化检查位于 Vault 内部 `welcome` 模块。密码 Argon2id PHC；没有通用默认密码。首启积分同账号原子保存，重复登录、重启不重复赠送。配置对话一次 10 积分，扣费与 operation_id 绑定；同 ID 同输入返回原回执，改输入冲突。调用前持久化占用，超时/崩溃不盲目重发；已知失败退还积分。前端不提交余额、角色、模型地址或积分数量。

默认模型是镜像随附的 Qwen2.5-0.5B-Instruct Q4_K_M，通过只绑定 `127.0.0.1:11435` 的 llama.cpp 服务运行，别名 `jiaho-setup`。默认配置助手没有文件、Shell 或外部工具，且不接收 Home 自动上下文。`ai_os_chat` 出口仍只允许固定数值回环，禁代理/重定向/自动重试，输入及响应有界。它是本地配置体验积分，不是商业云端预付余额；自己的模型可在聊天前显式配置，也可在工作台 Provider 页面调整。

账户偏好保存显示名称、助手交流语言和使用方向；由用户填写并点击完成，模型不参与配置判断。本地默认模型亦须用户选择保存，已有 Provider 和数据目录不覆盖。所有更改属于本机登录空间，不给 Agent Linux 管理权限。AI-OS 登录门禁同样适用于团队、审批、定时任务与 MCP 控制入口；正常桌面构建不启用该门禁。

## 持久化与验收

`.jiaho-onboarding/` 在应用数据目录内，目录 0700、文件 0600、fd-relative/no-follow、拒绝硬链接、flock 单写者、fsync + rename 原子快照。审计不记录密码、哈希、用户提示词和模型回复。重启清除登录态。

需验证：首次赠送/重复登录/重启不增发、错误密码限速、未登录不能读取旧 Vault、积分不足/重复 operation_id/并发、模型失败与重试、私有文件 symlink/hardlink/权限检查、Plymouth 与默认图形启动、真实本地模型返回、首启配置持久化。合成 HTTP 测试不等于真实模型验收。
