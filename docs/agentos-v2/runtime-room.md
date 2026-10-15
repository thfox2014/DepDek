# Agent Room 与家庭凭证运行接口

浏览器电脑及可选 `agent_id/computer` 扩展见 [runtime-computer.md](runtime-computer.md)。SDK 保留单次模型循环，浏览器动作由 core 严格解析执行。

R1 Room Adapter：主界面默认共享 core，不在失败时回退旧 agent-service。配置 `room_runtime` 后接通执行；未配置显示连接指引。旧 UI/API 仅显式 `legacy_agent_room=true` 兼容，禁止与 business_socket 同开，避免两套 Provider 写入口。管理员只管配置，家庭内容及模型请求需要独立业务登录。

## 控制面（owner Unix；Webdesk admin + CSRF）

- `v2/room.config`：workspace、运行入口、允许云端 hosts、Secret Store 状态、Provider 元数据，不返回 Key。
- `v2/room.store`：`{workspace_id,action:init|unlock|lock,input}`，复用 Secret Store passphrase/operation_id，无默认主密码。
- `v2/room.provider.save`：`{workspace_id,input:{operation_id,id,name,base_url,model,expected_revision,api_key}}`。OpenAI Chat Completions；Key 与 Profile 在同一加密快照原子提交。空 Key 仅更新已有 Profile，revision 乐观锁。
- `v2/room.provider.test`：`{workspace_id,input:{provider_id,profile_revision,cloud_consent}}`。owner/admin 配置面只发送固定连接测试短句（最多 128 输出 token），不接受任意 prompt、不读取家庭资料、不创建业务用户或业务会话。复用 Vault 出口/Key 有界回调和审计，无重试。返回实际 reply/model/usage 与 `connection_verified:true`；此结果证明 Provider 可调用，不冒充 Pi/Harness 运行证明。

HTTP `POST /api/v2/room/providers/test` 与保存一样要求 admin cookie、CSRF、origin、loopback。凭据库仍需主密码解锁；UI 锁定时在保存按钮附近提示输入主密码，并支持一键解锁→保存→测试。解锁和失败不清空尚未保存的 Key；保存成功立即清空 Key。保存成功但连接失败单独报告，配置已持久化，不重复保存/重试。

Provider HTTP 错误只映射固定码：401/403 `PROVIDER_AUTH_FAILED`，400/404/422 `PROVIDER_REQUEST_REJECTED`，402/429 `PROVIDER_QUOTA_LIMITED`，其余 `PROVIDER_UNAVAILABLE`。不回显 Provider 原始错误 body、header 或 Key。
- `v2/room.migration.preview/apply`：显式上传旧 settings/mail/calendar JSON，沿用凭据导入。`v2/room.migration.activate`：显式提供已导入 Provider 的元数据，将匹配 binding/ref 注册成运行 Profile。原文件不改、不删；旧 Connector 的主写者切换需要独立维护窗，不把暂存称为全机迁移。

## 业务面（session + CSRF，无 caller actor/endpoint/key）

- `v2/delegated.room.chat`：`{session_token,csrf_token,workspace_id,provider_id,profile_revision,engine,prompt,max_tokens,cloud_consent}`。16 KiB 输入/1024 输出 token；实际 Pi/Harness SDK 空工具循环，只发送这一精确文本。云端每次同意，单次授权消耗，失败不重试。结果含 SDK package/version、core Provider/model/usage（缺失 null）；不是远程进程证明。

模型结果 `model` 是授权请求的模型，新增 `reported_model` 是 Provider 返回的标识或 null，不把请求参数当实测模型。Worker 兼容旧七字段与新增八字段结果；其余未知字段拒绝。`v2/auth.session` 恢复当前业务 CSRF（内存 SecretText），不回显 session bearer；元数据查询不续期凭据库的空闲解锁。
- `v2/delegated.household`：`{session_token,csrf_token,workspace_id,command,input}`，命令 `list/import/assert/confirm/prepare/get/complete`。私有对象 owner 来自 session，管理员不继承内容权。

家庭 store 是 Vault 内部 `.household/state.json` 小规模版本化原子快照，0700/0600、fd-relative/no-follow、flock 单主写、fsync/rename。不是设计 SQL 的数据库实现。最多 8 MiB、64 原件、单个 24 KiB；UTF-8/PDF/PNG/JPEG 的 base64 原件。没有自动 PDF/OCR，手工摘录仍引用原件 hash/evidence。重复按 owner+hash 去重；operation_id 同参原回执/变参冲突；修正使旧包 stale；日期冲突保留断言，显式 confirm；维修包列未知项、不发邮件，并创建本领域待办，不双写旧 todo/queue。get 导出原件或包，CLI/UI 同接口。

## 出口与 HTTP

操作员 exact host 白名单 + HTTPS/443 + `/v1` 或根；默认不开云端。每次 DNS 全地址检查，拒绝非公网并 pin 本次 Client，保留 TLS 主机名校验；禁代理/重定向/自动重试。loopback HTTP 仅显式本机 Profile。

DeepSeek 表单默认 `deepseek-flash`，本切片对 `api.deepseek.com` 固定非思考模式（`thinking.type=disabled`），避免短回复预算被默认推理耗尽，不转发原始 reasoning。接口依据：[当前模型](https://api-docs.deepseek.com/api/create-chat-completion/)、[模式参数](https://api-docs.deepseek.com/guides/thinking_mode/)；实际连接仍须使用用户新配置验证。

Webdesk 固定 BFF：`GET /api/v2/room/config`、`POST /api/v2/room/store`、`POST /api/v2/room/providers`、`POST /api/v2/room/migration` 是 admin 控制面；`POST /api/v2/room/chat`、`POST /api/v2/household` 是业务面。no-store，写入校验 origin/对应 CSRF，无 Home/秘密文件权限。仍限现有 loopback BFF，不能据此宣传远程多 uid/TLS 已完成。

真实配置切换必须指定源/维护窗；不扫描开发机、不用聊天历史 Key、不动 NAS。真实云端验证需用户在表单重新填 Key 并同意发送测试短句；合成 Provider 不代表真实云端验收。
