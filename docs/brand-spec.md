# Jiaho 文件模块品牌上下文

- 真实品牌资产：`src/assets/jiaho-boot-logo.png`（已有家合 logo，直接引用，不重画）。
- 界面参考：`src/components/ai-os-wizard.css`；原生截图 `os/artifacts/ai-os-wizard-native-login.jpg`。
- 用户确认方向：家合向导的暖白、墨绿，保留文件模块的本地可信定位。
- 色值、排版和交互规格：`docs/DESIGN.md`，文件模块作用域，不能覆盖未涉及页面。
- 文件表原始数据：只来自已授权 Home 的 Vault KV 查询，预览稿仅显示显式占位符，不从真实目录取素材。

## 首个闭环 v0（2026-10-18）

- 产品依据：`docs/jiaho-product-soul.md`；落地范围：`docs/jiaho-first-mile-design.md`。
- 角色资产：复用 `src/components/WukongHead.tsx` 的现有头像，不新画角色或 Logo。
- 本轮重新捕获的源码界面：`docs/design/jiaho-first-mile/01-current-room.png`；该截图为隔离 fixture，不是生产模型验收。
- `scripts/fixtures/JiahoFirstMilePreview.tsx` 延续同一暖白、墨绿系统，示例数据清楚标记，不采集家庭资料。

## 相册 / 资料本机闭环（2026-10-19）

- 原生入口延续已有 Logo、悟空头像及 `docs/DESIGN.md` 的暖白墨绿系统；本批不新画素材。
- 资料原文与 PDF 内容只来自已授权且复验 SHA 的引用；独立浏览器流程使用 `scripts/fixtures/nativeDocuments.ts` 的虚构文本和有效单页 PDF，不拿家庭文件作截图或素材。
- PDF Reader 字体/CMaps 为 `pdfjs-dist` 随包资产，随构建输出到 `pdf-assets/`，包含 Apache/Foxit/Liberation/CMap 许可证，不热链外部资源。

## 悟空小剧场（2026-10-21）

- 复用现有 `src/components/WukongHead.tsx` 的脸型、紧箍、耳朵与表情；默认头像不变，仅给小剧场增加表情参数。
- 动作组件：`src/components/WukongMoment.tsx`，轻量矢量关节与 CSS 动画，不请求外部图片、视频、音频、字体或模型。
- 头部金棕/红棕配色沿用既有头像；台词与小剧场标签使用当前聊天主题的文字色、次要色，深浅色共用同一角色。
- `scripts/fixtures/AiOsRoomPreview.tsx` 的六动作图鉴仅用于隔离预览，不会进入原生业务导航，不读取真实家庭数据。

## AI-OS 轻透主 UI（2026-10-24）

- 用户确认将 `docs/design/ai-os-2026-v1/` 的轻透极简风格应用到 `src/components/DepDekAiOsShell.tsx`；正式布局不再使用拟物素材。
- 继续使用 `src/assets/jiaho-boot-logo.png` 和原始 `WukongHead`，Phosphor 图标复用现有安装包，不增加图片、图标字体或远程资源。
- 样式仅在 `ai-room--modern` 内生效；轻透层用于导航、输入和面板，文档原文与真实媒体沿用既有服务与授权引用。深浅色和三种材质详见 `docs/DESIGN.md` 主 UI 接入增量。
- 源码组件的隔离预览截图位于 `design-qa/ai-os-modern-2026-10-24/`，顶部 fixture 工具条与模拟模型只供查看，不会进入生产主 UI。
