# V2.0 在现有基础上的重构计划

> 范围：工程实施计划，不代表以下能力已完成。第一批 R0 基线/R1 本机只读进度见 [实施记录](implementation-status.md)，第二批可选加密凭据切片见 [第二批记录](implementation-status-batch2.md)；真实用户数据、主写者与目标机部署未改变。

第三批已新增单空间业务会话/目录授权和 loopback Webdesk 代理；整体发布门与剩余项见 [第三批实施记录](implementation-status-batch3.md)。它不关闭整个 R1，也不等于生产分 uid 委托、对象 ACL 或远程 TLS。

第四批已提供受信同 uid Worker 的短期只读委托、独立固定 RPC 客户端与控制 Profile 引用检查，见 [第四批记录](implementation-status-batch4.md)。它不提供 API Key 租约/模型出口或生产 Worker 沙箱，也不切换旧主写者。

第五批新增 Linux 独立 uid 受限 listener、默认关闭的 exact-input 本机模型出口及合成 Provider/容器验收，见 [第五批记录](implementation-status-batch5.md)。API Key 在 core 内部限定回调中使用，轮换/撤销排空已有请求；不放行云端/DNS/自动重试，不接旧引擎/真实配置，不等于完整生产 Credential Lease/Gateway。

## 1. 重构策略

采用“提取核心 → 兼容代理 → 只读投影 → 按领域切主写 → 退出旧写入”的渐进路线。禁止一次重写 Tauri、Webdesk、sidecar 和全部数据格式；禁止新旧程序同时写同一领域。

首个闭环选择家庭物品凭证：导入 → 识别 → 确认 → 关联物品 → 价值说明 → 授权查询 → 维修资料包/待办。不依赖必须能跑大模型的低端 NAS，不要求先完成向量数据库或全部 NAS 设备功能。

代码路径移动不是完成度指标。验收以用户事务、权限、回执、恢复和 CLI/UI 等价为准；Pi/Harness 的能力按真实探测，不凭名称宣称相同。

## 2. 当前模块到目标模块

| 现有路径 | 保留/拆分 | 目标及兼容规则 |
|---|---|---|
| `src-tauri/src/vault.rs` | 先保持文件与测试，再提取 | `depdek-core::vault`；唯一数据访问边界，旧命令代理调用 |
| `src-tauri/src/audit.rs` | 保留旧导出，增加可靠写入 | audit outbox、失败门禁、轮转；旧 JSONL 可读取 |
| `src-tauri/src/rpc.rs`、`app.rs` | 协议/GUI 与业务拆开 | v1 stdio Adapter/Tauri 客户端；不改旧 ID 空间 |
| `src-tauri/src/settings.rs` | 配置与秘密分离 | control profiles + Secret Store，普通配置只存引用 |
| `src-tauri/src/memory.rs` | 保持 JSONL 事实源 | 真正追加/恢复、权限守卫、SQL 只读投影 |
| `src-tauri/src/obsidian.rs` | 保留列表/读内容/错误处理 | Vault 外部只读资源 + 版本化解析；不新增隐式写回 |
| `sidecar/src/sessions.ts`、`tools.ts` | Pi 逻辑保留，工具改受控请求 | Worker/EngineAdapter + Manifest；无 fs/bash |
| `sidecar/src/harness.ts`、`context.ts` | 保留隔离/有界装配 | Harness Adapter + ContextService/Gateway；工具支持经可行性门 |
| `sidecar/src/mail.ts`、`calendar.ts` | 复用协议库与解析 | Connector Worker；落盘经 core，凭据走租约 |
| `sidecar/src/todo.ts` | 先保留主写与去重 | Task 只读投影，然后一次切换为命令主写 |
| `src/taskTypes.ts`、`DepDekHome.tsx` | UI 展示保留 | Job 查询/订阅；旧 history 仅作 historical_run |
| `DepDekAiOsShell.tsx`、AgentTeam UI | 保留可用交互组件 | 目标 Shell、PanelSpec、Agent/技能/任务统计 |
| `webdesk/src/`、`webdesk/web/src/` | 保留独立服务/桌面窗口/指标 | BFF 转发业务；不取得 Home/主库/秘密文件权限 |
| `agent-service/` | 先协议适配，不立即删除 | Worker Adapter + Gateway；现有 config broker 渐迁 |
| `space-service/` | 复用 Blob/资源实现 | Vault handle 存储后端；关闭 direct 并发主写入口 |
| `os/` | 保留 Debian/启动/安装/语音资产 | NAS 包/权限/服务/备份/更新/硬件矩阵逐步补齐 |
| `docs/contract.md` | 仍为桌面已发布唯一契约 | 实现接口扩展时同批更新；设计草案不覆盖它 |

