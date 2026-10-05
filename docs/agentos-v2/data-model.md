# V2.0 数据设计

> 工程草案；不是已运行的数据格式。引用 [本体设计](../workbench-ontology-design.md) 的元模型，不用一个 relations JSON 数组取代断言与证据。首期可执行骨架见 [workspace-core.sql](schemas/workspace-core.sql)。

## 1. 数据资产与权威性

| 资产 | 权威来源 | 是否可重建 | 关键规则 |
|---|---|---|---|
| 原件 | 封存 Blob + SourceRevision | 不可由识别结果重建 | 不覆盖旧版、不向模型直接暴露物理路径 |
| 家庭知识 | workspace.sqlite 的对象/断言/关系/决策 | 模型候选可重做；人工决策不能丢 | 冲突并存；确认、归一与拆分可追溯 |
| 价值判断 | ValueAssessment + 输入版本/规则/反馈 | 自动判断可重算 | 长期与情境价值分开，不能自动决定删除 |
| 共享长期记忆 | 既有治理 JSONL（兼容阶段） | 索引可重建，人工确认事件不能重建 | propose/confirm/reject/tombstone 原语保持 |
| Job/Action/Receipt | 工作空间数据库 | 不可由 UI 文本重建 | 幂等、检查点、未知外部效果、补偿关联 |
| 搜索/向量/缩略图 | 派生索引与版本清单 | 可以 | 不做权限或事实权威 |
| 身份/配置 | control.sqlite + workspace membership | 不可随意丢弃 | 认证主体不同于知识中的 Person |
| 秘密 | Secret Store | 不可从普通 DB 重建 | 普通库只有 CredentialRef |
| UI 偏好 | 版本化键值配置 | 可重置 | 与事实、授权分离 |

“业务/偏好/认知”仍可作为视图分类；不能替代记忆的 kind/status/sensitivity/scope，也不能让会话摘要升级为用户事实。

## 2. 物理布局与数据库选择

```text
/var/lib/depdek/
  control.sqlite                 身份、空间注册、Provider/Engine 元数据
  config/                        非秘密配置、安装模块清单
/srv/depdek/workspaces/<ws-id>/
  workspace.sqlite               本空间权威知识/权限/行动
  originals/sha256/<prefix>/<id>  本空间内容地址原件
  staging/                       有租约、配额、过期回收的上传
  derived/                       解析文本、缩略图、资料包
  indexes/                       FTS/可选向量及版本清单
  memory/                        兼容 JSONL；通过受控入口访问
  audit/                         从审计 outbox 导出并轮转
/srv/depdek/backups/               受备份策略管理；不由普通文件工具访问
```

路径是 appliance 默认示意，安装时选择并登记磁盘 UUID/受管根；桌面用户目录采用平台目录。Webdesk、Worker 和 Agent 都不凭路径访问这些内部文件。DB/WAL/SHM/密钥不通过 SMB 分享。跨设备同步未来通过 API/事件，不复制一个活跃 SQLite 文件作为多人共享数据库。

