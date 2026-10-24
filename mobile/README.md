# 家合 Jiaho · Mobile

独立的 React + TypeScript + Vite 手机前端。由 [悟空管家原型](../docs/design/jiaho-wukong-butler-v1/index.html) 实现，不是把原型作为 iframe 装进应用，也不依赖 Tauri、桌面进程或 Node sidecar 的浏览器直连。

## 运行

Node 24+（测试使用 Node 的 TypeScript 类型擦除），npm：

```sh
npm --prefix mobile ci
npm run dev:mobile
npm run test:mobile
npm run build:mobile
```

- 默认真实连接：`http://127.0.0.1:1444/`
- 显式体验模式：`http://127.0.0.1:1444/?demo=1`
- 产物：`mobile/dist/`。`npm --prefix mobile run preview` 只预览静态构建，**不代理 API**，请用 `?demo=1` 查看体验。开发和预览默认使用同一端口，不能同时启动。

体验模式只在页面内存中使用虚构资料、任务、记忆和灯光，不发请求、不用摄像头/麦克风，不读取磁盘。真实模式失败不自动回退样本。切换模式会重新加载页面并清空当前前端状态。

## 已实现与边界

| 部分 | 当前实现 |
|---|---|
| 手机布局 | 悟空主对话、底部五入口、操作抽屉、深浅色、大字/日常/紧凑阅读、键盘高度适配、减少动态效果 |
| 真实业务登录 | 现有业务用户名/密码、HttpOnly Cookie、内存 CSRF；失效弹窗，不重放写请求；更换主体/空间清空旧内容 |
| 真实对话 | Pi / DeepSeek Harness 的固定 Room 接口；只发送本次文本；请求可排队，输入不锁死；未知结果不重试 |
| 模型选择 | 主机已登记的公开 Provider ID / revision / engine；可读取管理员元数据（需已有 admin 会话），不提供 API Key 表单 |
| 资料 | 现有受限目录 list / text read、分类/名称/路径/SHA 搜索、实际原文校验值、截断/空/错误状态 |
| 家庭档案 | 当前账户的物品、已有包清单、stale 标记；不是完整照片/视频业务 API |
| 体验闭环 | 并行整理与维修任务、冲突核对、示例清单下载、记忆忘记、灯光回读/未知/核实 |
| 语音 | 显式体验草稿；真实模式可选浏览器 SpeechRecognition，先说明可能外发音频，识别只填草稿；不支持时退回键盘 |
| 尚未开放 | 真实移动端长期记忆、NAS 大文件上传/续传、照片/视频原片流、真实家电控制、服务端持久管家任务、手机远程 TLS 链路 |

“模型回复”不等于“文件已整理/设备已执行”。当前 Room 在此入口不开电脑工具，不自动读取目录、附带历史或发送家庭材料。不能把前端排队当成可跨重启恢复的服务端 Job。

## 连接现有服务

仅消费 [Room 运行接口](../docs/agentos-v2/runtime-room.md) 与 [只读业务代理](../docs/agentos-v2/runtime-r1-access.md)，没有新增后端路由或放宽契约。桌面端接口不变，Webdesk 仍不读 Home。

固定 HTTP：

- `GET /api/v2/auth/session`，`POST /api/v2/auth/login|logout`
- `POST /api/v2/room/chat`（`agent_id=wukong`、`computer=false`）
- `POST /api/v2/commands/invoke`，仅 `file.list/read@1.0`
- `POST /api/v2/household`（界面只消费 `list` 的物品与已有资料包）
- 可选 `GET /api/v2/room/config` 为管理员元数据，不是家庭业务授权

所有 POST 使用服务端签发的业务 CSRF；不带 caller actor/role、不注入管理员 cookie、无 API Key getter、不直连第三方模型。401/会话过期只打开登录入口，登录后让用户重新决定下一步；不会自动再发云端请求。

`.env.example` 只有公开配置。若需开发配置，复制到未跟踪的 `mobile/.env.local` 后填非秘密元数据；**不要在 VITE_*、源码或浏览器存储中放密钥、密码和令牌**。

```dotenv
MOBILE_API_PROXY=http://127.0.0.1:8787
VITE_MOBILE_PROVIDER_ID=<主机已登记的 ID>
VITE_MOBILE_PROFILE_REVISION=<当前版本>
VITE_MOBILE_PROVIDER_CLOUD=1
VITE_MOBILE_ENGINE=deepseek-harness
VITE_MOBILE_READ_PATH=<主机已授权的相对目录>
```

当前 Webdesk 业务代理严格限制数值 loopback Origin。开发时必须由操作员把服务端 `business_origin` 显式配置为 `http://127.0.0.1:1444`，并使用正常认证，不能使用 `--insecure-no-auth`。**更改单一 Origin 会影响原来来源的业务入口，需自行选择维护窗口；本次没有修改运行配置。** Vite 保留原始 Origin，不重写成一个“看似获准”的值，配置不符就明确报错。

只把前端改为 `0.0.0.0` 并不能让真实手机访问这条业务链。生产远程接入仍需后端完成可信 TLS、受限 BFF/独立账号和来源策略，不能在前端靠 CORS/伪造 Origin/借管理员文件权限绕过。静态体验可单独分享；不因此开放真实家庭数据。

## 隐私与语音

无 Service Worker、localStorage、IndexedDB 或家庭内容离线缓存。浏览器仅当前页持有对话与读取结果；业务 Cookie 为后端的 HttpOnly，CSRF 仅在客户端实例内存。不记录请求体、密码、模型错误原文或 React 私人 props。

浏览器语音并非家合本地 Vosk，部分实现会使用服务端识别，且支持情况不同；见 [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)。首次启用有明确说明，选择仅作用于本页；后续仍需每次主动点击。取消、离开页面或切页会停止识别，陈旧回调不覆盖草稿，中文输入法回车不直接发送。**尚未做 iOS/Android 真机语音验收。**

页面录音/识别不是执行授权，不因识别到用户声音就解锁私人空间。家庭镜头状态接口未开放时显示未知/未接通，不伪装成已经硬件断电。

## 结构

交互方向与界面取舍见 [悟空管家设计说明](../docs/jiaho-wukong-butler-design.md)；可运行的独立原型位于 [`docs/design/jiaho-wukong-butler-v1/`](../docs/design/jiaho-wukong-butler-v1/index.html)。

```text
mobile/
  src/App.tsx                  会话、请求队列与界面编排
  src/components/PackagePanel  带过期保护的资料包查看
  src/components/MainScreens   五个主要目的地
  src/components/Panels       任务/原文/模型/隐私抽屉
  src/components/WukongHead   既有悟空形象的组件副本
  src/lib/api.ts              固定 HTTP 客户端，内存认证
  src/lib/config.ts           非秘密的模型配置元数据
  src/lib/store.ts            UI 投影与隔离的演示状态机
  src/hooks/                  语音、键盘可视区域
  src/styles/                 家合主题与手机布局
  tests/                      无网络的客户端/状态/边界测试
```

`VERSION` 仍为唯一版本源；Vite 从仓库根读值，`scripts/version.mjs` 同步校验 mobile manifest 与 lockfile。没有独立升级号，不改变桌面入口，不构建或重启 OS。

已完成自动化单元测试、TypeScript 与 Vite 构建，并打开当前界面检查交付视图；不等同于真实云端模型、已登录后台、家庭资料、跨设备浏览器或远程 NAS 部署验收。
