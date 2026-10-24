# Home 文件索引（第一版）

2026-10-21 后续方案见 [NAS 文件接入与自动收纳提案](agentos-v2/nas-file-ingestion-design.md)：计划统一跨终端接收、后台理解与逻辑归类。本文件以下仍是当前原生实现契约，64 MiB 导入上限和 user-only 边界未因提案改变。

本文件补充 `contract.md` §3，数据边界与审计以 Vault 为准。仅原生 Tauri 用户入口，不注册 sidecar 工具、不开放 Webdesk 或 R1 服务权限。

实现状态（2026-10-18）：Vault 模块、redb 数据表、Tauri commands、TypeScript API 与生产文件页已接入。生产页的“建立文件索引”会显式触发一次真实 Home 扫描；文档/图片/视频分类页在存在成功快照时通过持久化分类索引读取。用户已确认采用家合向导的暖白、墨绿风格，规格见 `DESIGN.md`。布局稿入口为 `scripts/preview-file-manager.mjs`（本机 1428 端口），文件为 `scripts/fixtures/FileManagerDraft.tsx`；布局稿仍是显式占位符、不读真实文件。没有默认自动全盘扫描。

2026-10-19 默认流程增量：原生文件页和宝箱提供“添加资料”，系统文件选择完成即表示本机保存与分类意图，不再另问扫描/哈希许可。新命令 `file_library_import` 只接受所选文件的字节与文件名；Rust 在 `我的资料/<operationId>/<name>` 创建不覆盖的副本，自动计算 SHA 并增量提交文件、分类和 SHA 索引。不会因此扫描其它 Home 内容、调用模型或扩大 Agent 权限。浏览器布局预览没有原生接口时明确不可导入；Webdesk/R1/sidecar 暂不新增同名入口。现有 Home 的完整扫描收进次要的“整理现有 Home”操作，浏览与更新列表本身不触发全盘扫描。

## 存储与数据

采用嵌入式 redb KV 库，派生索引与人工数据放在 `<Home>/.depdek-file-index/index.redb`。该私有目录不可通过普通 Vault 文件接口读取、写入、搜索、压缩或删除。索引不是原件备份，原件始终是真实来源；本版不按请求打开 Home 外的路径、不移动原件、不做内容生成或模型识别。`files/sha/category` 可重建，但照片标注和导入回执不是派生缓存，不能随意删库重建；备份须包含整个私有库。

- `files_v1`: key = Home 相对 POSIX 路径，value = JSON FileIndexRecord。
- `sha_v1`: SHA-256 → 路径集合。相同内容多个路径保留多条记录。
- `category_v1`: 分类 → 路径集合。
- `meta_v1`: `summary` → JSON FileIndexSummary。
- `imports_v1`: operationId → 本次导入的文件记录；幂等回执，不能作为可随意清除的缓存。与人工照片标签一同备份。
- `video_tags_v1`、`video_stories_v1`：人工视频标签与有序故事原片引用；同样不是可删缓存，必须随私有 KV 备份。规则与本机命令见 [视频模块](video-library.md)。不影响 files/sha/category 的可重建性。

`FileIndexRecord`: `{path, original_path, name, sha256, category, detected_by, size, modified_ms, indexed_at_ms}`。`path` 为当前 Home 内相对路径；`original_path` 为此路径首次索引时的绝对来源路径；同路径内容修改会刷新哈希而不覆盖首次来源。没有跨路径移动身份追踪：改名在下次扫描中视为删除旧路径/增加新路径。索引不保存内容、密码或 API Key。

新增可选 `file_id`：新导入实例使用 operationId，完整刷新保留同路径已有 ID。浏览器文件选择不会提供可靠的绝对源路径，因此导入记录的 `original_path` 仅保存客户端文件名，不能据此打开服务器路径；UI 称为“原始来源”。旧 Home 扫描记录仍保存原有绝对路径。当前未实现跨路径改名对账，不宣称 file_id 已能自动追踪外部移动。

