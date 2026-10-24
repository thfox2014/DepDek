# 悟空家庭管家 v1 · 品牌与参考

日期：2026-10-22。模式：Redesign · Preserve，延续 `../jiaho-home-hub-v0/`，不修改生产应用。

- 家合 Logo：`assets/jiaho-brand/logo.png`，复制上一版的真实仓库素材，源为 `src/assets/jiaho-boot-logo.png`。
- 悟空：`assets/jiaho-brand/wukong.svg`，继续复用 `WukongHead.tsx` 的原有头像，不生成替代角色；仅对整张头像施加可关闭的轻动效。
- 图标：`assets/icons.svg`，由已安装的 `@phosphor-icons/react` 2.1.10 导出，MIT；不是手绘图标。
- 浅色：暖白 `#fbf8f0`、纸白 `#fffdf8`、墨绿 `#23463c`、灰绿 `#77867a`、细线 `#e2e4d9`、浅绿 `#eaf0e8`、暖棕 `#a66d36`。
- 深色：`#18251f / #20322a / #edf2e9 / #becabd / #3d5144 / #304c3e`；头像中的金棕与暖肤色属于既有角色素材。
- 字体：现有系统中文字体；不加载外部字体、照片、脚本或 CDN。
- 主参考：Meta Muse 官方 [How We Designed Muse](https://introducing.muse.ai/)，借鉴连续主对话、后台工作、确定性决定、结构化产物；不声称视觉复刻。网页文字可读取，内置浏览器参考页加载超时，没有截取到可用于逐像素比较的官方界面。
- 其他参考：Meta [Muse 安全设计](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)，用于理解工具与凭据边界，不把其云端 VM 当成本项目交付架构。
- 家合权威：`docs/DESIGN.md`、`docs/jiaho-product-soul.md`、现有三栏与 Vault 边界优先于外部参考。
- 所有文件名、日期、记忆、设备回读、任务与回复均为虚构夹具，不从用户的 Home、相册、环境变量或账户读取。