## 3. 交付顺序与退出条件

### R0：基线与可行性门（先于大规模搬迁）

交付：固定代码/依赖基线、现有契约测试清单、数据格式盘点、威胁模型、代表性家庭测试材料；验证 Harness 版本的自定义工具/模型代理/公开事件能力。

- 比较 Pi 与 Harness 执行同一只读请求：真实 engine/runtime/model、输入摘要、事件与 usage；无 usage 显示未知。
- 测试 dsh 无原始文件/shell/web 工具、不能直接连外部 Provider；失败则保持 text-only，不恢复危险默认工具。
- 确认 SQLite/FTS5 版本、安全更新方案、中文短查询回退与目标设备资源上限。
- Linux OS 与桌面数据根、服务账号、Secret Store 解锁模式明确，不能拿开发机 root-only env 等同生产加密。

退出条件：全部现有测试基线可复现；技术不可行项有明确降级，不以假功能进入 R1。此阶段不更改用户数据主写。

### R1：业务核心、凭据与单一入口

交付：非 GUI depdekd、Vault 核心提取、身份/委托、核心 Command Hub、Secret Store write-only 接口、可靠审计与旧客户端 Adapter。

- 先补 Secret Store 导入/轮换/拒绝回显；迁移桌面 Provider、邮件与日历明文配置。成功验证前不删旧数据；验证后去掉普通配置 secret 并说明可恢复备份风险。
- 引入 workspace 注册与受管资源句柄，把 Obsidian 只读根纳入 Vault；阻止内部 DB/记忆/审计被通用文件工具读写。
- Tauri 在 daemon 模式仅调用 core；Webdesk 无原件目录权限，经用户身份代理。兼容模式与 daemon 模式由锁/注册检查互斥。
- UI/CLI 都用 Manifest；GET health 最小公开信息，首启无默认密码，退出/撤销/CSRF 测试完成。

退出条件：原功能可用、凭据不回显、未经授权读被拒绝、Vault 逃逸测试通过、关闭 GUI 不停止核心服务；不存在两个主写者。

### R2：来源版本与可恢复理解流水线

交付：空间核心 DB、封存 Blob/SourceRevision/Evidence、上传/目录接入、持久 JobStep、event/audit outbox、全文索引与权限过滤。

- 先迁一个工作空间、一种导入类型。PDF/图片接入成功立即可查看原件，解析/OCR 按队列逐步完成。
- 单步骤可重入、租约 fencing、worker crash 恢复；上传/接入游标提交后才推进。
- 备份与恢复演练在此阶段开始，不等到 OS 发布前补。
- 向量不是前置条件；家庭检索基于授权原件与全文，不夸大语义检索完成度。

退出条件：重启/重复导入不重复创建版本或对象；旧 worker 回写被拒；失败可局部重试；修正与撤权立即使派生结果失效；原件完整可导出。

### R3：家庭知识与第一条可信事务闭环（V2 核心验收）

交付：家庭领域包、对象/断言/证据/关系、冲突确认、价值说明、维修资料包与待办、Plan/diff/Grant/Receipt、Shell 右侧交互。

- 导入发票后关联物品；来源与手填日期冲突保留，用户选定不会覆盖旧证据。
- “帮我准备客厅空调维修资料”能在语音/文本/CLI 三种入口完成，缺资料明确列出。
- Agent 表达简短、有温度，但事实、待确认、执行进度与结果由服务驱动。
- 家庭成员不能从搜索计数、关系、面板、摘要或下载窥见别人私人材料。
- 资料包、待办本地可补偿；售后草稿不自动发出。

退出条件：本计划第 7 节首发闭环全部通过。R1–R3 是最小完整 V2 业务能力；不把尚未验证的全盘恢复或 SMB 管理宣传为生产完成。

### R4：共享记忆、执行器平级与应用协议

交付：统一 Context/Gateway、两个 Engine Adapter、权限化工具、JSONL 记忆治理/投影、Obsidian 图谱、真正有界 compact、应用 Manifest/媒体视图。

