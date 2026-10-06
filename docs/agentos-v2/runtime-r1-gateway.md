# R1 第五批：独立 Worker 通道与一次性本机模型出口

默认关闭；只对明确合成/本机测试空间启用，不迁移旧配置，不自动连接 Pi/Harness，不提供云端模型或一般 HTTP 代理。第四批 Profile catalogue 仍只检查引用，不表示模型连通。

## 接口

owner 控制通道新增固定方法：

| RPC | 参数 | 结果 |
|---|---|---|
| `v2/delegated.model.issue` | session_token, csrf_token, workspace_id, provider_id, profile_revision, prompt, max_tokens, ttl_seconds | run_id, lease_token, expires_in, purpose:model-text-once |
| `v2/delegated.model.revoke` | session_token, csrf_token, workspace_id, run_id | revoked:true |
| `v2/model.invoke` | lease_token, workspace_id, run_id, call_id | completed + result:{text,usage} |

所有对象拒绝未知字段。prompt 是用户显式选择的本次输入（最多 16 KiB），不是自动全盘检索/记忆 Context；1–1024 输出 tokens，TTL 1–120 秒，一张授权仅一次尝试。服务存原文于有界内存、bearer 仅存摘要；不写正文/Key/token/摘要到审计。调用不能修改授权中的 prompt、Provider、预算或 endpoint。撤销只能由签发会话执行；父会话过期/注销或 daemon 重启失效。

已尝试请求立即清空授权里的 prompt（即使模型/凭据失败）；每 5 秒定时清理过期委托，忙于已有有界请求时下一次清理。有效性每次严格按期限判断，不因为清理稍迟而继续放行。定时过期不是持久状态事件，统一生命周期审计仍待后续。

`local_model_profiles:[id]` 只在可信私有启动配置中选择已登记 Profile；HTTP、数值 loopback IP、显式非零端口、路径 `/v1`，无 userinfo/query/fragment。拒绝 localhost/DNS、远端、任意路径、redirect 和环境 proxy。只 POST `/v1/chat/completions`，固定单条 user message、stream:false，无 tools。请求/响应/时间均有界；无自动重试。连接不确定/HTTP 错误后授权仍消费，不能用新 call_id 重试；需要用户新的显式授权。返回来源标记为本机 Provider，合成 Provider 成功不等于真实模型或执行器成功。

密钥仅在 core 内部临时回调中使用，不能从公开 Secret Store/CLI/Worker RPC 取值；验证用途/ref/revision/撤销状态。持有 Store 锁直至有界请求和结果校验完成，lock/rotate/revoke 等待排空；已交给 Provider 的字节不能撤回。返回前用户/授权期限复验，已失效则不释放结果。正文反射当前 API Key 被拒绝；不承诺通用敏感内容检测或防恶意本机 Provider。

## Linux Worker 通道

`worker_transport={socket,uid,gid}`：uid/gid 必须非零，uid 与 daemon owner 不同，目录由操作员预先配置为 owner uid、指定 worker gid、0710；socket 为 0660，连接 peer uid 必须精确匹配。独立 listener 仅处理两个固定 invoke 方法，不提供登录、签发、凭据管理、owner 文件查询或任意 RPC。控制通道继续私有 0700/0600，仅 owner 可连接。

客户端 `depdek-worker --socket PATH [--server-uid UID] [--model]` 只选择文件或模型固定调用，验证 daemon OS uid；秘密走有界 stdin NDJSON，不接受秘密 argv。客户端不是隔离启动器；实际隔离必须由 Linux namespace/container/systemd 设置，不能因为存在二进制就宣称沙箱。

独立 uid、文件挂载最小化、禁出站网络、只读 rootfs、cap-drop/no-new-privileges 的容器测试与生产 systemd 真机验收是不同门。NAS 未部署；云端 Gateway/TLS、持久任务授权/回执、BFF 分 uid、真正 Engine Adapter 接线仍待实现。
