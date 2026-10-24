# AI-OS 经典拟物 · HTML v0

2026-10-24。新增第三种外观的独立设计稿，沿用现有 AI-OS 三栏结构与品牌素材。包含浅色、深色、经典拟物三种对照；浅/深色是原型对照，非原生 Shell 嵌入。

直接双击 **AI-OS-经典拟物.html** 即可离线查看，图标、CSS、脚本与图片全部内嵌，无 CDN 依赖。默认打开经典拟物。

源文件：`index.html`、`prototype.css`、`prototype.js`；`prepare.mjs` 从仓库已安装的 Phosphor 提取图标并导出单文件 HTML，版本号读取根目录 `VERSION`。

```sh
node docs/design/ai-os-classic-v0/prepare.mjs
python3 -m http.server 1438 --bind 127.0.0.1 --directory docs/design/ai-os-classic-v0
```

本机预览：[打开设计稿](http://127.0.0.1:1438/)。可切换导航、主题、示例对话、填写/发送草稿、查看示例清单、开关操作面板和 Tweaks（材质细节/字号）。语音按钮只填入示例草稿。

所有交互仅在当前页面内存，不使用 localStorage，不调用模型、不读写家庭资料、不启用麦克风。未改正式主题选择器、组件、业务协议或版本。

视觉规格与素材出处见 `brand-spec.md`。