`category`: `photos | documents | videos | mail | other`。优先有限魔数识别常见照片/PDF/视频；其余按扩展名识别；DepDek `mail/<account>/*.md` 有 Markdown 标题及 From/To/Date/UID 元数据，或纯文本邮件头与正文标记时识别为邮件（附件仍按实际类型分类）。未知二进制进入 `other`。`detected_by`: `signature | extension | depdek_mail | fallback`；不是 OCR/语义分类，也不把扩展名推断冒充内容验证。

`FileIndexSummary`: `{indexed_at_ms, total, total_bytes, categories: {photos, documents, videos, mail, other}, skipped}`。未建立索引时返回零值，不隐式启动扫描。

新增 `coverage: imports | home_snapshot`：新库只登记用户添加的资料时为 imports，显式完整扫描成功才为 home_snapshot；旧快照按 home_snapshot 兼容。indexed_at_ms 表示最近一次索引提交，不代表所有原件此刻均未变化。界面使用“已收纳/可查找”表达能力，不将分类称为内容理解。

查询摘要还返回 `library_id`（当前规范化 Home 的不透明哈希，只用于防止旧批次串写，不是认证凭据）。导入批次开始时读取一次并固定传入每次 `file_library_import`，Vault 在当前 Home 锁内复验；切换 Home 后旧批次失败，不能静默改投新位置。服务端不根据客户端的 libraryId 打开路径或选择任意空间。

导入上限：单文件 64 MiB，前端一次最多选择 100 个文件，逐个读取与提交；不是大文件分块上传实现。operationId 为 32 位小写十六进制；name 为单段、非隐藏且非凭据/数据库名称，UTF-8 最多 240 字节。Base64 在解码前检查长度，解码后复核大小。入口只允许原生 user 会话，Vault 检查登录、固定目标目录、所有者/权限、nofollow、单链接和持久审计。先写意图审计，再暂存、fsync、无覆盖发布并 sync 目录；索引及幂等回执在一个 redb 事务内提交。原件已发布而索引提交失败时保留副本，同 operationId 重试核验后补记；不返回成功、不重新命名制造第二份副本。既有回执的文件被删除或修改时拒绝幂等重放，不静默恢复或覆盖用户后续更改。审计只写逻辑操作主体，不写文件正文和客户端文件名。

## 查询与刷新

2026-10-21 内容分析增量：图片、视频、文档共享 content_annotations_v1，详见 [AI Content Agent](ai-content-agent.md)。生成结果绑定路径和内容 SHA，原件变更时不附到新版本；全库/照片/视频/资料查询加入 AI 标题、描述和标签的匹配。人工照片/视频标签独立保留，索引刷新不覆盖内容标注记录。

- `file_index_query` 的 `filter` 可选。`category` 必须为上述枚举；`sha256` 是完整 64 位十六进制（大小写归一）；`path_prefix` 是非绝对、无 `..` 的 POSIX 目录前缀；`query` 最长 256 字符，按文件名/路径不区分大小写子串匹配，或 SHA 前缀。`offset` 默认 0；`limit` 默认 100，范围 1–200；结果按路径排序。SHA/分类走二级索引，目录前缀走主键范围，组合条件取交集。
- 刷新在后台线程串行执行，流式计算 SHA-256，单次最多 50,000 个文件、64 GiB 内容、目录深度 64；循环活动检查 300 秒预算（不是中断内核阻塞 I/O 的硬超时）。超限/读取失败/文件扫描中变化会返回错误，保留上次完整快照；不会把部分扫描冒充成功。刷新完成才在一个事务内替换主表和二级索引，清除已删除的路径。
- 分类与哈希只保证上次成功扫描时的快照；本版不含目录常驻监听，新增/修改/删除后需刷新。不做默认自动全盘扫描。

## 安全

只允许 session `user`，且受原生 AI-OS 登录门禁约束。所有路径检查、DB 打开、扫描、SHA 和记录读取都在 `vault/file_index.rs`（Vault 内部模块）；先认证再读取任何索引。Unix 逐组件 nofollow 描述符打开，拒绝非普通文件、符号链接、硬链接；非 Unix 当前显式返回不可用，不使用不安全降级。

