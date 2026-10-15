# R1 第六批：Pi/Harness 的受控 SDK Worker

独立新入口，不自动切换已有 Agent Room/桌面 SessionManager，不扫描旧配置、不读取真实凭据，不提供云端或一般 Agent 工具。范围是同一 exact-input 本机授权上的单次文本循环。

## 核心绑定

ModelIssue 新增可选 `engine:pi|deepseek-harness`；不传保持第五批 bearer 兼容。响应提供 run_id/lease_token/engine/provider_id/model/max_tokens，秘密仍仅签发一次。绑定后 ModelCall 必須提供 context：

```json
{"engine":"pi","provider_id":"local-test","model":"selected-model","max_tokens":128,"system":"","messages":[{"role":"user","content":"已授权文本"}]}
```

Core 在持久审计意图、消费单次额度后检验全部字段。engine-bound lease 不接受 context 缺失；context 的模型/预算/角色/文本不能扩大或替换。Core 不接收 caller 身份、Key、endpoint、工具或任意多消息历史。错误不释放结果、不外发，不可用第二次尝试探测或绕过。

## Worker

先 `npm --prefix sidecar ci --ignore-scripts && npm --prefix sidecar run build`，使用 Node 24+ 运行 `node sidecar/dist/r1-engine-worker.mjs --socket PATH --worker-command PATH --server-uid UID`。路径是操作员提供的受信可执行文件/受限 socket，不从输入指定；需要 OS 文件/网络隔离，Node 进程不是沙箱。stdin 仅一行、结束换行并关闭输入的有界 JSON：workspace_id/lease_token/run_id/call_id/engine/provider_id/model/max_tokens/prompt。输入 32 KiB/10 秒，执行 15 秒；禁止 Key、systemPrompt、history、tools、endpoint 和任意选项。

实际 Pi Agent streamFn 与 Harness AgentLoop LlmAdapter 只转换 SDK 的最终单 user 文本请求，使用固定 model.invoke 子进程客户端。无直接 fetch/Provider Key、不继承秘密环境给客户端；新 SDK composition 不安装 shell/fs/web/子 Agent/默认模型 Provider 或持久 session 插件。两种引擎同样无工具，不能因此宣称已实现所有 Agent 技能。

stdout 为顺序 NDJSON：safe progress + 最终 result/error；runtime 版本来自已安装包并核对支持版本，使用 SDK 事件而非模型自述作为来源。结果保留 core Provider/实际 usage，缺失 usage/cost 仍未知；SDK 的占位 usage 不作为统计事实。不打印 prompt/bearer/密码/原始异常/隐藏思维，不将结果伪装为已持久化 Job/Receipt。文本已由 core 校准，展示分段不是 Provider 原生流式。

Core `result.engine` 保持 null：请求的 engine 绑定是授权条件，不是任意客户端可自封的执行证明。受信 Worker 的 runtime facts/实际 SDK 事件与容器测试共同证明本批 SDK 链路，不是硬件远程证明。CLI 启动会剥离凭据环境，Rust 子进程只接收最小环境；操作员仍必须在启动 Node 前使用最小环境，不能依靠启动后的清理撤销已经执行的 NODE_OPTIONS preload。Node/HTTP/OS 的所有内存副本无法保证被擦除。

验收应同时证明：实际 Pi/Harness loop 经同一 core 到合成 Provider；输入/模型/usage 相同，跨引擎伪造或缺 context 被 core 拒绝；Worker 无原件/凭据/网络/管理通道。合成 Provider 不是真实大模型；最小 SDK Harness 不等于旧 dsh headless CLI 全 profile。生产云端/TLS、来源版本 Context、旧客户端/凭据迁移及持久执行统计仍待实现。
