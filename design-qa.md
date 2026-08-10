# DepDek UX 重构 · Design QA

## 验证基线

- 视觉真值：`/Users/mac/Downloads/code2025/depdek/source-ux-reference.png`
- 最终实现：`/Users/mac/Downloads/code2025/depdek/implementation-ux-final.png`
- 全屏并排对照：`/Users/mac/Downloads/code2025/depdek/design-qa-comparison.png`
- 局部对照：`design-qa-header-sidebar.png`、`design-qa-content-cards.png`
- 状态：桌面端、浅色主题、Today 默认页、Copilot 默认收起、固定示例数据
- 视口：两侧均为 1280 × 720 CSS px；设备像素比 2

## 对照结论

| 表面 | 结论 |
| --- | --- |
| Typography | 中文系统字体、字号层级、数字时钟和辅助文案密度与原型一致；无影响可读性的差异。 |
| Spacing / layout | 侧栏、顶栏、主卡片 7/5 栅格、卡片圆角和可视首屏高度均与原型一致。 |
| Colors | 主紫色、浅紫底色、暖色风险态、绿色完成态和灰阶层次一致。实现背景略平整，属于 P3 外观差异。 |
| Image quality | 原型中的占位品牌字形已替换为 256 × 256 的真实 DepDek 栅格品牌资产，缩放清晰，无拉伸或裁切。 |
| Copy | 页面结构和关键文案与原型一致；任务进度采用真实完成项计算，因此显示 2/4，而原型静态文案显示 1/4 但同时勾选了两项。这是有意纠正。 |

## 发现与修复历史

1. 初次对照发现实现默认展开 Copilot，而视觉真值默认收起，遮挡任务卡片，评级 P2。已将默认状态改为收起，并重新截图对照。
2. 初次浏览器预览发现 Tauri 事件监听在纯浏览器环境产生控制台错误。已增加浏览器预览守卫，最终页级 error 日志为 0。
3. 第二轮全屏与两个局部并排对照未发现 P0、P1 或 P2 问题。

保留的 P3 差异：品牌占位符升级为正式图像资产；实现背景纹理更克制；任务计数纠正为数据驱动结果。以上不影响原型布局、信息层级或核心路径。

## 交互回归

- 左侧导航：Today ↔ Calendar 可切换，标题与 Copilot 上下文同步。
- 全局指令栏：可打开并展示事实命中与待审批行动。
- Copilot：可打开、关闭并保持本地模型/云端升级边界提示。
- Action Sheet：可打开高风险邮件动作预览并拒绝；原型不会真实调用 SMTP。
- 待办：可切换完成状态，也可通过快速输入新增本地任务。
- Deep Work：可进入原有 Agent 办公室并返回 DepDek 首页。
- 最终浏览器控制台：0 个页面 error。

## 增量验证 · Provider 模型切换

- 最新状态截图：`implementation-model-switch.png`
- Copilot 底部新增模型框，位于输入框和本地执行提示之间，沿用原型的浅紫底、细边框和紧凑密度。
- 选项来源为已接入的 `Settings.providers`，格式为 `Provider · model`；多个 Provider 时可直接切换，空配置时提供“连接一个 Provider 模型”入口。
- 切换后发送的 UX 原型回复会标注当前 `Provider · model`，避免用户误以为仍使用旧模型。
- 回归结果：选择框存在、默认选中当前配置模型、管理按钮可打开 Provider 设置，未产生页面 error。

## 增量验证 · 收件箱

- 最新状态截图：`implementation-inbox.png`
- Deep Work 侧栏不再渲染“我的邮件”；首页“收件箱”现在是完整邮件工作区：账户选择、文件夹、邮件列表、阅读窗格、收取和账户设置。
- 账户配置沿用 `mail/accounts.json` 契约；桌面端通过 `vault/*` 读取/写回，收取继续走 `mail_fetch`，浏览器预览使用本地示例数据，不连接外部服务器。
- 已读、星标、归档等处理状态由桌面端写入可重建的 `mail/index.json`；索引缺失不阻塞原始邮件阅读。
- 邮件列表支持勾选并删除；删除前弹窗明确区分仅本地与同步远端，默认不触发远端写操作；主导航侧栏新增收拢/展开按钮，收拢后保留图标导航。
- 顶部“同步”已替换为“任务”；点击收取邮件会在任务中心显示执行中状态，完成后保留最近任务结果。
- “AI 整理”展示来自本地邮件副本的行动项建议；邮件正文、账户凭据不会发送到云端。
- 回归结果：AI 整理展开、账户设置打开/关闭、收取提示、邮件阅读、星标/归档、收件箱文件夹切换均通过；页面 error 为 0。

## 增量验证 · 文件管理器

- 视觉真值：`/var/folders/zd/5ykxbmjn4818tf0wdm9b2vs80000gn/T/codex-clipboard-6dcd11d6-cd70-4146-af4a-08ca68b87363.png`（2364 × 1458 px）。
- 最终实现：`/Users/mac/Downloads/code2025/depdek/design-qa/file-manager-2026-08-10/02-list-text-preview.png`（1280 × 720 CSS px）；补充状态为 `03-preview-grid.png` 与 `04-image-preview.png`。
- 对照状态：桌面端、浅色主题、文件模块、文档筛选、列表视图、右侧 Markdown 预览。源图与实现图已在同一次视觉检查中打开；考虑视口密度差异，以应用框架、标签栏、工作区层级和预览结构为归一化基线。

