# DepDek 系统重构路线

> 原则：保留安全内核，逐步替换产品中心；每个阶段都保持可运行、可验证、可回退。
> 产品依据：[概念设计](./depdek-concept-design.md) · [PRD](./depdek-prd.md)

## 1. 现状判断

### 1.1 可直接保留

- Rust 作为唯一信任边界。
- Vault 的路径沙箱、symlink 逃逸防护和大小限制。
- append-only 审计与实时事件。
- Rust ↔ sidecar 的 NDJSON JSON-RPC 隔离。
- Agent 不拥有直接 fs/bash 能力。
- Tauri + React 桌面技术栈。
- OpenAI-compatible 本地模型接入能力。

### 1.2 需要演进

| 当前实现 | 目标形态 |
|---|---|
| 一个任意数据文件夹 | 有 schema、数据库、对象和回执的 Personal Data Home |
| API key/邮箱密码写入 settings 或 vault 文件 | OS Keychain + 不透明 CredentialRef |
| IMAP 特例 | 统一 Connector SDK + capability manifest |
| 文件是主要数据模型 | Canonical SQLite + 原始对象/开放导出双层 |
| Agent 会话是主入口 | 今天工作台、领域视图、指令栏、Copilot |
| Provider 由会话直接选择 | Local Router + Cloud Model Gateway |
| 工具调用即执行 | Action → Approval → Execute → Receipt |
| `profile.md` 代表用户 | 有来源、置信度和状态的 Memory Store |
| 文件操作审计 | 数据、凭据、网络、模型外发、外部行动统一审计 |

### 1.3 必须尽快修复的安全债务

1. 当前 Provider API key 存普通应用 settings。
2. 当前邮件密码/授权码明文存 `mail/accounts.json`，且模型可经文件工具读取。
3. sidecar 邮件连接在 Node 内直接建立网络连接，缺少 Rust 网络 capability 控制。
4. 现有审计只覆盖 Vault 操作，不能证明模型外发和远端写操作。

这些问题在新增连接器前必须进入迁移计划，不能沿用到 v2。

## 2. 目标模块边界

### 2.1 Rust Core

建议拆分为：

- `home/`：Home 生命周期、schema、migration、健康检查。
- `vault/`：对象与开放文件访问，延续路径沙箱。
- `store/`：SQLite 事务、Canonical Record、FTS。
- `secret/`：OS Keychain、CredentialRef、凭据迁移。
- `capability/`：主体、数据范围、网络目的地、模型与行动权限。
- `sync/`：任务队列、游标、幂等、冲突、重试。
- `action/`：Plan、Approval、Execute、Receipt、撤销。
- `model_gateway/`：本地/云端路由、脱敏、预算、外发回执。
- `audit/`：统一事件模型与防篡改链。
- `rpc/`：只负责协议与 Worker 生命周期，不承载业务授权。

### 2.2 Worker Host

现有 Node sidecar 演进为多个逻辑 Worker：

- `agent-worker`：对话、规划、受限工具编排。
- `connector-worker`：服务协议解析与数据映射。
- `model-worker`：本地/云端 Provider 适配和流式生成。
- `extractor-worker`：文本解析、分类、实体/任务抽取。

首期可继续共用一个进程，但协议上必须有 `principal` 与 capability；后续再按风险拆进程。

### 2.3 React App

建议按领域而不是技术组件组织：

```text
src/
  app/             # shell、router、command bar、layout
  features/
    today/
    calendar/
    tasks/
    inbox/
    knowledge/
    files/
    connections/
    memories/
    automations/
    privacy/
  components/      # 通用卡片、表格、审批、来源、状态
  data/            # typed API、query cache、event adapters
```

## 3. 契约 v2 设计顺序

在实现任何新跨层接口前，先从 `docs/contract.md` 创建 v2 章节或新文件并保持三方同步。建议按以下顺序定稿：

1. 通用 Envelope、版本协商、错误与 trace ID。
2. Principal 与 Capability 模型。
3. Home/Record/Query 接口。
4. Secret/CredentialRef 接口。
5. Connection/Sync 接口。
6. Model Request/Data Disclosure/Receipt 接口。
7. Action/Approval/Execution/Receipt 接口。
8. 统一 Event/Audit schema。

