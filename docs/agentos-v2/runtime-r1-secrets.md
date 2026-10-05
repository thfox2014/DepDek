# R1 第二批：本机加密凭据管理契约

> 2026-10-04；VERSION 仍为 0.2.0。这是已实现的可选本机切片，不是完整 Secret Broker、HTTP API 或真实配置迁移。正式入口登记见 [contract §10](../contract.md#10-agentos-r1-第二批可选本机-secret-store)，基础身份/传输见 [第一批契约](runtime-r1.md)。

## 1. 边界和启用

`depdekd` 新增一个独立凭据库；默认禁用。旧桌面/sidecar/agent-service/Webdesk 不变，不读取现有 Home 或 `/etc/depdek/agent.env`。这些旧入口的明文债务仍存在，不能宣称全产品已经加密。

可信操作员使用 [含凭据目录的配置示例](../../services/depdekd/config.secrets.example.json) 指定 `secret_dir`：

```json
{
  "workspace_id": "family-demo",
  "root": "/srv/depdek/demo-workspace",
  "read_paths": ["documents"],
  "socket": "/run/user/1000/depdekd/command.sock",
  "secret_dir": "/srv/depdek/credentials/family-demo"
}
```

路径/uid 必须改为实际运行账号。`secret_dir` 必须预先存在、属于同一非 root 账号、末级非 symlink、group/other 无权限（通常 0700），与业务 root 双向无包含关系。服务不创建凭据目录、不 chmod 既有目录、不扫描家目录。配置 JSON 不放密钥或主密码。

所有凭据文件操作仅由 `vault.rs::SecretFiles` 执行：持有目录 fd、nofollow、单硬链接 regular file、owner 与私有权限检查；文件新建模式 0600。`.secret-store.lock` 的非阻塞独占 flock 保证同一目录只有一个合作的写入者。目录/文件权限失败会拒绝操作并清除已解锁状态。

同 uid/内核/可信本地文件系统仍是信任假设；不是防 root、恶意同账号进程、bind mount 或物理磁盘攻击的完整方案。不要把本机 socket 暴露给网络或直接作为 Webdesk 用户认证。

## 2. 加密与生命周期

| 项 | 实现 |
|---|---|
| 主密码 | 显式输入；至少 12 字符、最多 1024 UTF-8 字节、禁止控制字符；不保存主密码 |
| 派生 | Argon2id v19，m=65536 KiB、t=3、p=1，随机 16 字节 salt，32 字节内存密钥 |
| 密文 | XChaCha20-Poly1305，每次提交新随机 24 字节 nonce；AAD 绑定格式、workspace 与 salt |
| 快照 | 凭据、绑定、revision、操作摘要和回执整体加密；磁盘只有格式/workspace/salt/nonce/ciphertext envelope |
| 锁定 | 重启必锁定；显式 lock；空闲 300 秒，请求前检查和 daemon 每 5 秒检查 |
| 解锁失败 | 错误主密码/认证失败返回 UNLOCK_FAILED；进程内 2 秒冷却，不等于抗同 uid 离线破解 |
| 内存 | SecretText Debug 脱敏，敏感字段/派生密钥/关键缓冲区使用 zeroize；不承诺消除解析器副本、swap、core dump 或浏览器内存 |

选用维护中的 RustCrypto 实现，不自写密码算法：[argon2](https://docs.rs/argon2/latest/argon2/)、[chacha20poly1305](https://docs.rs/chacha20poly1305/latest/chacha20poly1305/)、[zeroize 的限制说明](https://docs.rs/zeroize/latest/zeroize/)。本项目接线与文件恢复尚未经过独立密码学审计。

没有自动解锁、Keychain/TPM、主密码轮换或忘记主密码恢复。凭据撤销只清空当前快照的值，不安全擦除旧密文、快照或备份；也没有可信单调计数器阻止旧密文回滚。启用真实材料之前，必须先完成备份/恢复、Worker 租约和客户端切换门。

## 3. 专用 RPC（不向 Agent 注册）

沿用同 uid Unix JSON-RPC 2.0，params 统一 `{workspace_id, input}`；不接受 actor/role，拒绝未知结构字段。响应使用第一批 envelope，以下为 `result.data` 内容；**不存在 get/export/取秘密值接口**。

| method | input | data |
|---|---|---|
| `v2/credentials.status` | `{}` | initialized / locked / idle_lock_seconds / runtime_enabled:false |
| `v2/credentials.init` | operation_id, passphrase | initialized 回执；已有文件一律拒绝覆盖 |
| `v2/credentials.unlock` | passphrase | locked:false，runtime_enabled:false |
| `v2/credentials.lock` | `{}` | locked:true |
| `v2/credentials.list` | `{}` | credentials 元数据数组，必须解锁 |
| `v2/credentials.put` | operation_id, binding, expected_revision, secret | stored 回执与 CredentialRef/revision |
| `v2/credentials.revoke` | operation_id, credential_ref, expected_revision | revoked 回执与新 revision |
| `v2/credentials.receipt` | operation_id | 原操作回执；无回执返回 CONFLICT，不表示外部任务失败 |
| `v2/credentials.import.preview` | `{settings?, mail?, calendar?}` | bindings / conflicts / skipped_empty_keys；不写密文 |
| `v2/credentials.import.apply` | operation_id, sources | staged / mappings / source_unchanged:true / runtime_enabled:false / connection_verified:false |

`binding={kind, account_id, field}`；provider/api_key、mail/password、calendar/password 或 access_token。account_id 保留旧绑定（含中文），不做可能导致合并的隐式规范化；元数据不是容纳秘密的字段。

新绑定 `expected_revision=0`；更新/恢复已撤销绑定必须提交当前 revision。CredentialRef 为随机 `cr_…`，同一绑定轮换保持引用、增加 revision。撤销也增加 revision。相同 operation_id 与输入重放返回原回执；同 ID 不同输入、过期 revision 或导入撞绑定均返回 CONFLICT。撤销之后查询历史保存回执仍返回历史状态，当前状态以 list 为准。

预算：请求 64 KiB、secret 8192 字节、128 个绑定、512 个历史操作、明文快照 1 MiB/密文文件 2 MiB；达到上限拒绝，不自动删除历史。每类导入最多 32 个帐号/Provider。索引压缩/操作回执保留策略尚未实现。

专用错误包括 SECRET_STORE_LOCKED/NOT_INITIALIZED/EXISTS、UNLOCK_FAILED/COOLDOWN、SECRET_STORE_FORMAT_INVALID/UNAVAILABLE/BUSY、COMMIT_UNKNOWN，以及 INVALID_INPUT/FORBIDDEN/CONFLICT/LIMIT_EXCEEDED/AUDIT_UNAVAILABLE。错误消息为固定诊断，不包含源配置或系统原始错误；凭据错误 `retryable=false`，要求显式查证，不盲目重试。

## 4. 无回显 CLI

```bash
# 同一非 root owner；主密码从隐藏 TTY 输入，不进 argv/env 或历史
depdek --socket /absolute/private/runtime/command.sock credentials init --workspace family-demo --operation init-001
depdek --socket /absolute/private/runtime/command.sock credentials unlock --workspace family-demo
depdek --socket /absolute/private/runtime/command.sock credentials list --workspace family-demo
depdek --socket /absolute/private/runtime/command.sock credentials receipt --workspace family-demo --operation save-001
depdek --socket /absolute/private/runtime/command.sock credentials lock --workspace family-demo
```

`put/revoke/import-preview/import` 使用显式 `--stdin` JSON；init/unlock 也允许该模式用于受控自动化。不要把真实值写在命令行 `echo`、`--input`、环境变量或终端历史里。stdin 可由受控密码管理器/迁移适配器提供；当前还没有 GUI 密钥表单或自动配置文件读取器。stdout 仅输出不含秘密的 JSON，TTY 输入采用 [rpassword](https://docs.rs/rpassword/latest/rpassword/)。

put stdin 形状为 `{operation_id,binding,expected_revision,secret}`。import-preview stdin **只有** `{settings,mail,calendar}`；apply stdin 为 `{operation_id,sources:{settings,mail,calendar}}`。合成夹具顶层的 fixture_only/contains_live_credentials 是测试标记，不是 RPC 字段，测试剥离后输入。

导入凭据结构兼容已知 Settings/邮件/日历字段，凭据结构的未知字段或重复帐号被拒绝；非凭据 SavedAgent 字段沿用旧反序列化兼容行为，不用于配置运行时。空 key 的兼容本地 Provider 跳过，不创建假凭据。URL 校验只检查 http/https、host 和无 userinfo/query/fragment，**不进行 DNS/连接/TLS 或授权验证**。导入只暂存秘密及原绑定，不保存可启用的连接 profile，不读取/更新/删除源文件。

## 5. 提交、审计与故障对账

每个进入 SecretStore 的管理请求：先持久写意图 → 处理 → 持久写完成/拒绝 → 才返回。审计单独存 `.secret-audit.jsonl`，沿用 AuditEntry，op 为管理 Write、path 为固定操作名，session 带服务生成的身份/请求 ID；不记录绑定、操作 ID、秘密或输入摘要。协议形状拒绝与定时内存自动锁定事件尚未接入统一安全审计，不能宣称已覆盖所有安全事件。

变更先生成完整加密快照，写随机 0600 暂存文件并同步 → 同目录原子 rename → 同步目录 → 替换内存状态；操作账本与凭据同一快照。审计与快照不是跨文件原子事务：审计完成条目缺失时不能推断提交未发生。

- rename 前失败：旧快照不变；保留仅含密文的 stage 文件，不自动清理证据。
- rename 后目录同步结果不确定：COMMIT_UNKNOWN，清除内存解锁状态；需要受控重启、解锁、查原 operation_id。
- 完成审计失败：不返回成功、锁定且审计流故障拒绝后续操作；保留故障日志并受控恢复后对账。密文可能已提交，不能生成新 ID 重做。
- 超时/断连不会取消已开始的阻塞操作；15 秒超时之后提交仍可能完成。重连先查原回执，再以原 ID/原输入处理，不把“没收到响应”当作“没写入”。
- 初始化响应丢失时，已有文件不会再初始化覆盖；正确路径是解锁并查初始化 ID。

实际机器掉电、损坏日志修复、磁盘写满、N3160 解锁耗时和 Linux 文件系统行为仍需真机验收；注入测试不能代替断电实验。

## 6. 下一批接线门

1. 可信浏览器身份委托、workspace ACL 与协议安全事件审计。
2. 仅授予受限 Worker 的短期 Credential Lease 与撤销/轮换排空；不提供 Agent/浏览器取值。
3. 旧配置读取的显式授权、恢复备份、profile 引用切换与真实连接验证；验证后才清旧明文字段。
4. 平台解锁/恢复、日志轮转/保留与真实 Linux 验收。

测试及实施边界见 [第二批实施记录](implementation-status-batch2.md)。