初期一个 depdekd 主写进程，每工作空间数据库内含权限与领域事务，单写队列、短事务、WAL、外键与有界 busy timeout。控制库与空间库没有跨文件原子事务；不依赖 ATTACH 将 WAL 多库提交当原子操作。[SQLite WAL 限制](https://www.sqlite.org/wal.html)

发布构建固定并审计 SQLite 版本：采用已修复 WAL-reset 缺陷的版本（官方列明 3.51.3 及以后，或经核验的 3.44.6/3.50.7 回补），不直接信任宿主恰好安装的旧库。内存库验证 SQL 语法不等于生产 WAL 压力测试。[SQLite WAL 修复说明](https://www.sqlite.org/wal.html#walresetbug)

## 3. 表目录与归属

### 控制库（后续 migration 定义）

| 表 | 主要字段 |
|---|---|
| principal | id、类型 human/service/agent、登录名、password_hash、authentication_epoch、禁用状态 |
| auth_session | token_hash、principal_id、绝对/空闲期限、撤销状态、CSRF 元数据 |
| workspace_registry | id、受管根引用、owner、加密/锁定状态、schema_version |
| provider_profile | id、endpoint、协议、模型能力、trust_class、credential_ref、revision |
| engine_profile | id、Adapter/runtime 版本、配置、已验证能力、健康状态 |
| agent_definition / skill_manifest | 角色、可申请能力、Prompt/技能版本、默认配置；不是授权表 |
| credential_metadata | ref、拥有者、用途、轮换时间、配置状态；无 secret 值 |
| device_operation / device_receipt | 设备管理域动作；与家庭业务授权分离 |
| installed_module / schema_migration | 模块/命令版本与校验摘要、迁移记录 |

### 工作空间库

| 模型 | 主要表 | 实现范围 |
|---|---|---|
| 权限 | workspace、membership、access_grant、policy_change | 核心 SQL 有前三者；细粒度撤权日志后续 |
| 原始证据 | blob、source_record、source_revision、evidence | 核心 SQL |
| 本体 | object_type、object、assertion、relation | 核心 SQL；LinkType 元模型与 IdentityDecision 后续 |
| 判断 | proposal、decision、value_assessment、dependency | 核心 SQL；复杂判断规则可扩展 |
| 执行 | plan、action、action_attempt、receipt、job、job_step | 核心 SQL 除 action_attempt；生产必须补 attempt/fencing |
| 一致性 | event_outbox、consumer_inbox、audit_outbox | 核心 SQL |
| 内容与上下文 | extraction、artifact、context_snapshot、conversation_session、conversation_message、run、model_request、usage | 完整模型目录，核心 SQL 暂未展开；Run 带 parent_run/root_job 与委托引用 |
| 派生治理 | memory_projection、index_manifest、shared_projection、backup_manifest | 后续；不能成为平行主写 |

所有空间内实体带 workspace_id，引用用 `(workspace_id,id)` 复合外键。控制库 principal_id 是服务验证的外部身份引用，不能跨 DB 用假外键提供安全保证。每条写入带 revision、created_at/updated_at、创建主体；时间用 UTC，展示时转换时区。

## 4. 原件、来源版本和证据

`SourceRecord` 表示连接器中的稳定来源：connector_id + namespace + source_key。IMAP key 包含账户、邮箱、UIDVALIDITY、UID；不能只用 UID。文件来源用登记资源与稳定标识，不把文件名当永久身份。

`SourceRevision` 封存 upstream_version、内容 SHA-256、采集时间、媒体类型、大小、Blob 引用与 revision。旧版只读；源删除是新的状态/事件，不自动删除家庭知识或备份。

`Evidence` 引用固定 SourceRevision 和 locator：PDF 页/坐标、文本范围、邮件字段、图片区域、音频时间段、Obsidian block/heading。模型摘要不是原件；Evidence 指向解析产物时还要追溯其 input_revision、parser/model_version 和对应原件。

上传事务顺序：检查配额 → 暂存分块 → 校验大小/哈希 → sync 文件 → 原子封存并 sync 目录 → 主库事务登记 Blob/SourceRevision/outbox → 返回接入回执。Blob 提交前不推进连接游标；文件存在但事务失败是可回收孤儿，不是接入成功。

每空间内去重，跨私人空间不暴露是否命中其他人的哈希。GC 先做引用标记（来源/产物/暂存租约/备份），再延迟回收；不能仅凭当前来源表删掉快照仍引用的 Blob。

## 5. 家庭领域包

| ObjectType | 例子 | 关键关系 |
|---|---|---|
| Person | 家庭成员、售后联系人 | involved_in、contact_for；不等于 Principal |
| House / Room | 自住房、厨房 | contains、located_in |
| Asset | 客厅空调 | located_in、has_invoice、covered_by |
| Invoice / Warranty | 购买凭证、保修条件 | evidenced_by、applies_to |
| MaintenanceEvent | 一次维修 | concerns、performed_by、supported_by |
| Task / Document | 待办、资料包/文档 | requires、derived_from、about |

Invoice 是业务对象，PDF 是 SourceRecord；同一 PDF 可证明多个对象，同一物品可有多份材料。关系的端点类型、基数和有效期遵守本体 LinkType 元模型。

属性是 Assertion 而非 Object 中唯一覆盖值：`object_id, predicate, typed_value, valid_from/to, status, confidence, evidence_id, producer/version`。允许多条购买日期/型号；用户选择有效值写 Decision，保留旧断言。置信度不能冒充确认或事实真值。

日期可用 LocalDate + precision/timezone；不把“2025 年 6 月”补成 6 月 1 日。Money 用 decimal 字符串 + currency，不能用浮点表示金额。人员同名、共享邮箱不是自动合并依据；IdentityDecision 保留合并/拆分证据和依赖，使错误合并能重新计算。

### 空调闭环示例

```text
src-invoice-01 / rev-01 → ev-page-01
                        ↓
invoice-01 ── applies_to ── asset-ac-01 ── located_in ── room-living-01
  日期断言 A（发票）             ↑ 日期断言 B（用户补充）
                        conflict → 用户 Decision
                        ↓
value: 维修凭证用途 → repair Plan → packet artifact + task → Receipt
```

如果无法确认保修期限，资料包标注未知并附条款缺失；不得计算一个虚假的到期日。发送售后邮件是另一个独立外部行动。

## 6. 理解、价值和依赖

`Extraction = input_revision + pipeline_version + parser/model_version + output_ref + stage + error`。接入、解析、索引、知识更新分别有状态；原件接入成功不表示已识别完成。模型写 candidate，人工或已登记确定性规则确认。

ValueAssessment 字段：`target_id, kind=long_term|contextual, purpose, rationale, evidence_refs, rule/model_version, context_ref, status, valid_until`。长期价值表达权益/独特记忆/传承用途；情境价值依任务计算。不能只有一个排序分数，更不能据分数自动删除原件。

Dependency 记录 `dependent_type/id → source_type/id/revision`；源修正、关系拆分、撤权与墓碑化时先将相应产物标为 stale/blocked。展示、检索、Context 和外发都检查依赖版本；后台重算不允许过期结果继续伪装“已确认”。

本体库不把旧记忆候选自动认作家庭事实；记忆确认可以生成有来源的只读投影，仍受独立 ACL。

## 7. 共享记忆与 Obsidian

兼容阶段的记忆事实源保持既有 JSONL；修复为真实持久追加、单写序号、尾部不完整记录隔离、校验与可重建投影。MemoryProjection 保存 source_event_id、kind/status/sensitivity/scope、source_refs 与 payload_hash；不同时写 SQL 和 JSONL 当双主。

默认 Context 只用已确认、有效、当前可见的记忆；Agent 只能 propose，confirm/reject 需要可信授权人。secret 永不入记忆。墓碑后 query/get/语义召回/Context 都硬过滤；现有 get 行为迁移时必须补这个保护。保留/备份删除策略需向用户说明，不能承诺删除后所有离线副本立刻消失。

Obsidian 为用户原有知识资产：只读授权根 → Markdown/Properties/WikiLinks/block ID 解析 → SourceRevision → 对象/关系候选。文件链接是关联候选，不自动认定真实人物关系。外部修改生成新版与依赖失效，原 Obsidian vault 仍是其笔记主写；首期不修改用户笔记。用户选择写回时另有 Plan、diff、备份与冲突检测。

用户 myinfo/mydata 继续提供兼容视图，来源于 Profile + 已确认记忆 + 可见家庭事实；不新增第三份长期记忆主文件。Session compact 保存有界摘要、来源与遗漏标志，保留原消息历史；它解决上下文超长，不获得记忆确认权限。

## 8. 权限、派生数据与加密

个人空间、家庭空间、临时任务委托分别管理；家庭成员身份不等于所有共享对象都可读。访问授权表定义主体、资源范围、能力、期限、预算、policy_revision；对象/来源采用显式继承规则，派生产物默认取所有输入可见主体的交集。

跨空间共享不创建裸外键；创建 SharedProjection，保存来源空间、授权对象/版本、grantee、有效期与撤销检查引用。复制/派生产物必须重算权限；来源撤权同步阻止后续读取，后续异步清理索引/摘要。已经下载的数据无法追回。

查询先生成授权 ID 集，再全文/向量排名，返回前重验。Model Gateway 检查同一 ContextSnapshot 与 OutboundGrant。后台任务排队不锁死授权：执行时复核，撤权后立即阻断新的工具返回/流块/外发。实现采用核心权限代际与短期访问门禁；仅依赖异步 ACL 缓存不合格。

控制库身份禁用与空间政策更新是跨 DB 操作：先在主服务撤销会话/委托并提升认证代际，阻断新请求；再更新各空间投影。空间成员/对象授权与业务写入同库同事务。服务故障时按禁用状态保守拒绝，不使用陈旧投影放行。

加密分层：设备数据盘加密保护关机状态；解锁后按服务账号与 ACL 隔离；Secret Store 独立加密。可检索正文及索引属于敏感数据，置于同一加密/权限边界，不承诺“字段密文直接可全文检索”。需要额外字段加密的材料默认不索引，解锁授权后临时计算。

Secret Store 操作与 control.sqlite 不能作同一事务：先持久登记操作 ID，broker 幂等写入/轮换并返回版本回执，控制面核验后更新 configured。崩溃恢复按操作 ID 对账，不凭 UI 已点击保存宣称成功；旧秘密退役按租约排空与保留策略进行。

## 9. 检索选择与预算

P0 不强依赖向量数据库。全文初始采用 SQLite FTS5 内置 trigram，兼顾中文片段与文件名，不引入首期分词服务；标准化版本固定、可重建。三字符以下查询不能依赖 trigram MATCH，使用受授权集合与扫描上限限制的短词回退，或提示补充条件。它是明确的精度/性能折中，不宣称替代中文词法检索。[FTS5 trigram 说明](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)

在代表性家庭资料集测试中文短词、人名、型号、日期、错别字；不足时再以 tokenizer 插件引入中文分词，比较召回、增量代价和低端设备内存。向量阶段需验证授权预过滤、模型版本、维度与删除传播；无法限制授权候选时回退全文，不做全库 top-k 后遮挡。

初始 Context 上限由模型与设备策略决定，默认不超过 8,000 字符的长期记忆片段；完整任务资料另外预算。模型上下文上限前预估、截断产物而非原件、自动/手动 compact；Token usage 仅取提供方真实返回，估算单独标记。

## 10. Job、幂等与事务

JobStep 键为 `(job_id, stage, input_digest, pipeline_version)`。Worker 有 lease_owner、lease_epoch、lease_until；完成提交需要匹配当前 fencing token，超时旧 Worker 不得写回。检查点保存输入版本/输出引用，不保存可重复发送外部消息的自由脚本。

Action 幂等键绑定空间、主体、命令与请求摘要，attempt 单独记录提交时间、远端操作 ID、错误与核验结果。内部本地 Action、Job、领域事件和审计 outbox 同一事务；外部副作用不在数据库事务内，提交后用远端回执核验。

Outbox 至少一次发；ConsumerInbox 去重，处理结果与 inbox 同事务。进程重启只恢复可重入步骤。邮件发送响应丢失进入 unknown，先查证；供应方不支持幂等且无法核验时等待用户，不自动重发。

审计正文只保存必要摘要/参数哈希、主体、对象引用、授权依据、结果；不复制秘密或完整私人提示词。空间内敏感读在回包前持久登记，审计不可写拒绝；全局设备审计独立。轮转按大小/时间与保留策略，导出失败保留 outbox，不静默丢记录。

## 11. 备份、导出、恢复与删除

备份资产：源版本/Blob、空间数据库、人工决策/回执、既有记忆 JSONL、策略/身份必要元数据、Manifest/schema 版本与校验摘要。派生索引可不备份；Provider 秘密默认不导出，需重新配置或单独加密备份。

单库使用 SQLite Backup API 或经验证的快照方式，不能只复制活动 main 文件忽略 WAL。[SQLite 在线备份](https://www.sqlite.org/backup.html)

跨资产备份先短暂停写/封存边界，取得各库快照与记忆稳定前缀、Blob 引用集合，写 manifest 后再异步复制不可变 Blob。不能假称多库全局原子快照；manifest 记录各库代际与边界，验证身份/成员/来源引用可匹配。外部行动在边界前提交的回执仍可能未知，必须保留并在恢复后查证。

恢复先进入维护模式、停止主写、校验 hash/schema/FK/引用、映射成员和数据根；默认禁用 Connector 游标推进与外部 Job 重放，先对账 unknown。恢复不覆盖当前数据：先导出现状态并在新目录验证，再受控切换。升级回滚与数据恢复是不同操作。

可携带导出包含原件、开放 JSON/JSONL 知识、证据 locator、关系、人工决策与任务回执，保留 ID 对照表。不要求用户安装同版本 DepDek 才拿到原始资料。

删除流程：先墓碑/撤权硬阻断读取与召回 → 传播派生失效 → 清理索引 → 按保留策略回收原件/产物。UI 显示回收站、备份保留和最终删除期限；已经外发的数据不能追回。

## 12. 核心 SQL 附件的限制

SQL 可验证表结构、JSON/状态 CHECK、同空间复合外键、来源去重及行动幂等约束。它不实现 Vault 授权、状态转移、Evidence locator 校验、LinkType 基数、Grant 策略、Job fencing 或敏感读审计；这些必须由受控业务入口实现并测试。

核心 SQL 保留多工作空间键用于迁移/约束测试，生产每库只登记本空间。后续表与索引在版本化 migration 中增加，不能把这份一次性 CREATE 草案直接运行到用户现有库。