- Pi/Harness 使用同一 Run/Job/Context/Grant/Receipt，不各养一份长期记忆。
- Harness 支持不足仍按能力标签呈现；桥接工具成功前不开放文件/邮件写入技能。
- 动态输出只保留单一工具框；完成全文校准流式字符顺序，断线恢复不重复打印。
- myinfo/mydata 是兼容视图，长期记忆只有既定事实源；候选不默认进上下文。
- Obsidian WikiLinks/Properties/block 投影可追溯、可纠正、撤权有效；原笔记不变。
- 文件、音乐、视频、照片管理都从 CLI/命令可驱动，UI 只负责输入/结果。照片识别另受模型与解析能力约束。

退出条件：同一事务换引擎不改变授权/资料来源；流顺序/compact/墓碑过滤验证；无 key/路径旁路；真实任务统计与 token 缺失状态正确。

### R5：NAS OS 生产化与外部事务

交付：受支持 Debian 镜像、首启/安装/网络/SMB、磁盘管理、备份与携带导出、锁定/解锁、签名更新/回滚、Device broker、外部发送与查证。

- 至少一个目标低端 x86 与一个较高性能设备的真机安装、断电与换机恢复演练；硬件支持清单明确 BIOS/UEFI/磁盘/NIC。
- 数据盘锁定只允许最小管理；队列 waiting_unlock，不能为了后台同步隐式解密。
- 共享目录与内部权威库隔离；照片应用权限不等于磁盘格式化权限。
- 发送邮件等外部操作遇到超时进入 unknown，支持查证和人工恢复；无安全重试条件不能自动重发。
- 在线备份、损坏恢复、管理员恢复、磁盘不足、升级失败与回滚不丢新数据。

退出条件：OS 发布矩阵与全部恢复测试通过，安全敏感缺陷清零；发布清单列出本地/云端默认策略和每种硬件的能力，不承诺 N3160 流畅运行 7B 模型。

### 后续扩展（不阻塞首发）

手机增量备份、家庭故事、可选向量检索、复杂自动化、多设备同步、A/B 升级、企业数据库后端、第三方 MCP 应用。每项必须继承同一权限/证据/命令/备份模型。

## 4. 数据迁移与单主写切换

每个领域独立使用以下流程；迁移期间不让两份数据相互“同步覆盖”。

| 步骤 | 操作 | 权威写入者 |
|---|---|---|
| M0 | 数据盘点、稳定备份、权限映射、hash 清单 | 旧服务 |
| M1 | 导入/只读投影，产生 old_id → new_id 对照 | 旧服务；新库不能接受该领域业务写入 |
| M2 | 对比数量/哈希/关系/来源、权限和抽样业务结果 | 旧服务 |
| M3 | 短维护窗停该领域写入、封存末序号、补齐增量 | 两边都不写 |
| M4 | 打开 daemon 独占写锁，旧 API 改成调用新命令 | 新服务 |
| M5 | 观察、备份验证、旧数据只读保留，最终归档 | 新服务 |

连接游标、Todo 去重键、记忆事件 ID、SourceRevision、人工确认与 Task 历史必须有对照。旧 running TaskRecord 转为历史失败/中断标记，不自动恢复发送。space-service direct writer 和桌面本地 writer 必须在 M4 被锁拒绝，不能只在 UI 隐藏按钮。

回滚分界：M4 前可撤回只读投影；M4 后优先回滚二进制并使用兼容的新 schema。要退回旧权威库，先停写、备份新状态并运行经验证的反向导出；不能恢复旧备份丢掉切换后的新增数据。不可反向导出的 schema 采用前向修复，不承诺无条件旧版本运行。

秘密迁移不把明文扩散到新数据库/日志。导入源留存仅在受保护迁移备份中，用户知晓；更新契约 §7 和各 Provider/calendar 约定必须与实际实现一起完成。

## 5. 契约与模块变更纪律

1. 先注册命令/数据 migration、兼容语义和测试，再改变调用方。
2. 桌面 Rust/sidecar/React 的接口变化同批更新 contract.md 并测试三方；Webdesk 独立契约另更新。
3. 协议类型由 Schema 生成，业务/授权逻辑不能放在生成包。
4. Vault 位置提取时同步 AGENTS 指引与原测试，不能在 Worker/存储后端新建替代安全入口。
5. VERSION 仍是软件版本唯一来源；产品 V2 设计不提前把运行程序标成 2.0。

## 6. 可观测性与发布门