隐藏路径、凭据/控制文件、`secrets`、`settings`、`mcp`、`team`、`schedule`、数据库/环境文件、内部个人信息/记忆/Agent 会话目录不索引。`mail` 允许邮件正文与附件，但账号、索引、发信草稿不进入文件索引。每次查询/刷新成功或失败均审计；扫描原件逐文件记录 read 审计，内容与绝对来源路径不写入审计主体。返回数据前重新检查登录与 Home，失败不释放快照。本版不宣称抵御同 uid 恶意进程或提供多用户 ACL。

私有索引目录与文件仅当前用户可读写。redb 自带排他锁；已有锁、损坏或版本不支持报错，不自动覆盖修复。错误遵循 VaultError 的既有 E32001/E32003/E32006/E32602/E32603 格式。

## 验证

2026-10-18 宝箱增量：新增 `photo_library_query`、`photo_preview`、`photo_tags_set`，契约见 `contract.md` §3。手工标签保存在独立 `photo_tags_v1` 表，不参与索引刷新替换；绑定路径与 SHA，仅匹配当前内容版本时返回。全库文件索引仍为原有派生快照。照片命令复用用户登录、Home 锁和持久审计，不授予 Agent 文件权限。新增 7 项测试覆盖标签持久化/修正/搜索、重复来源隔离、原件变化、逃逸/符号与硬链接、Home/登录隔离、主动图片格式拒绝、大小上限以及审计不含标签内容。

- 新增 12 项文件索引核心测试：持久化重开、真实邮件格式/五类识别、重复内容、多条件查询/分页、更新/删除同步、失败保留快照、凭据过滤、路径逃逸及私有库保护、锁/损坏/权限拒绝、登录与 Home 隔离。
- 核心全量 137 项单测 + 3 项集成测试通过；内置 llama-server 依赖项 1 项跳过。R1 服务 13 项集成测试通过。
- `cargo check`（含 Tauri commands）、`npm run build`、既有首启/悟空前端 20 项回归通过。没有调用真实云端模型。

### 2026-10-19 · 安静收纳第一批

已接入原生文件页与宝箱的用户选片入口；选择后直接本机保存和增量分类，无额外扫描/哈希确认。文件页提供名称/路径/SHA 搜索、五类计数、每页 100 项与来源详情；导入完成后通知两个页面重新查询。断开原生服务的浏览器预览明确禁用保存，不能用模拟文件或本地状态冒充成功。错误重试保留同一批次 ID；离开页面停止发送剩余文件，已发出的单文件可能完成，重开页面可查询到已提交资料。

新增 8 项 Rust 导入测试覆盖：幂等、来源/标签与重开持久化、冲突及用户修改/删除（包括完整刷新后）、路径与会话拒绝、符号/硬链接、孤立副本对账、锁定登录、Home 切换串写。前端测试覆盖选取上限、串行与局部失败重试、回执核验、离开页面及连接状态。构建与测试结果以当次命令输出为准；未通过真实用户数据或云模型演示来证明能力。

本批回归结果：`node --test scripts/file-library.test.mjs scripts/treasure.test.mjs scripts/ai-os-room.test.mjs scripts/ai-os-setup.test.mjs` 37 项通过；Rust `cargo test --no-default-features` 166 项单测、3 项集成通过，2 项显式联网检查及 1 项依赖内置模型的集成跳过。含默认 Tauri feature 的 `cargo check` 通过。独立文件前端测试入口：`npm run test:file-library`。本批没有进行真实原生窗口手动验收、远端部署或自动重启用户应用。

剩余边界：本次没有实现跨终端写入协议、大文件分块/续传、目录常驻增量监听、跨路径稳定身份对账、OCR/转写/语义描述或敏感保险箱。三类照片场景继续使用已有人工标签与选片草稿，不将文件分类升级宣称为内容理解，不自动生成或导出视频。