协议应从方法枚举和手写 TS/Rust 类型升级为可生成类型的 schema（如 JSON Schema），但 Rust 仍是最终授权实现。

## 4. 分阶段路线

### Phase 0：产品壳与契约地基

目标：不改变底层数据能力，先把产品身份和主导航切换为 DepDek。

- 品牌从 Agent Workbench 改为 DepDek。
- 新增 app shell、左侧领域导航、顶部指令栏和“今天”空态工作台。
- 现有 Agent 办公室保留为“Deep Work / 实验室”入口。
- 定义 design tokens、卡片栅格、状态组件和可访问性基线。
- 建立 `contract v2 draft` 和 schema generation 方案。

退出条件：旧能力无回归；用户可在新壳中进入文件、邮件、Agent、设置；主界面不再以 Agent 会话为首屏。

### Phase 1：Personal Data Home

目标：从任意文件夹升级为有版本的数据家园。

- Home manifest 与 schema version。
- SQLite 主库、migration、备份与健康检查。
- Object Store 与内容哈希。
- Canonical Record 基础表、SourceRef、Provenance、Relation。
- SQLite FTS 搜索。
- 当前 Vault 文件作为 `local-files` source 接入，保持兼容。

退出条件：Home 可创建、迁移、恢复；文件可作为 Document 被索引；所有派生索引可重建。

### Phase 2：Secret Store 与连接中心

目标：先解决凭据主权，再扩展服务。

- OS Keychain 适配和 CredentialRef。
- 迁移 Provider API key 与邮箱凭据；迁移成功后清除旧明文。
- Connection、Scope、Health、SyncCursor 数据模型。
- 连接中心 UI：权限说明、状态、暂停、撤权、删除。
- Connector manifest 与固定网络目的地。

退出条件：普通文件、settings、日志和模型上下文中不存在凭据明文；撤权立即生效。

### Phase 3：同步引擎与 P0 连接器

目标：建立稳定的“数据回本地”主循环。

- 持久同步队列、幂等键、指数退避和错误分类。
- 原始快照 → normalize → index 流水线。
- 邮件连接器迁移到新 SDK。
- 日历只读连接器。
- 本地文件连接器。
- 同步健康卡、冲突中心、离线队列。

退出条件：三个连接器通过契约测试、断网恢复、重复同步和凭据过期场景。

### Phase 4：统一工作台与知识体验

目标：让数据不通过聊天也能产生日常价值。

- “今天”真实卡片：日程、任务、待处理、同步健康。
- 收件箱、待办、知识、文件完整页面。
- 全局搜索/指令栏和来源回溯。
- 本地布局个性化。
- 首次连接与首次同步 onboarding。

退出条件：PRD Journey A/B 可完全走通；离线仍可浏览、搜索与编辑。

### Phase 5：本地智能与记忆治理

目标：建立“越用越懂，但用户可控”的本地智能层。

- 本地模型检测、路由和任务能力声明。
- 摘要、任务抽取、实体链接、敏感识别流水线。
- Derived Record provenance。
- MemoryFact、候选/确认/过期/删除和使用记录。
- Copilot Drawer 与上下文构建器。

退出条件：任何推断都能回溯输入；删除记忆后不再进入检索或提示。

### Phase 6：云端 Model Gateway

目标：复杂规划可以用云端，但外发始终可见可控。

- 模型策略与任务路由。
- 数据选择、脱敏与外发预览。
- 成本预算和 Provider policy。
- Cloud Request Receipt。
- 本地降级与失败恢复。

退出条件：不存在绕过 Gateway 的云端调用；PRD Journey C 通过。

### Phase 7：Action、审批与外部写回

目标：从“理解信息”走向“可靠行动”。

- Action Plan、风险分级、Approval 和 Receipt。
- 执行前版本校验。
- 邮件草稿/发送、日历创建/修改的写回能力。
- 部分失败、幂等、重试和可撤销操作。
- 自动化规则仅开放低风险动作。

