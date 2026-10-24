---
name: Jiaho AI-OS 2026 quiet glass
scope: docs/design/ai-os-2026-v1 only
colors:
  background: '#f3f6f2'
  surface: 'rgba(255,255,255,.68)'
  ink: '#263c34'
  muted: '#7d8e85'
  line: 'rgba(47,75,58,.10)'
  accent: '#376955'
  selected: '#dfebe3'
  ambientMint: '#ccded2'
  ambientSand: '#e9e3d6'
typography:
  heading: 'PingFang SC, Noto Sans CJK SC, sans-serif'
  body: 'Helvetica Neue, PingFang SC, Noto Sans CJK SC, sans-serif'
rounded:
  dock: 28px
  composer: 28px
  control: 50%
  artifact: 18px
spacing:
  base: 4px
  scale: [4, 8, 12, 16, 24, 32, 48, 64]
components:
  navigation: floating icon dock
  conversation: single intent canvas
  context: on-demand drawer
---

# Overview

2026-10-24。用户否定上一版拟物外观，要求参考 2026 年最新 UI 并尽量减少文字。本轮直接制作新 HTML；旧稿保留。Redesign · Overhaul 仅限独立设计稿，正式 AI-OS 代码、业务、权限、接口和持久主题未改。

Design Read：家庭成员通过悟空处理资料的近距离桌面/手机界面；轻透材质、安静留白、意图优先。视觉变化 5、动效 3、密度 2、素材依赖 3、品牌一致性 8。低密度意味着移除空操作栏、重复描述和常驻设置；图标仍具备 accessible name、悬浮/键盘标签和触摸尺寸。保留真实 Logo、悟空角色与四个目的地，继续提供工作台/设置/锁定入口。动作 160–260ms，服从减少动态效果。

叙事角色：打开即交代一件事，不是功能宣传页；距离：桌面 50–80cm 与单手手机；温度：温暖、轻盈、克制；容量：一条问候、一个输入框、三个短入口。右栏仅在用户打开或查看产物时出现。输入解释、模型细节、设计参考移入可打开的说明，不削弱示例身份。

# Colors

使用上述暖白、墨绿、浅苔绿与少量沙色。背景是低饱和环境光；透明材质集中在导航、控件和输入容器，不在正文后叠加繁复内容。正文近不透明，玻璃后备色支持没有 backdrop-filter 的浏览器。深色使用画布 `#17231f`、文字 `#e7efe8`、次要文字 `#9aada0`、表面 `rgba(38,53,45,.84)`。

# Typography

沿用家合系统中文字体，不增加在线字体。欢迎语 32–38px、输入 16–17px、对话 16px；少量辅助文字 11–12px。只保留品牌、当前选中目的地短名、问候、短入口和必要的示例标记。不增加英文口号、角色职责段落、永久快捷键说明或无意义状态灯。

# Layout

顶部品牌和四个轻量控制；左侧 76px 浮动图标 Dock；主体弹性，输入最大 680px。默认不留右侧空面板。对话开始后欢迎语让位，输入收到底部，产物保持可打开。手机 Dock 收到底部，保留输入安全边距与 44px 控件；右栏成为覆盖抽屉，有关闭/Escape 退路。

# Elevation & Depth

采用 translucent surface + 1px 高光边缘 + 很轻的接触阴影。没有皮革、缝线、纸张、塑料凸起或复古图标。浏览器 CSS 仅借鉴视觉原则，不声称复现 Apple 的实时光学折射或原生 Liquid Glass API。

# Shapes

Dock 与输入 28px；产物 18px；图标按钮圆形；快捷入口使用胶囊。圆形是操作，胶囊是短建议，矩形是可阅读内容。现有 Phosphor 描边/选中填充图标，同一角色使用原始 SVG。

# Components

- 欢迎：一个悟空头像、一句问候；删除解释性段落。
- 输入：输入、示例附件、示例语音、发送；不常驻引擎清单、连接详情与快捷键。
- 建议：三个 2–4 字短入口；点击填草稿，不自动调用模型。
- 导航：悟空、相册、视频、资料；默认图标，选中显示短名；全部有 title/aria-label 与 focus 标签。
- 清单：按需打开，内置示例可勾选，不伪造家庭资料/扫描结果。
- 外观：隐藏面板内提供浅/深色和轻透/纯净/专注三个变体，大字可选。所有状态仅内存。
- 说明：顶部「预览」提供明确、可达的示例说明与官方设计参考。

# Do's and Don'ts

减少文字靠减少功能同时可见的数量，不靠缩字号或删除焦点/名称。不把行业趋势说成统一标准；不把 2025 首次推出的设计称为 2026 新发明。参考核实记录见 research.md。本页无网络/模型/文件/麦克风/账户能力，不输入凭据。APP_VERSION 从根 VERSION 导出，正式 Shell 不改。
