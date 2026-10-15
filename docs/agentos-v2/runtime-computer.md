# 悟空的浏览器电脑

Room 可选配置 `room_runtime.computer:{node,script,docker,image,docker_host,allowed_hosts}`。固定代码路径和镜像 ID 由操作员配置，不接受请求的 shell/argv/image。Webdesk 仅固定 BFF，不接触 Docker socket、Home 或 API Key。

每个 workspace + 已认证业务主体拥有独立短期 Chromium 容器。非 root、只读根、有限 tmpfs/CPU/内存/pids，无宿主挂载、端口、Docker socket 或模型凭据。30 分钟空闲退出并移除。浏览器出口代理只允许 exact hosts 的 HTTPS/443，检查所有 DNS 地址且连接固定 IP，禁私网、WebSocket、下载与 service worker。当前 Chromium 使用 no-sandbox，依赖 Docker 隔离，仍需生产浏览器隔离评估。

业务接口 `v2/delegated.computer`：`{workspace_id,session_token,csrf_token,action}`。actor 只能从 Vault 业务 session 取得。

- `{kind:status|screenshot|request_input|stop}`。
- `{kind:open,url:"https://允许的域名/…"}`；`depdek:demo-login` 是内置合成登录页。
- `{kind:click,target:"e1",page_revision:1}`，只接受当前可见元素，不接受 selector/JavaScript。
- `{kind:respond,page_revision:1,values:{e1:"输入内容"}}`，仅用户面板，不能从模型请求。

返回 `{running,revision,url,title,text,elements,request,screenshot,mime,container}`。JPEG base64 截图仅给当前业务用户；页面摘录 ≤ 4096 字，元素 ≤ 40。request 自动列出可见输入框。用户输入仅经 core→电脑 stdin，不传给模型、不审计、不持久化。摘录遮盖已填内容，URL 查询参数不发送给模型。

Room chat 新增可选 `agent_id`（缺省悟空）与 `computer`（缺省 false）。开启电脑模式后 core 添加固定动作协议及脱敏页面摘录，通过原单次 Gateway/实际 SDK 取得 `{message,action}`，每次最多执行一个动作。响应追加 computer、proposed_action 与 continuation；前端每个目标最多推进 6 步，可停止，等待输入时停止。网页点击先在右侧待确认，再由用户执行；模型不能填写或提交。失败不自动重试。

HTTP 固定 BFF `POST /api/v2/computer` 校验业务 cookie/origin/CSRF。CLI `depdek … computer --workspace ID --stdin` 同接口。Vault 审计只存 actor、动作类别、成功状态，无 URL/文本/截图/输入值。

UI 为扁平深/浅主题；主题与各 Agent 的 engine/provider 可保存到本地，密码/Key 不保存。管理员固定 admin，配置权限与私人业务空间分开。

镜像依据 [Playwright 官方 Docker 指引](https://playwright.dev/docs/docker)，固定 Playwright 1.58.2，构建后使用镜像 ID。验收含实际容器登录/截图、跨用户隔离、网络拒绝、过期元素拒绝、CSRF 与输出无凭据。
