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
- “AI 整理”展示来自本地邮件副本的行动项建议；邮件正文、账户凭据不会发送到云端。
- 回归结果：AI 整理展开、账户设置打开/关闭、收取提示、邮件阅读、星标/归档、收件箱文件夹切换均通过；页面 error 为 0。

final result: passed
