# V2 重构实施记录：第二批

> 2026-10-04；VERSION=0.2.0，接续 [第一批](implementation-status.md)。仅本机开发和合成测试；没有读取或迁移真实凭据、修改部署机器、提交 Git 或启用云端模型。

本文为第二批验收快照；新增业务会话/BFF 与当前剩余项见 [第三批记录](implementation-status-batch3.md)。

## 1. 本批交付

完成 R1 的**可选本机加密凭据管理切片**，不是整个 R1 退出条件。

| 交付 | 实际范围 |
|---|---|
| SecretStore | Argon2id + XChaCha20-Poly1305；独立私有目录、明确解锁、空闲锁定、重启锁定 |
| 文件信任边界 | `vault.rs::SecretFiles` 集中权限/nofollow/硬链接/独占写锁/原子快照检查 |
| 无回显入口 | 专用 JSON-RPC + CLI 隐藏 TTY/显式 stdin；不提供 get/export，不注册 Agent 工具 |
| 凭据治理 | 稳定 CredentialRef、revision 条件更新、轮换、撤销、持久幂等回执 |
| 合成旧配置导入 | Provider/邮件/日历预览、空本地 key 跳过、整批冲突拒绝、只暂存且不改源 |
| 故障处理 | 写入前后故障、审计失败不报成功；锁定后按原操作 ID 查证 |
| 兼容 | 默认无 SecretStore；旧接口、客户端、Provider 保存与业务 writer 未切换 |

正式增量登记见 [contract §10](../contract.md#10-agentos-r1-第二批可选本机-secret-store)，完整参数、运行与恢复边界见 [凭据运行时契约](runtime-r1-secrets.md)。

## 2. 本批验证（macOS，非 root）

| 验证 | 结果 |
|---|---|
| Rust core，无 GUI | 60 单测 + 2 RPC 集成通过；其中新增 14 个 SecretStore 用例 |
| daemon + CLI | 9 集成测试通过；其中新增 3 个凭据/CLI 用例，真实启动进程 |
| daemon clippy | all-targets `-D warnings` 通过 |
| sidecar | build 与 90 测试通过；没有真实外发请求 |
| 根前端 | build 通过；原有大 chunk 警告保留 |
| release daemon/CLI | 本机 macOS 构建通过；不是 Linux 安装包或目标 NAS 验收 |
| 版本一致性 | 0.2.0，统一版本脚本通过 |
| 设计检查 | 22 操作、216 schema refs、11 SQL 约束用例通过；不是运行时 HTTP/DB 接入 |
| 严格 core clippy | 未通过：已有 obsidian/rpc/voice 的 3 个告警未在本批修复 |
| 真实本地模型 | localhost:8080/v1 不可达，测试自行跳过；不能将包装的 ok 当作模型验收 |

新增用例覆盖：磁盘/响应/错误/Debug/日志无合成秘密回显；锁定、冷却、重启、篡改认证、空间绑定、随机 nonce；幂等并发、revision 冲突、轮换与撤销；合成导入/空 key/重复帐号/无效端点/混合冲突不部分写入；目录权限/别名/硬链接/独占锁；rename 前失败保留旧快照、rename 后不确定对账；意图或完成审计失败均不返回成功。

CLI 集成另验证：无 --input 密钥输入、禁止 get、禁止 JSON 伪造身份、错误 workspace、服务默认关闭凭据、真实 stdin 导入、重启后解锁取原回执。测试不输出合成秘密原文，也不创建真实运行配置。

## 3. 明确未完成

- 旧 Provider/邮件/日历和 agent-service 仍保存原有配置；**没有自动清除明文**，没有把“暂存”标为“已连接”。
- 无可信浏览器委托、家庭多用户 ACL、Webdesk/Tauri Adapter 或 Credential Lease；不允许 Agent 读取秘密。
- 无 OS Keychain/TPM、主密码轮换/遗忘恢复、无人值守解锁、备份恢复或防旧密文回滚。
- 管理请求严格审计已实现；协议拒绝、定时锁定安全事件、轮转/保留/outbox 仍待完成。
- 故障注入不代替真实写满/断电/损坏文件恢复实验；Linux/N3160 解锁耗时、文件系统语义和 systemd 没有实测。
- 依赖官方密码库不等于整个接线已通过独立安全审计；zeroize 不保证秘密从所有 OS/解析器副本中消失。

## 4. 第三批建议顺序

先补可信身份委托与 workspace 注册/ACL，再做 Worker 短期凭据租约与控制面 profile 引用，接着接旧客户端 Adapter。真实迁移须先有授权读取、可恢复备份、连接验证和单写入者切换，不凭本批“保存回执”提前删除旧 key。

R0 的 Harness/Gateway/隔离门与 R1 的身份/租约/主写切换仍未关闭；家庭知识 DB、共享记忆新主写和领域行动继续按后续阶段推进。
