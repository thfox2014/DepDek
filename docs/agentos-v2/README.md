# DepDek V2.0 AgentOS 架构设计包

> 日期：2026-10-04  
> 状态：整体目标仍是工程设计草案；R1 本机只读、可选加密凭据、业务会话/loopback BFF 切片已实现，范围以运行时契约为准。  
> 检查基线：本地仓库提交 `ef0bd52`，`VERSION=0.2.0`。V2.0 是目标产品代际，本次不修改软件版本号。  
> 目标交付：基于 Debian 的家庭 AI NAS OS，以及连接同一业务服务的 Web、桌面与语音 Shell。

## 阅读入口

| 文档 | 解决的问题 |
|---|---|
| [整体架构](architecture.md) | 产品分层、进程、信任边界、模型执行、NAS、部署与运维 |
| [接口设计](api.md) | 身份、统一命令、授权、查询、任务、流式事件、工具与兼容接口 |
| [数据设计](data-model.md) | 原件、知识、记忆、索引、价值、权限、事务、备份与恢复 |
| [重构计划](refactor-plan.md) | 当前模块逐项迁移、单一写入者切换、交付门与回滚 |
| [实施记录](implementation-status.md) | 第一批已实现内容、真实测试结果、未关闭的发布门与下一步 |
| [第二批实施记录](implementation-status-batch2.md) | 加密凭据管理、幂等/故障/导入测试及尚未接线的能力 |
| [第三批实施记录](implementation-status-batch3.md) | 独立业务会话、目录授权、loopback BFF、安全测试和剩余计划总表 |
| [R1 本地运行时契约](runtime-r1.md) | 已实现的 daemon/CLI、只读命令、身份与审计；不是完整 V2 HTTP |
| [R1 凭据运行时契约](runtime-r1-secrets.md) | 已实现的可选加密存储/CLI/导入预览与恢复边界；不代表已迁移真实配置 |
| [R1 业务访问契约](runtime-r1-access.md) | 已实现的用户/会话/目录范围与固定 BFF；不是完整多租户或对象 ACL |
| [凭据迁移验收设计](secret-migration-r1.md) | Secret Store 来源盘点、导入顺序、合成夹具与待验收场景 |
| [OpenAPI 草案](openapi.json) | P0 公共 HTTP 边界；命令参数通过版本化 Manifest 扩展 |
| [核心 SQL 草案](schemas/workspace-core.sql) | 首条家庭事务闭环的工作空间数据库骨架，可独立验证约束 |
| [设计验证脚本](verify-design.mjs) | 本地链接、接口结构/引用及 11 项 SQL 骨架测试；不修改运行数据 |

OpenAPI 与 SQL 是设计附件，不是已接入的路由或生产 migration。接口目录中的后续能力有明确阶段标记；未出现在 OpenAPI 的扩展入口不能据此宣称已经可调用。SQL 仅覆盖核心表，完整模型还包括数据文档列出的控制面、记忆镜像、模型请求与备份等扩展表。

## 产品目标

**原件可信保存，家庭知识持续纠正，Agent 将知识变成帮助。**

首发闭环：导入物品凭证 → 识别 → 用户确认 → 关联物品 → 解释用途 → 授权检索 → 生成维修资料包与待办。

Shell 以语音和自然语言为主要入口，保留软键盘、CLI 和业务视图；左侧选择 Agent，中间推进当前事务，右侧展示证据、冲突、选择、确认与结果。OS 保留 NAS 必要服务，第一批限定受支持的 x86 硬件。

## 与既有文档的关系

1. [AgentOS 产品定义](../agentos-product-definition.md) 继续定义 OS 形态、语音 Shell、CLI 驱动与结果导向。
2. [工作台本体设计](../workbench-ontology-design.md) 继续定义 Object / Assertion / Relation / Evidence / Action 元模型；本设计增加家庭领域包和服务化落地，不另建平行本体。
3. [共享记忆设计](../agentteam-memory-design.md) 和 [当前记忆契约](../contract.md#210-agent-team-共享长期记忆) 继续约束既有 JSONL 事实源；本体先做镜像，不直接替换主写。
4. [contract.md](../contract.md) 仍是已发布桌面端 Rust / sidecar / React 接口的唯一标准。实现 V2 桌面适配前，必须在那里登记正式扩展、兼容规则和弃用条件，再同步各方。
5. Webdesk 保持独立进程、不直接读写 DepDek Home。其 V2 HTTP 转发仍是设计；本批未接入，不能将本机 uid 认证当作浏览器用户委托。实现时另行更新 [Webdesk 设计](../webdesk-design.md)。
6. 本目录作为 V2.0 工程总设计；旧 [重构路线](../depdek-refactor-roadmap.md) 的“今天页主入口”等历史排序不再控制新 Shell。接口名称在实现前仍可评审修订。

## 已确认的关键决策

| 决策 | V2.0 选择 |
|---|---|
| 交付形态 | Debian 衍生 appliance OS；安装包/容器用于开发和兼容交付 |
| 主入口 | Agent Shell；文件、档案、相册、播放器和今日事项作为业务视图 |
| 三层中间件 | 数据层；系统层；应用层。四个产品引擎是该三层的功能切面 |
| 权威数据 | 每工作空间本地 SQLite 主库 + 原始版本；既有记忆 JSONL 单独保持权威 |
| 知识图谱 | 对象/断言/关系/证据关系表，限定遍历；首期不新增独立图数据库 |
| 派生数据 | 全文/向量/缩略图/知识投影可重建；人工决策与行动回执必须备份 |
| 接口骨架 | 一个命令注册表，HTTP / CLI / Tauri / MCP 适配同一业务语义 |
| 安全执行 | Rust 受控访问层执行授权；Agent 无原始 fs/bash/SQL/凭据能力 |
| 两种引擎 | Pi 与 DeepSeek Harness 平级治理，按实际能力协商；不伪装工具支持 |
| 自动化 | 至少一次投递 + 幂等 + 检查点 + 外部未知结果查证 |
| 模型策略 | 数据默认本地，计算按设备能力与授权路由 |
| 家庭权限 | 设备管理员与私人内容访问权分离；检索、证据和回答同样受限 |

## 设计附件验证

设计验证只证明文档结构与 SQL 约束，不证明 V2 系统已实现。可检查：

- Markdown 本地链接、OpenAPI JSON 和组件引用是否完整。
- 核心 SQL 在空库创建成功、外键有效、跨空间引用被拒绝。
- 重复来源版本/行动幂等键被拒绝；冲突事实可以同时保存。
- 表、接口示例、任务状态与迁移阶段是否对应。

本目录不包含密钥、密码、真实家庭资料或生产配置。

运行验证（需要 Node 与 sqlite3 CLI）：

```bash
node docs/agentos-v2/verify-design.mjs
```

该脚本不是完整 OpenAPI 规范验证器，也不验证生产授权、WAL 并发、OS 安装或真实模型能力；这些仍须按重构计划的验收门测试。