每个功能报告真实 source/adapter/provider/版本；Agent 宣称“完成”必须有实际 Job/Receipt。指标包括入库完整率、识别修正率、证据覆盖、查询延迟、任务恢复、权限阻断、磁盘增长、审计导出滞后。usage/费用不可用显示 unknown。

为代表性硬件定义 CPU/RAM/磁盘配额与 SLA 后实测再发布；设计文件不编造 token/s 或查询毫秒保证。后台解析能暂停/限速，语音与交互任务优先。

## 7. 必须验证场景

| ID | 场景 | 必须结果 |
|---|---|---|
| V2-01 | 发票导入/重新导入 | 原件 hash 不变；同来源版本不重复 |
| V2-02 | 两个来源购买日期冲突 | 两断言与证据都在；不静默覆盖 |
| V2-03 | 人名相同/共享邮箱 | 不误合并；确认合并可拆分并失效重算 |
| V2-04 | PDF/OCR Worker 崩溃、旧租约回写 | 原件接入仍成功；局部恢复；旧回写被拒 |
| V2-05 | 用户纠正型号/日期后查询 | 旧产物标 stale，资料包不复用过期事实 |
| V2-06 | 家庭成员读取私人对象 | 搜索、统计、关系、面板、摘要、下载均不泄露 |
| V2-07 | 排队后撤权/来源修正 | 执行时阻断或重新确认；旧 grant/cursor 不放行 |
| V2-08 | Agent/文件工具碰内部库或 Secret | 拒绝并审计；path traversal/symlink 不绕过 |
| V2-09 | 200 个本地整理动作 | 一次精确 diff 授权 + 范围/数量限制，不 200 次盲点 |
| V2-10 | 同键重复 apply / 参数变化 | 同输入同 Job/Receipt；变参 CONFLICT |
| V2-11 | 外部发送成功但响应丢失 | unknown；核验前不自动重发 |
| V2-12 | 墓碑/撤权后向量索引尚未清理 | query/get/Context/外发硬过滤 |
| V2-13 | Pi 与 Harness 同任务 | 实际能力可查；相同权限/Context/治理；不偷偷换模型 |
| V2-14 | 多字节流分片、断线重连、重复事件 | 中文/邮箱不乱序，最终全文一致；事件去重 |
| V2-15 | 超长会话与 /compress | compact 实际减小上下文，原历史/证据保留，无隐式记忆确认 |
| V2-16 | Obsidian 外部修改/删除 | 版本与图投影更新；用户笔记未被写回 |
| V2-17 | 备份/换机/恢复未知外部任务 | 数据可携带、引用校验通过，默认不重放外部效果 |
| V2-18 | 加密盘重启未解锁、磁盘满、审计不可写 | 安全停等/拒绝；不旁路继续执行 |
| V2-19 | CLI/语音/UI 准备空调资料 | 同命令语义、证据/未知项、资料包/待办/回执 |
| V2-20 | Provider 保存、轮换、模型测试 | 无密钥回显/日志；授权模型实际收到选定最小输入 |

这些是实现验收要求，当前文档验证不能将它们标记为通过。

## 8. 第一批代码实施切片与后续

首先做 R0 与 R1 中的一条只读路径：`Webdesk/CLI → 身份委托 → depdekd → 现有 Vault → source/file 查询 → 审计 → Result`。同时完成 Secret Store 明文导入的设计验证与测试夹具。只有这条可信通路跑通，才推进来源 DB 和家庭知识写入。

当前已打通 `CLI → 本机 owner uid → depdekd → ManagedReadVault → file 查询 → 严格审计 → Result`，增加加密凭据管理/合成暂存导入、loopback BFF 业务会话与 Worker 文件票据。第五批验证 `独立 uid/禁网络 Worker → 固定 Unix listener → 一次性精确文本授权 → core 内部 Key 使用 → 合成本机 Provider → 结果`；控制 Profile catalogue 本身仍不是连接测试。下一步是受控云端出口/TLS、实际 Pi/Harness 与 Context 接线、持久身份/对象 ACL、控制 Profile 写入与独占 Adapter、显式真实迁移恢复；再讨论领域主写切换。Linux 容器门不代替 NAS 真机/完整 OS 发布，暂存导入不是已迁移。

不得在首个切片顺便更换所有 UI、引入图数据库、重做镜像安装器或开放无约束 MCP。终态可以宏大，每次切片必须可测试、可恢复、可解释。
