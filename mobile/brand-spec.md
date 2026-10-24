# 家合 Mobile · 品牌与设计来源

2026-10-22，Extension；依照 `docs/DESIGN.md` 与用户选定的悟空家庭管家，不重新发明视觉系统。

- Logo：`src/assets/jiaho-logo.png`，原样复制 `src/assets/jiaho-boot-logo.png`。
- 悟空：`src/components/WukongHead.tsx`，复制既有同名 React 组件；保留头部比例、金箍、肤色与眼睛，CSS 增加可关闭的眨眼/轻呼吸，不另画角色。
- 图标：已有 `@phosphor-icons/react` 2.1.10，MIT，随 npm 依赖与许可分发。
- 确定的界面参考：`docs/design/jiaho-wukong-butler-v1/preview.png`、该原型 HTML/CSS/JS 及手机抽屉截图；不是再一次从 Meta 网站做像素克隆。
- 主色：暖白 `#fbf8f0`、纸白 `#fffdf8`、墨绿 `#23463c`、浅绿 `#eaf0e8`、线 `#e2e4d9`、暖棕 `#a66d36`；次文字 `#637669` 是原灰绿的可读性加深。
- 深色延续 `#18251f / #20322a / #edf2e9 / #becabd / #3d5144 / #304c3e`。
- 系统中文字体，不拉外部字体；纸面与细线分隔，不堆玻璃卡片、无新角色与神秘渐变。
- 手机首屏只交接一件事；底部五个目的地保留，右侧操作收成原生对话框抽屉。安全区、键盘、大字与减少动效不改变业务授权。
