# Jiaho AI-OS 首启登录与配置体验

本切片只适用于 `VITE_DEPDEK_OS=1` 编译的本机 Tauri appliance。它是本机桌面空间登录，不替代 R1 的业务会话、Webdesk admin 或 Linux 账号，不改变两种 Engine 的授权规则。

## 启动路径

Debian GRUB 品牌画面 → Plymouth 品牌画面 → LightDM 启动普通本机桌面会话 → AI-OS 登录。首启创建本人账号，后续输入密码登录。`depdek-shell` 保留手动入口；GRUB 恢复项进入命令行。Live 介质未启用持久化时，账号与积分随 Live 会话消失；安装到磁盘后保存在用户应用数据目录。

## 原生 IPC（Rust / React）

| Tauri command | 参数 | 返回 |
| --- | --- | --- |
| `ai_os_status` | 无 | `enabled, initialized, authenticated, username, configured, balance, grant_points, chat_cost, model_ready, preferences` |
| `ai_os_register` | `username, password` | status；只允许首个本机账号，自动登录 |
| `ai_os_login` | `username, password` | status；第一次成功登录原子赠送 1,000 配置积分 |
| `ai_os_logout` | 无 | 退出；锁住旧 Vault 文件入口 |
| `ai_os_chat` | `operationId, prompt` | `reply, balance, operation_id, model, local` |
| `ai_os_complete` | `displayName, language, purpose` | status；保存初始偏好并进入工作台 |

账号、权限、积分与所有持久化检查位于 Vault 内部 `welcome` 模块。密码 Argon2id PHC；没有通用默认密码。首启积分同账号原子保存，重复登录、重启不重复赠送。配置对话一次 10 积分，扣费与 operation_id 绑定；同 ID 同输入返回原回执，改输入冲突。调用前持久化占用，超时/崩溃不盲目重发；已知失败退还积分。前端不提交余额、角色、模型地址或积分数量。

默认模型是镜像随附的 Qwen2.5-0.5B-Instruct Q4_K_M，通过只绑定 `127.0.0.1:11435` 的 llama.cpp 服务运行，别名 `jiaho-setup`。默认配置助手没有文件、Shell 或外部工具，且不接收 Home 自动上下文。首启模型出口只允许固定数值回环，禁代理/重定向/自动重试，输入及响应有界。它是本地配置体验积分，不是商业云端预付余额；后续可在已有 Provider 页面显式配置云端模型。

首启偏好仅保存显示名称、助手交流语言和使用方向；AI 提供建议，实际保存由用户点击完成。初次进入时自动登记本地默认模型，已有 Provider 和数据目录不覆盖。所有更改属于本机登录空间，不给 Agent Linux 管理权限。AI-OS 登录门禁同样适用于团队、审批、定时任务与 MCP 控制入口；正常桌面构建不启用该门禁。

## 持久化与验收

`.jiaho-onboarding/` 在应用数据目录内，目录 0700、文件 0600、fd-relative/no-follow、拒绝硬链接、flock 单写者、fsync + rename 原子快照。审计不记录密码、哈希、用户提示词和模型回复。重启清除登录态。

需验证：首次赠送/重复登录/重启不增发、错误密码限速、未登录不能读取旧 Vault、积分不足/重复 operation_id/并发、模型失败与重试、私有文件 symlink/hardlink/权限检查、Plymouth 与默认图形启动、真实本地模型返回、首启配置持久化。合成 HTTP 测试不等于真实模型验收。
