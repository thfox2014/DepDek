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
