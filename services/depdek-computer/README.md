# DepDek 浏览器电脑

固定 Chromium 服务，供悟空经共享 core 调用。仅 open/status/screenshot/request_input/respond/click/stop，不提供 shell、任意 JavaScript 或宿主文件工具。

```sh
docker build -t depdek-computer:0.2.1 services/depdek-computer
docker image inspect depdek-computer:0.2.1 --format '{{.Id}}'
node scripts/run-core-room.mjs --computer --port=8788
node scripts/run-core-room.mjs --test --computer --port=8790
```

以上为合成模型环境：管理员 admin、私人空间 admin/alice/bob；密码 `RoomDemo2026!`，凭据库解锁密码 `RoomDemoStore2026!`。生产配置不提供默认密码，不自动使用历史聊天 Key。

`room_runtime.computer` 配置绝对 node/script/docker 路径、已构建 image 的 sha256 ID、Docker Unix socket 与 allowed_hosts。Linux 设置实际 CLI/socket 路径，单独授予受信 broker 权限；禁止向 Webdesk、Agent 或容器提供 Docker socket。

网页点击在右侧确认；密码/验证码经右侧填写，不进入模型或日志。page_revision 防过期元素，结果未知不重试。关闭电脑清除浏览器会话；空闲 30 分钟关闭容器。退出私人空间清除界面数据，容器受空闲时限约束。

出口使用 DNS 检查与固定 IP 的 HTTPS 代理及 exact hosts。禁下载、WebSocket、service worker 和新窗口。当前 Chromium 关闭内部 sandbox，依赖 Docker 隔离，尚需生产恶意网页隔离评估。页面图片和文字仅当前业务主体可读。

完整接口见 [runtime-computer.md](../../docs/agentos-v2/runtime-computer.md)。
