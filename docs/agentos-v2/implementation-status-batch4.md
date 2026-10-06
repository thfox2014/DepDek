# V2 重构实施记录：第四批

2026-10-05；VERSION=0.2.1，接续 [第三批](implementation-status-batch3.md) 与远端 v0.2.1 合并。只用合成临时空间；没有迁移真实凭据/资料、启用模型、切换旧主写、提交本批 Git 或部署 NAS。完整 R1–R5 仍未完成。

## 已实现的闭环

业务用户登录 → session + CSRF 显式签发目录子集/命令/次数/TTL 票据 → 独立受信 Worker 客户端 → Vault 只读查询与持久审计 → 结果；用户撤销/注销或进程重启后旧票据失效。

- `vault/access/workers.rs` 管理随机短期 bearer 的摘要索引、父会话、run、scope、调用预算。调用/撤销共享授权锁，读取前及返回前复验，Worker 不延长父 session。
- `depdek-worker` 是只提供一个固定 RPC 的 NDJSON 子进程客户端，无 owner/凭据/任意 method 入口；输入有界、秘密走 stdin，不新增 fs/bash 工具或向 Pi/Harness 自动注册。
- `vault/profiles.rs` 登记可信启动 Profile，只存 CredentialRef/binding/revision；owner catalogue 通过 Secret Store 脱敏元数据检查锁定、缺失、错用途、版本变化和撤销，不返回 Key。
- 明确区分凭据存在和模型连接：始终不启用模型、不标记连接已验证；默认空注册，配置含 Profile 时必须通过 Vault 私有启动文件守卫。
- CLI 新增 auth/worker stdin 操作与 providers 元数据查询，RPC/CLI 敏感响应缓冲区使用 zeroize；仍不承诺消除全部解析副本、swap/core dump。
- 保留桌面/sidecar/Webdesk 原接口；同步 [实际 Worker/Profile 契约](runtime-r1-workers.md) 与 contract.md。修复合并远端后 3 项严格 clippy 告警，压缩过滤参数仅归组、保护语义不变。

## 本机验收

| 验证 | 结果 |
|---|---|
| Rust core | 92 单测、2 RPC 集成通过；新增 6 个 Worker 安全用例与 2 个 Profile 校验用例 |
| daemon/CLI/Worker | 12 集成通过；新增实际 daemon + CLI + 独立 Worker 子进程与真实加密 Store/Profile 引用链路 |
| Webdesk | 40 单测通过，原固定 BFF/Provider 回归保持可用；只更新测试配置新默认字段，不扩展 BFF 路由 |
| 独立 agent-service | 16 单测/进程集成通过，旧 Provider 保存/重载仍可用 |
| sidecar | 116 测试通过；新 Worker 协议没有注册到旧引擎 |
| clippy | core（无 GUI）、daemon all-targets `-D warnings` 通过 |
| 构建 | daemon/CLI/Worker 本机 macOS release 通过；不是 Linux sandbox/OS 发布验收 |
| 版本 | 0.2.1 一致，无软件版本 bump |
| 真实模型 | 未调用；现有 local-model e2e 在端点不可达时跳过，不计入真实模型证明 |

覆盖：目录扩大/其他用户/父目录/内部资产/符号与硬链接拒绝；wrong run/workspace/CSRF 拒绝；TTL、父会话到期、显式撤销、logout、重启、次数和重放限制；并发只允许额度内调用；审计失败不签发 token/返回正文；中文与邮箱完整传递；Worker 客户端拒绝任意 method；CLI 不接受秘密 argv；daemon/Worker stderr 和审计无合成 password/token/CSRF/key/正文；Profile 静态 URL/用途/引用校验与真实存储轮换/撤销动态状态。

## 尚未关闭的发布门

本批 Worker 是同 uid 的**受信开发 Adapter**。该 OS 用户仍可自行访问其文件和 owner 控制 socket，协议票据不构成恶意同 uid 进程的沙箱；因此不接入非可信 Agent/浏览器，不宣称 R1 Worker 隔离完成。

1. Linux 分 uid/受限通道、网络/挂载隔离与真实目标机验收；R0 Harness/Gateway 可行性门。
2. Model Gateway 的任务级授权、最小 Context、实际 Key 使用/短期 Credential Lease、轮换排空与外发回执；不允许自由 endpoint/Key 或明文 getter。
3. 控制 Profile 持久写入/独占锁、旧客户端互斥 Adapter 与真实连接验证；桌面 AES、R1 Argon2/XChaCha 和 agent.env 三条凭据路径尚未统一。
4. 显式迁移备份/查证/引用切换与恢复、持久身份/对象 ACL、审计轮转；R2 来源 DB/流水线和 R3 家庭知识事务仍待实现。

上述工作需要明确的 Linux 隔离环境和迁移维护窗，不能通过自动修改真实 Home/凭据或重新启用危险工具来补齐。本批不会将引用状态、合成测试或 Worker 查询包装成模型执行成功。

环境检查：当前为 macOS arm64；存在本机 Docker CLI/context（本机 Unix socket），但 Docker daemon 未运行。没有启动虚机/容器、访问或变更 192.168.1.167 的账号/服务；Linux 隔离验收不计为通过。

此为第四批环境快照；第五批已启动本机 Docker 并补合成 Linux 容器验收，后续状态见 [第五批记录](implementation-status-batch5.md)，不改写本批历史测试结果。
