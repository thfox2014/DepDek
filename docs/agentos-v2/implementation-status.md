# V2 重构实施记录：第一批

> 日期：2026-10-04；起点 `ef0bd52`，软件 VERSION 仍为 0.2.0。仅本地开发与合成测试，没有迁移真实资料、提交 Git 或部署目标机。

本文保留第一批验收快照；后续新增的本机凭据库及测试进度见 [第二批实施记录](implementation-status-batch2.md)，不要将以下“下一批”当作当前未实现清单。

## 1. 本批结果

R0 已完成可复现的现有代码测试基线；R1 已落地**非 GUI daemon + 本机单用户只读 CLI + 严格文件审计**。R0 的全部可行性门、R1 的凭据/多用户/旧客户端切换并未完成，不能将本批标记为整个阶段完成。

| 交付 | 实际实现 |
|---|---|
| 独立服务 | `services/depdekd`，依赖禁用 GUI 的既有 Rust 核心；没有搬迁核心路径 |
| 命令入口 | 版本化 Manifest、file.list/read/stat、JSON envelope 与明确错误；其它能力拒绝 |
| 身份 | 本机 Unix peer uid 双向校验；非 root 单一 owner，不能自填 actor |
| 数据边界 | 安全逻辑仍集中 Vault；固定可读目录、逐级 fd/no-follow、内部资产过滤、预算 |
| 可靠审计切片 | 同步成功再返回；故障锁死；重启拒绝损坏尾部；不改变 v1 行为 |
| 版本与契约 | contract §9、AGENTS、版本脚本、npm 测试/构建入口同步 |
| 运行产物 | macOS 本机 release daemon/CLI；没有产出或验证 Linux 安装包 |
| 凭据迁移准备 | 已盘点来源、设计导入门和合成夹具；尚无运行时 Secret Store |

详见 [运行时契约](runtime-r1.md)、[服务使用说明](../../services/depdekd/README.md)。Webdesk 未连接本切片：后台进程 uid 不等于浏览器终端用户，必须先有可信委托协议。

## 2. 测试基线与新增验证

全部测试只使用既有测试环境或合成临时目录，没有读取真实邮件正文、家庭文件或凭据。

| 命令/模块 | 本次结果 | 限定说明 |
|---|---|---|
| Rust core `cargo test --no-default-features` | 46 单测 + 2 RPC 集成通过 | 33 个原有单测、13 个新增 ManagedReadVault 单测 |
| `e2e_local_model` | **跳过真实模型交互** | localhost:8080/v1 不可达；测试包装显示 ok 不代表模型验收 |
| sidecar build/test | 90 测试通过 | 含 mock Harness/协议验证，不是真实云端请求 |
| 根前端 build | 通过 | 现有大 chunk 警告仍在，本批不调整前端 |
| Webdesk 前端 build | 通过 | 未接入新 daemon |
| Webdesk Rust + HTTP e2e | 36 单测及 e2e 脚本通过 | 独立服务的既有登录/CSRF/API/审计路径 |
| space-service | 3 测试通过 | 旧存储实现不切写入者 |
| agent-service | 13 测试通过 | 本批不修改 Provider 保存或执行器 |
| depdekd | 6 测试通过 | 含真实 child daemon + CLI，不是仅 mock dispatch |
| depdekd clippy | `-D warnings` 通过 | all-targets |
| 旧 Rust core clippy | **未通过严格零告警门** | 存量 obsidian.rs:94 unnecessary_sort_by、rpc.rs:340 while_let_loop、voice.rs:44 manual_is_multiple_of；不属于本批修改路径，尚未修复 |
| 软件版本检查 | 通过，0.2.0 | 新 daemon/锁文件已加入统一版本脚本 |
| 设计验证脚本 | 22 操作、216 schema refs、11 SQL 用例通过 | 只验证设计结构/空库约束，不是生产集成 |

新增安全用例覆盖：身份/空间/策略版本、越顶/绝对路径/前缀混淆、内部资产列表过滤、symlink/hardlink/特殊节点、读取/目录预算、UTF-8、审计故障与 listener、日志别名/权限/尾部、根路径替换。daemon 测试还覆盖真实协议、逐字节 UTF-8 帧、未知版本/写命令、请求预算、重复绑定、私有 socket 与退出不误删文件。

非 root 身份/真实进程用例在 root 环境会跳过；本次为 macOS 非 root 用户，已实际执行。Linux 的 peer credential、文件系统、systemd 与断电恢复仍需真机/CI 验证，不由本结果代替。

## 3. R0 尚未关闭的门

- 本机 dsh 探测版本 `0.1.0-rc.6`；只检查本地版本/帮助与已有适配，未调用外部模型，也未证明自定义受控工具/Gateway 兼容。
- Harness 当前仍按 text-only 能力看待；“关闭默认工具”的配置不等于 OS 网络隔离。禁止在这些门通过前恢复原始 fs/bash/web 或直接 Provider 网络出口。
- 本机 sqlite3 `3.43.2` 仅运行内存库设计约束测试；没有选定生产 SQLite 构建或验证安全补丁/WAL/中文索引。
- 无目标 N3160/目标 NAS 实测、私有数据权限矩阵、恶意解析样本、安全更新与恢复演练。本批运行时威胁边界限定在可信同 uid、本地文件系统。
- 全局网络模型代理、真实 usage/事件、进程隔离、模型外发选择与授权需独立验收。

上述缺口限制后续模型、写入和网络接入，不阻止合成空间中的离线只读原型。不能凭本批测试向真实多用户或敏感资料开放新入口。

## 4. 下一批实施顺序

1. **Secret Store 与无回显导入**：按 [凭据迁移验收设计](secret-migration-r1.md) 和合成夹具验证，再改契约与桌面/sidecar/broker。此之前旧明文债务继续存在，不能宣称已加密。
2. **可信用户委托与 workspace 注册**：浏览器 session → BFF 受限委托 → daemon 的可核验 principal；多用户 ACL/撤销/派生物权限与拒绝审计一并补齐。
3. **单写入者与旧客户端 Adapter**：建立跨进程锁、模式互斥、数据清单/稳定备份；再切 Tauri/Webdesk。现在没有偷偷把旧 writer 留在新写入口旁边。
4. **完整 R1 审计**：统一失败门禁、协议安全事件、轮转/保留/outbox 与故障恢复；实测低端设备同步开销。
5. 只有上述发布门通过，才进入 R2 的 SourceRevision/DB/持久流水线和 R3 家庭事务写入。

本批新增命令不是可直接绑定到 Agent 的权限集：模型 Gateway、执行器隔离和主体映射未完成，先保留为开发者本机验收入口。
