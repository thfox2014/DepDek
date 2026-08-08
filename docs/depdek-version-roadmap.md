# DepDek 版本迭代开发计划

> 规划基线：`docs/depdek-prd.md`、`docs/depdek-concept-design.md`、`docs/depdek-refactor-roadmap.md`
>
> 当前版本：V0.1（产品壳与兼容桥）
>
> 规划原则：每个版本都必须形成一个可运行、可回退、可验证的本地优先闭环；跨 Rust Core、sidecar、React 的接口以 `docs/contract.md` 为唯一标准。

## 1. 当前基线：V0.1

V0.1 已完成 DepDek 品牌壳、Today/Home 工作台、领域导航、Deep Work、Vault/RPC、设置与 Provider 原型。邮件能力仍是旧的 Deep Work 入口和兼容性 IMAP bridge，数据模型尚未升级为 Canonical Record。

V0.1 的退出条件：

- 应用可在浏览器预览和 Tauri 桌面运行；
- Vault 路径沙箱、审计日志、sidecar stdio 协议测试通过；
- 旧 Deep Work、Provider 设置和已有 vault 数据不回归；
- 新的视觉壳不改变 Rust 的信任边界。

## 2. V0.1 → V1.0 版本路线图

| 版本 | 主题 | 主要交付 | 版本出口条件 | 依赖 |
|---|---|---|---|---|
| V0.1 | 产品壳与兼容桥 | DepDek Home、领域导航、Deep Work、Vault/RPC/sidecar 基线 | 三层构建通过，旧数据可读 | 无 |
| V0.2 Sprint 1 | 本地优先收件箱 | 邮箱账户配置、IMAP 手动增量收取、本地邮件阅读/已读/星标/归档、本地 AI 整理建议 | “添加账户 → 收取 → 阅读 → 整理”闭环通过；不向云端发送、不做外部写回 | V0.1、contract v1 |
| V0.3 Sprint 2 | Personal Data Home | `home/manifest.json`、schema/migration、SQLite Canonical Record、SourceRef/Provenance、对象存储、FTS；导入 V0.2 邮件 Markdown | 邮件可从兼容目录迁入 `Message`，源文件可回溯，迁移可重跑 | V0.2 邮件缓存 |
| V0.4 Sprint 3 | Secret Store 与连接中心 | OS Keychain/Secret Store、CredentialRef、连接权限/暂停/撤权、Provider 与邮箱密码迁移 | 普通文件、审计、模型上下文不再出现明文凭据 | V0.3 Vault/manifest |
| V0.5 Sprint 4 | Sync Engine 与 P0 连接器 | 持久任务队列、游标、幂等、重试、断网恢复、邮件重构；只读 Calendar、本地 Files | 连接器可暂停/恢复，失败可重试，重复同步不产生重复记录 | V0.4 Connection |
| V0.6 Sprint 5 | Today/Knowledge/Search | Today 真实聚合、统一搜索、来源回溯、收件箱/任务/知识/文件完整页面、离线浏览 | 用户可从一个入口找到任意本地数据并回到原始来源 | V0.3 Canonical Record、V0.5 Sync |
| V0.7 Sprint 6 | Local Intelligence & Memory | 本地模型探测/路由、摘要/任务/实体抽取、DerivedRecord provenance、MemoryFact 候选与治理、Copilot Drawer | 本地模型可解释地工作，记忆可确认、过期、删除 | V0.3、V0.6 |
| V0.8 Sprint 7 | Cloud Model Gateway | 任务分层、最小披露、脱敏、外发预览、成本/策略、Receipt、本地降级 | 没有显式 Gateway/预览批准时不发生云调用 | V0.7 |
| V0.9 Sprint 8 | Action / Approval / Writeback | Action→Approval→Execute→Receipt、版本校验、邮件草稿/发送、日历写回、风险分级、撤销、幂等 | 所有外部写操作有批准、审计、结果和失败恢复 | V0.4、V0.5、V0.8 |
| V1.0 | 安全加固与生态准备 | 加密备份/恢复、Connector SDK、Domain Packs、多设备准备、插件沙箱、性能/可访问性/安全审计 | 安全审计完成，备份可恢复，核心体验达到稳定发布门槛 | V0.9 |

## 3. Sprint 交付节奏

每个 Sprint 固定经过以下五个门：

1. 产品门：PRD 明确目标、非目标、验收标准和迁移债务；
2. 设计门：数据、模块、接口、状态机与错误处理写入 Design；
3. 实现门：程序员按 Design 修改对应层；任何契约变化同步 `docs/contract.md`、Rust、sidecar、React；
4. 测试门：自动化测试、浏览器回归、Tauri 打包/签名检查按 Testcase 执行；
5. 发布门：记录已知问题、回滚路径、指标和下一版本入口。

## 4. 版本优先级与风险控制

- P0 只做个人数据回到本地、可读、可追溯、可重试的闭环；外部写回永远后置到 V0.9。
- V0.2 接受 `mail/accounts.json` 中密码明文的兼容债务，但 UI、AI、日志不得主动展示；V0.4 Secret Store 是硬门槛，不能跳过。
- 统一 Canonical Record 和 FTS 不在 V0.2 提前实现，避免在邮件来源格式尚未稳定时建立错误的数据模型。
- 所有网络连接都必须由用户配置并可见；浏览器预览只用 fixture，不访问外部服务器。
- 失败优先于“看起来成功”：单账户失败不阻断其他账户，错误须能区分认证、网络、解析和本地存储。

## 5. 本次 Sprint 入口

V0.2 的完整产品、测试和系统设计分别见：

- [V0.2 PRD](<V0.2 PRD.md>)
- [V0.2 Testcase](<V0.2 Testcase.md>)
- [V0.2 Design](<V0.2 Design.md>)
