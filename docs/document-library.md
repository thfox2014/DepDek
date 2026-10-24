# 悟空资料 · 本机闭环契约

补充 `contract.md` §3。只增加原生用户 Tauri commands；sidecar、Agent 工具、Webdesk、R1 不开放同名入口，不调用模型或扩大授权。

2026-10-21 增量：原文预览和搜索保持本机行为；打开单份资料后提供「AI 自动标注」，通过独立 [AI Content Agent](ai-content-agent.md) 按需分析 UTF-8 文本/PDF。AI 描述和标签独立存入共享内容标注表，支持搜索和人工修正，不混作原文摘录、用户确认事实或长期记忆。Office 正文解析仍未实现。

## 事实与来源

所有引用都是 `{path, sha256}`，只接受当前 Home 文件索引中 `category=documents` 的普通文件。路径、安全检查和读取全部在 Vault 内部，复用 nofollow / 单链接 / 登录 / Home 锁和持久审计。每个请求的 libraryId 必须匹配当前 Home；不根据客户端 ID 打开任意目录。文件变动、过期指纹和未知引用失败，不自动重扫或改用同名文件。

正文预览限 16 MiB，UTF-8 文本输出限 128 KiB，截断明确标记；PDF 按魔数确认后返回原字节，由打包的 PDF.js Worker 在本机绘制，禁 eval/XFA、不跟随 PDF 链接、不加载远端资源，不放宽 CSP。Word/Excel 等格式只列出、分组和导出原件，不能称为已解析；没有 OCR 或语义回答。

`document_search` 仅用户显式搜索，query 1–120 字符、无控制字符。名称/路径与用户保存的分组名称、事项标题查找覆盖已索引文档，人工关系仅在内容指纹仍匹配时关联；正文至多读取 20 份、单文件不超过 512 KiB 的 UTF-8 文本，总预算 4 MiB，最多返回 100 项。返回实际检索范围与跳过数；incomplete 为真时不能声称已查遍全部正文。结果是原文行，不是模型答案。搜索不遍历未索引目录，受保护路径（包括 tasks/history.json）始终排除。

## 人工记录

在同一私有 redb 增加 `document_favorites_v1` 和 `document_collections_v1`，不随派生索引刷新清除，需连同人工照片标签备份。常用记录含 path、sha256、favorite、revision、updated_at_ms；绑定当前路径和内容版本，不把另一份同内容来源自动设为常用。

分组/清单含 id、kind（organization/packet）、status（active/reverted）、title、references（可含 group）、missing、revision、updated_at_ms。这是用户保存的引用关系，不是磁盘目录移动、删除或模型语义事实。id 为 32 位小写十六进制；title/group 最多 120 字，引用至多 50 个且 path 不重复，missing 最多 30 条、每条 120 字，禁止控制字符。每种记录最多 200 条。新记录 expectedRevision=0，更新必须等于当前 revision；冲突明确返回 E32602，不能覆盖其它窗口的新改动。撤销只变更该记录状态，允许过期原件被撤回，但不替换历史引用。

取消常用同样允许清理过期引用：必须匹配已存在记录的路径、内容指纹与 revision，仅变更 favorite=false；不打开、删除、恢复或改动原件。设置 favorite=true 仍必须核验当前实际原件。

保存 active 记录、设置常用和导出时核验实际 nofollow 文件与 SHA。单次保存核验总字节上限 64 MiB、每文件 16 MiB，不无限消耗 IO；失败不提交部分 KV。所有成功/失败均审计，逻辑主体不包含文件正文、标题、标签或绝对来源路径。

## 资料包

导出最多 50 份、总计 64 MiB 原件。全部核验通过后才返回 tar.gz；任何文件变化即整体失败，不生成缺失或旧版混杂的包。归档名以序号和已索引文件名生成，不能注入路径；包内 `manifest.json` 记录标题、相对来源、SHA、归档成员与缺项。仅清单明确选择的文档会进入包，不包含目录扫描、凭据或控制文件。没有外部共享链接、自动上传、网络连接或 shell。导出请求只在内存生成归档，由前端显式下载；清单另经 KV 保存，不把“已保存清单”称为已导出文件。

## 降级与错误

遵循 E32001/E32003/E32006/E32602/E32603。锁定或切换空间时失效请求不得继续展示旧资料或发送剩余操作。连接失败保留错误，不显示示例作为降级。原型仍独立注入示例，不以演示回执证明本机能力。

## 实现与验证

实现位于 `vault/file_index/documents.rs`，Tauri 在阻塞工作线程调用，TS 命令在 `src/api.ts`，原生三场景组件为 `NativeDocumentsPanel.tsx`。PDF 使用锁定版本 `pdfjs-dist`，Worker、字体、CMaps 与许可证一起打包，依照 [Mozilla 本机页面绘制接口](https://mozilla.github.io/pdf.js/examples/) 渲染，不使用公共 CDN 或 PDF iframe。

新增核心测试覆盖：真实原文与 KV 重开/刷新持久化、审计脱敏、过期指纹、逃逸/符号与硬链接、并发 revision、可撤销记录、Home 与用户隔离、登录锁定、UTF-8 截断与大小预算、归档内容/来源与失败拒绝、受保护历史排除。前端服务测试另外验证空间快照混用拒绝、选择更新版本时不重复路径、下载 SHA 回执、tar 成员、可重试错误状态及真实 PDF 本机解析。测试不扫描实际家庭数据、不调用真实云端模型；原生窗口手动验收另计，不以服务示例代替。
