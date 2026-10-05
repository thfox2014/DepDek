# V2 重构实施记录：第三批

> 2026-10-05；VERSION=0.2.0，接续 [第二批](implementation-status-batch2.md)。只用合成临时空间；没有迁移真实用户/凭据、切换旧主写者、提交 Git 或部署 NAS。完整计划仍未完成。

## 已实现

- Vault 内增加启动注册的业务用户与目录范围；注册不接受请求体角色，拒绝根范围、内部资产、重复主体、symlink 与超预算密码 PHC 参数。
- 登录使用 Argon2id PHC，业务 session/CSRF 随机生成；绝对/空闲期限、容量、失败冷却、退出撤销、重启失效。会话索引不存原始 bearer。
- BFF 和本机进程身份都不等于业务用户；固定 delegated file 查询在 Vault 重验范围，串行化撤销/读取，返回前复核期限，严格审计失败不放行正文。
- Webdesk 新增独立 `/api/v2/auth/*`、workspaces、commands 查询子集，JSON 不返回 session token，HttpOnly cookie、精确 Origin、独立 CSRF、no-store、固定 RPC 与预算。默认不开启、不自动改原界面/数据源。
- 启动身份配置的私有权限/单硬链接/no-follow/数据根外检查集中 Vault，CLI 从隐藏 TTY 生成业务密码 PHC。
- 修复此前 core 的 3 处 clippy 告警及 Webdesk 存量机械告警；保留 RPC 逐行处理，不引入文本流乱序。

参数与部署限制见 [第三批运行时契约](runtime-r1-access.md)。这不是持久身份库、对象 ACL、多 workspace 注册或 Worker 委托。

## 本地验收

| 验证 | 本次结果 |
|---|---|
| Rust core | 67 单测 + 2 RPC 集成通过；新增 7 个业务授权安全用例 |
| daemon/CLI | 10 集成测试通过；新增真实 daemon 进程加载私有配置/登录/读取/拒绝/撤销 |
| Webdesk | 38 单测通过；含 HTTP 路由 + 真实 Unix socket 服务，非 mock RPC |
| Webdesk HTTP e2e | 现有真实 HTTP 回归脚本全部断言通过；独立临时配置、18889 测试端口、合成密码/失联 mock 连接，未碰运行中的 8787 服务 |
| 严格 clippy | core（无 GUI）、daemon、Webdesk all-targets `-D warnings` 通过 |
| sidecar | 90 测试通过，兼容接口未改；没有真实模型外发 |
| 前端 | 根 UI、Webdesk UI build 通过；根大 chunk 提示保留 |
| release | 本机 macOS daemon/CLI/Webdesk 构建通过；不是 Linux 产品发布验收 |
| 版本/设计 | 0.2.0 一致；文档链接/OpenAPI/11 SQL 设计约束验证通过 |
| 版本脚本安全 | 增加并验证真正无写入的 --dry-run、未知/重复选项拒绝；3 个用例检查全部受管文件逐字节未改，测试后版本与 CHANGELOG 保持原值 |
| 真实模型 | 本地模型不可达，测试跳过；不能把包装 ok 当真实模型验收 |

新增验证覆盖：独立业务身份、其他用户目录/父目录/内部文件/其他空间不可见，symlink/hardlink 别名过滤；CSRF、logout、绝对/空闲到期、重启失效；超大 PHC 参数、重复/伪造主体与范围拒绝；登录冷却、未知帐号不认证；审计失败不签发会话/不放行正文；私有启动文件/别名/数据根内配置拒绝。响应不含密码/PHC，BFF JSON 不含 session token，审计/日志不含合成密码、PHC、token、CSRF 或正文；登录 CSRF 和授权查询正文是明确允许的响应。

HTTP 路由验证另覆盖 Webdesk admin cookie 不授予业务读取、攻击者 Origin 拒绝、POST 缺 CSRF 拒绝、JSON actor 字段拒绝、未知写命令/凭据路由拒绝、logout 后旧 cookie 失效、insecure 模式拒绝业务登录。

## 发布门与剩余计划

| 阶段 | 当前状态 | 未完成的关键门 |
|---|---|---|
| R0 | 基线继续完善，未关闭 | Harness/Gateway/隔离的真实能力、SQLite 构建、安全维护、Linux/N3160 性能 |
| R1 | 只读/加密凭据/业务会话三个切片可测，未关闭 | 持久身份/空间权限、分 uid BFF/Worker、凭据租约/profile 引用、单写入者锁、Adapter、真实迁移恢复 |
| R2 | SQL/接口骨架仍是设计 | SourceRevision/Blob 接入、持久 JobStep/fencing、事件/outbox、权限化索引与备份恢复 |
| R3 | 家庭领域闭环仍待实现 | 冲突确认/证据/价值、Plan/diff/Grant/Receipt、维修资料包、Shell 右侧交互 |
| R4 | 既有 Pi/Harness/记忆/Obsidian 保留 | 统一 Context/Gateway/Run、撤权投影、引擎平级、受控应用技能与真实 usage |
| R5 | 原 Debian 资产保留 | NAS 服务整合、安装/磁盘/SMB、TLS、安全更新/回滚、备份换机/断电真机验收 |

重要发现：现有 Webdesk `tls_cert/tls_key` 并未开启 TLS listener，只提示反向代理。新增业务 BFF **只允许 loopback HTTP 开发，远程与证书标志模式拒绝启用**，不将配置标志假充加密证明。真实 TLS/受限代理部署和分 uid 权限必须同批验收后才开放远程业务登录。

当前所有步骤均未修改真实源或启用模型。下一条代码闭环应先完成 R1 的 Worker 受限委托/凭据租约、控制 profile 与旧客户端互斥 Adapter；之后才能让模型/连接器使用新核心，或引入新的业务主写者。NAS 部署与真实凭据迁移须有明确测试空间、维护窗和恢复备份，不作为本次默认动作。
