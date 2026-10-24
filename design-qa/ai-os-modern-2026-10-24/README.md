# AI-OS 主 UI · 轻透接入

2026-10-24。根据用户已确认的 `docs/design/ai-os-2026-v1/`，将风格接入实际 `DepDekAiOsShell`，不再只提供独立 HTML。

- 浮动图标 Dock、单句欢迎语、居中输入与三个短入口，右侧操作面板默认收起。
- 浅/深色与轻透/纯净/专注外观保留本机偏好。设置/工作台/锁定可达；模型状态、执行器与用量移入输入旁弹层。
- 模型检测和切换、发送守卫、语音草稿、审批、相册/资料/视频服务继续使用原函数与 Props。公域模型开关和发送范围提示仍显示。待确认审批可展开面板，且有数量入口。
- 弹层打开时暂停悟空小剧场；原有六种动作、减少动态效果和定时器清理保留。完整模型配置弹窗使用单独的模态焦点范围，关闭后返回有效入口。

检查结果：

- `npm run build` 通过，版本一致性、TypeScript 与 Vite 构建均通过。Vite 仍提示既有的大 chunk；本次未做打包拆分。
- AI-OS room/setup、treasure、document scenes、native documents、video library、Wukong moments 共 58 项相关测试通过。
- 1280×720 浏览器实际查看主组件默认首屏、深色、模型弹层、完整配置弹窗及资料入口。预览使用已存在的隔离 fixture，顶部工具条和模拟 Provider 不进入生产 UI。
- 窄屏底部 Dock、覆盖面板、44px 主操作、缺少 backdrop-filter 时的后备色和减少动态/透明规则已做源码检查。本轮没有原生 Tauri、真实模型、文件导入或设备实机验收。
- 样式只增加到 `ai-room--modern`；未修改已有 `ai-os-room.css`、fixture、Rust、Vault、sidecar、Webdesk 或三方契约。已有工作目录改动保留。

截图：`main-light.png`、`main-dark.png`。这些是实际 React 主组件的隔离预览，不是原生服务能力证明。

本机查看：`DEPDEK_ROOM_PREVIEW_PORT=1440 npm run preview:ai-os-room`。