退出条件：PRD Journey D 通过；所有高风险动作逐次批准且可审计。

### Phase 8：生态与多设备准备

目标：在不牺牲本地所有权的前提下扩展。

- Connector SDK 文档与签名包。
- Domain Pack。
- 加密备份与恢复。
- 可选多设备同步架构验证。
- 插件沙箱和权限审查机制。

## 5. 建议首批 Epic

### Epic A：DepDek App Shell

- 路由与领域导航。
- 顶部指令栏。
- “今天”卡片布局引擎。
- 状态、空态、离线态、权限态组件。

### Epic B：Home v2

- Manifest、SQLite、migration、FTS。
- Record/Source/Relation 基础 schema。
- 当前文件 Vault 兼容桥。

### Epic C：Credential Safety

- Secret Store abstraction。
- Provider key 迁移。
- 邮箱凭据迁移。
- 秘密扫描测试。

### Epic D：Connector Foundation

- Connection/Scope/Cursor/Health。
- Connector manifest。
- Sync queue 与审计事件。
- 邮件连接器重构。

## 6. 测试策略

### 6.1 Rust

- 每个 capability 的允许/拒绝矩阵。
- CredentialRef 不可被模型主体解析。
- 网络目的地逃逸与重定向测试。
- Home migration 故障注入。
- Action 版本漂移、重复执行和撤销测试。
- 云端外发 restricted 数据阻断测试。

### 6.2 Worker

- Connector 契约夹具与录制响应。
- 增量游标、重复页面、限速和过期凭据。
- stdout 协议纯净性，日志只进 stderr。
- 模型工具不能获得 fs/bash/secret/network 原语。

### 6.3 前端

- Journey A–E 的关键状态测试。
- 键盘导航、焦点、缩放、reduced motion。
- 离线、同步失败、权限失效、冲突和部分失败。
- Action Sheet 中数据范围和高风险确认不可绕过。

### 6.4 端到端

- 真实本地模型或稳定 mock。
- 模拟邮箱/日历服务。
- 崩溃恢复、断网恢复、磁盘写满和数据库锁。
- 导出后在干净环境恢复。

## 7. Migration 策略

### 7.1 现有用户数据

- 旧 vault 不原地改写；首次升级创建 Home manifest 与数据库。
- 文件以 `local-files` 来源索引，原路径保持不变。
- `profile.md` 导入为明确用户提供的 MemoryFact，保留源文件。
- `mail/` 历史 Markdown 导入 Message Record，并标记 legacy source。

### 7.2 凭据

- 检测旧 Provider 和邮件凭据。
- 在本地确认页展示要迁移的账号，不回显完整秘密。
- 写入 Secret Store 并验证。
- 更新配置为 CredentialRef。
- 安全删除旧明文字段，并写迁移回执。
- 迁移失败时不删除旧数据，但阻止继续新增明文凭据。

### 7.3 Agent 会话

- SavedAgent 迁移为 Deep Work preset。
- 历史聊天首期不作为主数据；后续可选择导入为 Document/Session Record。

## 8. 决策门

进入实现前需要明确以下产品/技术决策：

1. 首发操作系统范围：macOS first，还是三平台同步。
2. Home 是否要求应用层加密，或首期依赖系统磁盘加密。
3. 首发本地模型运行时：Ollama、llama.cpp 内置，或兼容端点优先。
4. 日历首发协议/Provider。
5. 是否允许 SMTP 首发写回，还是先做草稿导出。
6. 云端模型默认策略是否为“仅本地”或“逐次询问”。
7. Home 的开放导出格式和备份边界。

## 9. 推荐实施顺序

不要先堆更多连接器，也不要先做复杂多 Agent UI。最稳妥的顺序是：

**App Shell → Home v2 → Secret Store → Connector Foundation → P0 同步 → 本地智能 → Cloud Gateway → Action 写回。**

这个顺序先建立用户可见的产品方向，再补齐数据与凭据地基，最后开放模型外发和现实世界行动，能够最大限度复用当前安全成果并控制重构风险。
