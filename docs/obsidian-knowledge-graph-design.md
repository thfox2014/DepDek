# DepDek × Obsidian 知识图谱深度集成设计

> 版本：Draft 0.1 · 2026-08-17

## 1. 结论

可以深度集成，而且 Obsidian 很适合作为 DepDek 的“人类可编辑知识源”：

- Obsidian Vault 仍由用户持有，Markdown 是原始事实源；
- DepDek 读取笔记、Properties、标签、WikiLink、附件和任务，构建可重建的知识图谱；
- Agent Team 读取图谱的派生结果，不直接扫描整个 Vault；
- AI 只提出关系、标签和摘要建议，默认不改写 Obsidian；
- 用户确认后，才允许通过显式操作把结果写回笔记。

当前工程的 `ObsidianStore` 已具备安全的只读连接、Markdown 列表/读取、隐藏目录过滤和审计。下一步不是替换它，而是在上面增加解析器、索引和来源回溯。

## 2. 为什么使用 Obsidian 原生格式

Obsidian 原生支持 `[[WikiLink]]` 和标准 Markdown 链接，也支持在 Properties/YAML 中保存结构化字段和链接。DepDek 可以直接理解这些开放文本，不需要依赖 Obsidian 私有数据库或插件才能还原知识关系。

参考：[Obsidian Internal links](https://obsidian.md/help/links)、[Obsidian Properties](https://obsidian.md/help/properties)。

## 3. 集成边界

### 默认模式：只读索引

```text
Obsidian Vault ──读取 Markdown/Properties──> Rust ObsidianStore
                                           │
                                           ├─> Graph Extractor
                                           ├─> FTS5 / graph index
                                           └─> Agent Context Assembler
```

默认不修改原 Vault，不读取 `.obsidian/`、`.trash/`、`.git/`，不执行 Dataview/Templater/插件代码，不让 Agent 获得 Vault 的绝对路径或任意文件工具。

### 可选模式：用户确认后写回

写回只能通过 DepDek Action/Approval 队列：

1. AI 生成具体 diff，例如“在 `项目/DepDek.md` 增加 `[[个人数据主权]]`”；
2. UI 显示文件名、行号、旧内容、新内容和来源；
3. 用户确认后由 Rust 校验路径、hash 和冲突状态；
4. 写入前创建本地回执和备份，写入后重新扫描图谱；
5. 写入失败不覆盖原文，保留失败 diff。

这条路径不把“知识图谱”变成自动重写器。

## 4. 图谱数据模型

图谱是 Obsidian 的派生索引，不是第二份笔记内容。建议保存到 DepDek Home：

```text
knowledge/obsidian/manifest.json       连接、扫描游标和 schema 版本
knowledge/obsidian/events.jsonl        节点/边/删除事件，开放格式事实源
knowledge/obsidian/index.sqlite       FTS5 + 节点/边索引，可重建
knowledge/obsidian/exports/            Graph JSON、CSV、Markdown 导出
```

节点：

```json
{
  "id": "obsidian:项目/DepDek 产品规划.md",
  "kind": "note",
  "title": "DepDek 产品规划",
  "path": "项目/DepDek 产品规划.md",
  "aliases": ["DepDek 规划"],
  "tags": ["#产品", "#本地优先"],
  "properties": {"status": "active"},
  "content_hash": "sha256:...",
  "modified_ms": 1780000000000,
  "source": "obsidian"
}
```

边：

```json
{
  "id": "edge_01J...",
  "from": "obsidian:项目/DepDek 产品规划.md",
  "to": "obsidian:概念/个人数据主权.md",
  "kind": "wikilink",
  "source_ref": "项目/DepDek 产品规划.md#L18",
  "status": "confirmed",
  "confidence": 1,
  "created_by": "obsidian-parser"
}
```

AI 推断的边使用 `candidate`，必须确认后才进入 Agent Team 的默认图谱上下文。解析到的原生 WikiLink/Properties 是 `confirmed`，但仍保留源文件位置。

## 5. 需要解析的 Obsidian 内容

### P0：确定性解析

- Markdown 标题、段落和代码块边界；
- `[[笔记]]`、`[[笔记|别名]]`、`[[笔记#标题]]`、`[[笔记#^块]]`；
- `[标题](相对路径.md)` 和 `![[附件]]`；
- YAML frontmatter / Properties：`tags`、`aliases`、日期、状态、链接字段；
- 普通标签 `#tag`；
- 任务项 `- [ ]`、`- [x]`；
- 附件节点和所在笔记的引用关系。

### P1：跨域归一

- 邮件 ↔ Obsidian：按主题、发件人、附件名、用户确认的项目别名提出候选关系；
- 日历 ↔ Obsidian：按事件标题、日期、项目标签关联；
- 待办 ↔ Obsidian：把任务状态和来源块建立双向回溯；
- 文件 ↔ Obsidian：把附件、PDF、图片和笔记中的 embed 统一为 `Document` 节点。

### P2：语义关系建议

本地模型只输出候选：`related_to`、`supports`、`contradicts`、`derived_from`、`part_of`。建议必须给出：原文片段、来源路径、置信度和为什么建立关系。

## 6. 增量同步

首版使用“打开知识页扫描 + 手动刷新”保证稳定性：

1. `ObsidianStore.list_notes` 返回 path、size、mtime；
2. 对新增或 mtime/hash 变化的 Markdown 重新读取和解析；
3. 对删除的路径追加 tombstone 事件；
4. 未变化的文件不重复解析；
5. 通过 `manifest.json` 保存最后扫描时间、Vault hash 和 parser 版本。

后续再加平台文件监听。监听失败时必须自动回退手动刷新，不影响用户读取 Obsidian。

## 7. Agent Team 如何使用 Obsidian 图谱

`ContextAssembler` 不把整个 Vault 塞进 prompt，而是：

1. 根据用户问题抽取关键词、当前邮件/任务/日历实体；
2. 查询 `memory/query` 和 `knowledge/query`；
3. 先返回一跳关系和直接来源，最多扩展到两跳；
4. 把笔记内容按段落/标题截取，带 `source_refs`；
5. 本地 Agent 默认可用；云端 Agent 需要单独确认外发哪些笔记片段。

示例上下文：

```text
[来源 1] Obsidian: 项目/DepDek 产品规划.md#L18-L27
[关系] 该笔记链接到 [[个人数据主权]]，并标记 #产品
[来源 2] mail/QQ邮箱/1739.md#body
[候选关系] 邮件主题包含“DepDek”，可能属于该项目（置信度 0.76）
```

## 8. DepDek UI

在“知识 / Obsidian”页面增加四个区域：

- **笔记浏览**：延续当前左侧列表、右侧 Markdown 预览；
- **关系面板**：选中笔记后显示反向链接、引用附件、相关邮件/日历/待办；
- **图谱视图**：默认显示当前笔记的一跳关系，支持筛选节点类型；
- **AI 建议**：候选标签、候选链接、摘要和冲突提示；每条带“确认 / 忽略 / 查看来源”。

图谱视图只作为导航，不替代 Markdown 编辑。节点点击后应能回到 Obsidian 源文件，写回操作必须进入统一任务框架。

## 9. 建议增加的接口

在现有 `obsidian/*` 只读接口之上增加：

| 方法 | 用途 |
|---|---|
| `obsidian_scan` | 增量扫描并更新图谱 |
| `obsidian_get_metadata` | 读取单笔记 Properties、标签、标题和链接 |
| `knowledge_query` | 按节点、关键词、来源和关系类型查询 |
| `knowledge_neighbors` | 查询一跳/两跳关系 |
| `knowledge_propose_edge` | Agent 提议候选关系 |
| `knowledge_confirm_edge` | 用户确认关系 |
| `obsidian_write_patch` | 经审批后按 hash 写回单个 diff |
| `obsidian_open` | 生成安全的 `obsidian://` 打开链接 |

所有方法都经 Rust 路径校验和审计；sidecar 不直接读文件系统。

## 10. 不建议的做法

- 不把 Obsidian 全量复制进 DepDek Home，避免出现两份原文；
- 不依赖 `.obsidian` 内部数据库或插件私有缓存；
- 不默认安装需要本地 HTTP 端口的 REST 插件；
- 不让 LLM 直接写 WikiLink、Properties 或移动文件；
- 不把模型推断关系伪装成原生链接；
- 不为了图谱一开始引入 Neo4j、Qdrant 或独立服务。

## 11. 迭代建议

### V0.3.1：读懂 Vault

- Markdown/Properties/WikiLink 解析器；
- 增量扫描和本地 JSONL 图谱事件；
- 选中笔记显示 backlinks、标签、附件和来源。

### V0.4：跨域知识

- SQLite FTS5 索引；
- 邮件、日历、待办、文件的候选关联；
- Agent Team 通过统一 `knowledge_query` 获取上下文。

### V0.5：可控写回

- diff 预览、hash 冲突检测、备份和回滚；
- 生成 Obsidian URI 快速打开源笔记；
- 仅对用户确认的边和 Properties 写回。

### V0.6：语义图谱

- 本地 embedding 和可选 `sqlite-vec`；
- 语义候选关系、重复笔记和孤立笔记建议；
- 图谱质量统计和可解释性报告。

## 12. 验收标准

- 连接 Vault 后不读取 `.obsidian`、`.trash`、`.git`，不执行任何插件代码；
- 修改一篇笔记后，仅重新解析该文件；删除笔记后相关节点和边会失效；
- 原生 WikiLink 可回到准确的笔记、标题或块；
- AI 候选关系不会自动出现在 confirmed 图谱；
- 云端模型未确认时，不发送 Obsidian 正文；
- 删除派生索引后可以从 Vault 和 JSONL 事件重建；
- 任意 Agent 都不能越过 Rust 读取 Obsidian 绝对路径或写入原 Vault。
