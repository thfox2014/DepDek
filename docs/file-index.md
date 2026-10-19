# Home 文件索引（第一版）

本文件补充 `contract.md` §3，数据边界与审计以 Vault 为准。仅原生 Tauri 用户入口，不注册 sidecar 工具、不开放 Webdesk 或 R1 服务权限。

实现状态（2026-10-18）：Vault 模块、redb 数据表、Tauri commands、TypeScript API 与生产文件页已接入。生产页的“建立文件索引”会显式触发一次真实 Home 扫描；文档/图片/视频分类页在存在成功快照时通过持久化分类索引读取。用户已确认采用家合向导的暖白、墨绿风格，规格见 `DESIGN.md`。布局稿入口为 `scripts/preview-file-manager.mjs`（本机 1428 端口），文件为 `scripts/fixtures/FileManagerDraft.tsx`；布局稿仍是显式占位符、不读真实文件。没有默认自动全盘扫描。

## 存储与数据

采用嵌入式 redb KV 库，派生索引放在 `<Home>/.depdek-file-index/index.redb`。该私有目录不可通过普通 Vault 文件接口读取、写入、搜索、压缩或删除。索引不是备份，原件始终是真实来源；本版不导入 Home 外的路径、不移动原件、不做内容生成或模型识别。

- `files_v1`: key = Home 相对 POSIX 路径，value = JSON FileIndexRecord。
- `sha_v1`: SHA-256 → 路径集合。相同内容多个路径保留多条记录。
- `category_v1`: 分类 → 路径集合。
- `meta_v1`: `summary` → JSON FileIndexSummary。

`FileIndexRecord`: `{path, original_path, name, sha256, category, detected_by, size, modified_ms, indexed_at_ms}`。`path` 为当前 Home 内相对路径；`original_path` 为此路径首次索引时的绝对来源路径；同路径内容修改会刷新哈希而不覆盖首次来源。没有跨路径移动身份追踪：改名在下次扫描中视为删除旧路径/增加新路径。索引不保存内容、密码或 API Key。

`category`: `photos | documents | videos | mail | other`。优先有限魔数识别常见照片/PDF/视频；其余按扩展名识别；DepDek `mail/<account>/*.md` 有 Markdown 标题及 From/To/Date/UID 元数据，或纯文本邮件头与正文标记时识别为邮件（附件仍按实际类型分类）。未知二进制进入 `other`。`detected_by`: `signature | extension | depdek_mail | fallback`；不是 OCR/语义分类，也不把扩展名推断冒充内容验证。

`FileIndexSummary`: `{indexed_at_ms, total, total_bytes, categories: {photos, documents, videos, mail, other}, skipped}`。未建立索引时返回零值，不隐式启动扫描。

## 查询与刷新

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
