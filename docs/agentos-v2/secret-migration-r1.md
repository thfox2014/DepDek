# R1 凭据迁移：实现前验收设计

> 状态：第二批已实现独立本机 Secret Store、调用者提供 JSON 的预览/暂存导入及合成测试，见 [运行时契约](runtime-r1-secrets.md) 与 [实施记录](implementation-status-batch2.md)。完整迁移器、真实来源授权读取、租约、用户界面与引用切换尚未实现；契约 §7 的旧明文行为未改变。以下是完整迁移验收目标，不代表已全部通过。

## 1. 已确认来源

| 来源 | 现有字段/机制 | 迁移注意 |
|---|---|---|
| 桌面 `Settings.providers` | ProviderConfig 的 api_key，持久化在 tauri-plugin-store | provider_name 是既有绑定键，需稳定映射，不能因规范化重名覆盖 |
| Vault `mail/accounts.json` | MailAccount.password | 名称、用户、IMAP/SMTP endpoint 与引用保持；读取只由专门迁移入口授权，不向通用文件命令放开 |
| Vault `calendar/accounts.json` | password / access_token | 帐号 id 和权限范围保留；不能把 token 识别为普通日历内容 |
| agent-service config broker | `/etc/depdek/agent.env` 等专门配置写入 | root-only 文件不是生产加密；需确认 broker 与平台 Secret Store 的恢复/解锁职责 |

Rust 结构见 [settings.rs](../../src-tauri/src/settings.rs)，邮件/日历字段见 [当前契约](../contract.md)。普通配置最终仅存 CredentialRef，不能把秘密写入 knowledge、memory、索引、日志或模型提示。

## 2. 导入规则

一次导入对应 operation_id、源类型/摘要、目标 scope、CredentialRef 与 revision。源摘要不包含秘密的可逆编码，不返回秘密内容。支持 dry-run：仅列配置数量、作用域、冲突和迁移状态。

1. 用户显式授权读取指定旧配置，先建立受保护、可恢复的迁移备份；禁止扫描整个家目录。
2. 校验源形状、endpoint、帐号/provider 映射；空 key 的兼容本地 Provider 不创建假 CredentialRef。同名目标发生冲突先等待选择，禁止默认覆盖。
3. 登记操作意图；Secret Store 幂等写入并返回版本回执；崩溃后按 operation_id 查询状态，不能靠 UI 点击过保存判断成功。
4. 控制面确认回执后更新引用；运行时 broker 获取最小用途/短期租约，Agent 与浏览器没有读取秘密的 API。
5. 经明确的连接验证和回滚演练后，才清除旧配置的明文字段。失败保持旧引用与原配置，不出现“已 configured 但秘密缺失”。
6. 旧备份/旧 key 的保留与退役单独决策；不能声称从当前 JSON 去字段就已从历史备份或磁盘安全擦除。

首期需要分别验证 macOS 桌面与 Debian appliance 的存储/解锁模式。无 TPM 的 OS 必须有用户解锁路径；无人值守重启与数据解锁策略属于 R0/R5 决策，不允许用硬编码主密码绕过。第二批离线切片已选 Argon2id/XChaCha20-Poly1305，平台 Keychain/TPM 解锁与备份恢复仍需独立验证。

## 3. 合成测试夹具

[legacy-credentials.example.json](fixtures/legacy-credentials.example.json) 只含不可使用的示例字符串和 example.invalid 地址；不包含用户给过的真实 key 或部署密码。它是待接入导入器的输入，不是可启用的运行配置。

| 用例 | 必须结果（尚待运行时实现） |
|---|---|
| Provider/邮件/日历导入 | 引用对应原绑定；metadata/GET/错误/审计/CLI/事件/内存无秘密 |
| 空本地 key | 无不必要凭据；原 Provider 可继续无 key 本地调用 |
| 同 operation_id 重试 | 同一版本与回执，不新增记录/不重复删除原字段 |
| 同名 provider / 帐号 scope 冲突 | 等待用户决策，两个来源不静默覆盖 |
| Secret Store 成功、控制面更新前崩溃 | 重启对账后继续，不重复写入、不提前标成功 |
| 写入失败/锁定/存储满 | 不修改旧引用、不回显密钥；需要解锁时 waiting_unlock |
| 轮换期间已有租约 | 新任务用新版本，旧租约按策略排空；不能并发删除在用秘密 |
| 秘密删除或撤销 | 后续租约拒绝；普通检索和通用 file.* 不可读取任何秘密 |
| 备份/恢复 | 元数据与秘密回执一致；恢复完成前不执行外发任务 |

合成夹具的存在不代表以上完整迁移用例已通过。第二批已验证加密、无回显、幂等、整批冲突和故障对账；没有验证控制面更新、已有租约轮换、真实连接和备份恢复。只读 CLI 的内部文件过滤不能替代 Secret Store，也不能据暂存成功提前清理原始配置。