| 表面 | 结论 |
| --- | --- |
| Typography | 延续现有中文系统字体和 DepDek 标题层级；表格、元数据、面包屑采用更紧凑的文件管理器密度，无截断或不可读文本。 |
| Spacing / layout | 保留左侧工作台和圆角内容壳，新增“文档”分类、三态视图开关、面包屑、可独立滚动的目录区及固定右侧预览；首屏壳体完整落在 1280 × 720 视口内。 |
| Colors / tokens | 沿用产品紫色、浅紫选中态、白色内容面和灰阶边框；文件类型颜色只用于图标识别，不破坏既有视觉语义。 |
| Image quality / assets | 图片预览使用仓库中的真实 DepDek 品牌资产，保持原始比例，无拉伸、模糊或占位假图。 |
| Copy / content | “文件、文档、图片、视频、个人资料”分类明确；空态、读取范围、审计提示与本地 Home 的产品边界一致。 |

### 发现与修复历史

1. 第一轮全屏检查发现文件壳体高度被内容撑到 1094 px，页面产生外层纵向滚动，评级 P1。已将页面文件壳改为视口约束高度，并让目录区内部滚动；复查壳体底部为 700 px，未越出 720 px 视口。
2. 最终未发现 P0、P1 或 P2 视觉问题。保留的 P3 差异是源图只有树形层级，而实现按本次需求增加了列表、预览卡片和右侧阅读区，属于有意的信息架构升级。

### 交互与运行回归

- 文件标签：文件、文档、图片、视频、个人资料可切换，文档标签会筛选 PDF、Office、Markdown 等文档类型。
- 视图切换：树状、列表、预览三种模式均已实际点击验证；目录区保持独立滚动。
- 目录导航：已进入“出国申请资料”，面包屑显示“我的数据 / 出国申请资料”，并通过“我的数据”返回根目录。
- 右侧预览：已验证 Markdown 文本与 PNG 图片；关闭按钮可回到预览空态，PDF、视频及不支持格式均有对应预览或明确说明。
- 运行状态：Vite error overlay 不存在，React 错误页不存在；浏览器开发日志 `error` 级别为 0。
- 构建验证：`npm run build` 通过，TypeScript 与 Vite 生产构建无错误；`git diff --check` 通过。

## 增量验证 · 收件箱单屏布局

- 视觉真值：`/var/folders/zd/5ykxbmjn4818tf0wdm9b2vs80000gn/T/codex-clipboard-6f23ba0f-9437-47d9-b74a-237a11cae6d2.png`（2048 × 900 px）。
- 最终实现：`/Users/mac/Downloads/code2025/depdek/design-qa/inbox-single-screen-2026-08-10/01-inbox-single-screen.png`（1280 × 720 px，CSS 视口 1280 × 720，deviceScaleFactor 1）。
- 对照状态：桌面端、浅色主题、收件箱、已选择邮件、阅读区底部操作栏可见。两张图已在同一次视觉检查中打开；源图为更宽的实际应用截图，因此以邮件三栏内容区域和底部操作栏位置做密度归一化比较。

| 表面 | 结论 |
| --- | --- |
| Typography | 字体、字号、粗细和截断规则保持现有 DepDek 邮件设计；高度修复未改变信息层级或造成新的折行。 |
| Spacing / layout | 邮件页现在严格占用工作区剩余高度；三栏底部在 720 px 视口内结束，操作栏底边为 701 px，页面总滚动高度为 720 px。邮件列表和正文分别独立滚动。 |
| Colors / tokens | 未改变紫色选中态、灰阶边框和白色阅读面，视觉令牌与源状态一致。 |
| Image quality / assets | 本次目标不涉及新增图像资产；现有图标继续使用统一的 Phosphor 图标库，没有占位图或 CSS 绘图替代。 |
| Copy / content | 邮件、来源、排序和操作文案保持不变；修复只影响视口分配和滚动行为。 |

### 发现与修复历史

1. 初始截图显示邮件内容总高度超过窗口，底部操作区需要滚动整个页面才能稳定看到，评级 P1。根因是 `.dd-inbox-shell` 使用 `height: 100%` 和 `min-height: 550px`，但其上方仍有页面标题和账户工具栏。
2. 已将收件箱改为受工作区约束的纵向 Flex 布局，邮件壳使用剩余高度；补充 `.dd-main` / `.dd-workbench--inbox` 的 `min-height: 0` 和外层 `overflow: hidden`，避免父级被内容撑开。
3. 后续截图复查未发现 P0、P1 或 P2 问题。页脚始终出现在首屏，邮件列表与正文内部滚动，外层页面不滚动。

### 交互与运行回归

- 单屏：视口高度 720 px，`.dd-inbox-shell` 底部 702 px，右侧操作栏底部 701 px，`documentElement.scrollHeight` 为 720 px。
- 邮件列表：固定为剩余区域高度，`overflow-y: auto`、稳定滚动条槽和细滚动条样式已生效；大量邮件继续沿原有增量加载逻辑向下加载。
- 阅读区：标题、来源和底部操作栏固定在阅读栏内，只有正文区域滚动。
- 浏览器状态：Vite error overlay 不存在，开发日志 `error` 级别为 0。
- 构建验证：`npm run build` 与 `git diff --check` 均通过。

final result: passed
