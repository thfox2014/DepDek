# R1 第四批：受限 Worker 只读委托与 Provider 引用检查

本批继续单空间、同非 root uid、私有 Unix socket 的开发切片。不是生产分 uid Worker 隔离、Model Gateway、API Key 租约或旧客户端主写切换；不启动模型、不新增业务写入、不迁移用户配置。

同 uid 进程仍属于受信 owner，OS 本身不能阻止该用户读取自己的文件/控制 socket。本批票据约束的是受信 Adapter 的协议调用，不抵御恶意同 uid 进程；因此不把它接到非可信 Agent/浏览器，不宣称生产 Worker 沙箱完成。分 uid、受限独立通道/网络与挂载隔离仍是发布门。

## Worker 通道

业务用户先登录，通过 session + CSRF 明确委托一个短期文件查询任务。Worker 只拿本次 `lease_token`，不拿用户密码、session/CSRF、API Key 或数据根路径。目录授权、委托签发/撤销、调用计数及返回前复验全部在 Vault 内实现。

| RPC | params | result.data |
|---|---|---|
| `v2/delegated.worker.issue` | session_token, csrf_token, workspace_id, scope | run_id, lease_token, expires_in, max_calls, commands, paths, purpose:file-query |
| `v2/delegated.worker.revoke` | session_token, csrf_token, workspace_id, run_id | revoked:true |
| `v2/worker.invoke` | lease_token, workspace_id, run_id, call_id, command, command_version, input | completed + result + remaining_calls + freshness:live |

`scope={paths:string[],commands:[file.read|file.list|file.stat],ttl_seconds?:60,max_calls?:8}`。TTL 1–120 秒、调用 1–32 次、路径 1–16 个、总租约最多 64 个。路径必须是业务用户目录的子集，禁止根、父范围、内部资产和 symlink；不能只凭命令名称/调用方自称角色授予权限。

run_id 与 256-bit 随机 bearer 由服务生成，内存只存 bearer 摘要；与签发业务 session、workspace 和权限代际绑定。用户注销/过期、显式撤销、daemon 重启均使租约失效。Worker 查询不会延长父 session。合法租约的调用尝试消耗次数，重复 call_id 返回 CONFLICT，不能用重放绕过预算；这是查询通道，不声称具有写入幂等回执。超过 TTL 或父会话失效后不返回数据，即使 I/O 已开始。

签发审计成功后才安装/释放 token；调用先持久审计意图，再扣预算、执行受管读和持久完成审计。审计故障不返回内容或新租约。路径读取仍遵守现有 128 KiB、100 条、symlink/hardlink/no-follow 与内部资产隐藏规则。审计不含 bearer、密码、CSRF 或文件正文。

## 控制 Profile

可信启动配置可选 `provider_profiles`，默认空。每项只保存 id/name/base_url/protocol/model、profile_revision、credential_ref、credential_revision、credential_binding；禁止 api_key/password 字段。采用固定 OpenAI-compatible 协议标签，HTTP 仅允许 IP 回环或 localhost，远端须 HTTPS；禁止 URL userinfo/query/fragment。**这里不做 DNS/连接验证，也不启用出站请求。**

`v2/providers.list {workspace_id}` 仅供已验证本机 owner 控制面读取；不进入通用 Command Manifest、Worker 或 Webdesk 业务代理。返回 Profile 元数据和动态 credential_state（stored/locked/not_initialized/unavailable/not_found/revoked/binding_mismatch/revision_mismatch），使用 Secret Store 既有脱敏 List 检查引用、用途和 revision。始终 `model_execution_enabled:false`、`connection_verified:false`，不把“凭据存在”冒充模型连通。

Profile 存在时启动配置必须位于数据根外、私有 0600、不可别名，使用既有 Vault 控制文件守卫。Profile 只读注册，更新需可信操作员变更配置并重启；不自动改现有 `/etc/depdek/agent.env` 或桌面 AES 凭据。R1 Argon2/XChaCha 与旧 AES 格式保持独立，不能混称已迁移。

## CLI 与验收

`depdek providers --workspace ID` 返回上述元数据；`depdek auth login|session|logout --stdin`、`depdek worker issue|revoke|invoke --stdin` 从有界 stdin JSON 接收密码/token，拒绝 --input/秘密 argv。登录/签发的 bearer 仅在受信终端响应中一次提供，调用方负责将其交给对应 Worker，不放进日志、文件索引或模型上下文。

`depdek-worker --socket PATH` 为独立受信子进程客户端：stdin 接收一行有界 WorkerCall（包括 workspace_id），只转发固定 `v2/worker.invoke`，stdout 为 NDJSON 响应，无法从此客户端选择 owner/凭据/任意 RPC 方法。它不是 dsh/Pi 引擎，也不是文件系统/网络沙箱。

本批验证目录扩大/跨用户/内部路径/别名拒绝；TTL/次数/重放/注销/显式撤销/重启拒绝；并发不能突破额度；审计故障无 token/内容；Profile 引用不存在、锁定、错误用途、轮换和撤销准确报告，输出无密钥。生产 OS 隔离、受控 Gateway 的真实 Key 使用/租约排空、持久 Profile 写入、Adapter 和真实迁移恢复仍为后续发布门。
