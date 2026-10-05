# V2.0 接口设计

> 目标接口，尚未实现。总设计见 [架构](architecture.md)，数据语义见 [数据设计](data-model.md)。[OpenAPI](openapi.json) 只定义首期公共传输边界，业务参数以注册 Command Manifest 为准。现行桌面接口仍以 [contract.md](../contract.md) 为准。

## 1. 一套业务语义，多个入口

```text
语音 / UI / CLI / 授权 MCP
             ↓
版本化 Command Manifest → 身份与 Vault 授权 → 查询 / Plan / Job
             ↓
         Result / Evidence / Receipt / PanelSpec
```

HTTP 经 Webdesk BFF；本机 CLI、Tauri 经 Unix socket；Worker 用 run-scoped 工具通道。它们调用同一 Command Hub，不能各自实现一套业务逻辑。Windows/macOS 本机传输分别采用受 ACL 保护的命名管道或 Unix socket；不得为适配平台开放无认证 TCP。

### 请求上下文（服务端生成）

`RequestContext = request_id + trace_id + principal_id + authentication_epoch + workspace_id + policy_revision + delegation_id + agent_id/run_id（可选）`。

- `principal_id` 从认证会话取得，Agent 委托绑定发起用户；请求体没有可信 actor/role 字段。
- Unix peer credentials 校验服务进程，用户会话校验最终用户；两者缺一不可。
- Workspace 成员资格、对象权限、能力授权、当前撤权状态在 Vault 入口检查。
- 查询、事件重放、下载与预览也需要认证。不可见对象以 `NOT_FOUND` 返回，避免存在性泄露。
- 初始设备管理员创建使用本机一次性首启票据，无默认公共密码；仅恢复模式可重设管理员。业务管理员不自动获得私人空间授权。

浏览器采用业务服务签发、BFF 安全代理的 HttpOnly 会话 cookie，TLS、SameSite、Origin 校验与 CSRF token；会话有绝对/空闲超时、撤销与认证代际。远程 CLI/MCP 用带 audience、范围与期限的委托 token，不能把浏览器 cookie 或 Provider key当工具凭据。

## 2. 公共 HTTP 路由

下表全部是计划能力，P0 实现依赖 R1–R3；不是当前 `/api/*` 路由清单。

| 方法与路径（前缀 `/api/v2`） | 输入/输出 | 语义 |
|---|---|---|
| GET `/health` | minimal health | 未认证只返回就绪/版本，不泄露目录与模型 |
| POST `/auth/login` | username/password → session | 限速；密码不进入日志 |
| GET `/auth/session` | principal、授权空间、CSRF token | 不返回密码、Provider key |
| POST `/auth/logout` | → receipt | 撤销当前会话 |
| GET `/workspaces` | visible workspaces | 不返回不可见空间数量 |
| GET `/commands?workspace_id=…` | 可见 Manifest 列表 | 过滤权限、安装模块与引擎能力 |
| POST `/commands/invoke` | CommandRequest → CommandResult | 查询直接返回；副作用进入计划/任务治理 |
| POST `/commands/plan` | CommandRequest → Plan | 只预览，不执行副作用 |
| POST `/plans/{id}/decision` | DecisionRequest → Plan | 可信用户确认/拒绝精确计划 |
| POST `/plans/{id}/apply` | ApplyRequest → Job | 再检查政策与输入版本；幂等入队 |
| GET `/jobs/{id}?workspace_id=…` | Job、步骤、回执摘要 | 不按 UI 消息推断完成 |
| POST `/jobs/{id}/control` | pause/resume/cancel/retry | 受状态机和版本约束 |
| GET `/events?workspace_id=…&cursor=…` | SSE DomainEvent | 有界重放；只投递可见事件 |
| POST `/sessions` | workspace、agent → Session | 固定工作空间；每个 Agent 对话隔离 |
| POST `/sessions/{id}/turns` | text、grant refs → Run | 输入不是 shell；空授权不隐式外发 |
| GET `/runs/{id}?workspace_id=…` | Run + 消息快照 | 断流重置时替换文本缓存，不重复追加 |
| GET `/runs/{id}/events?cursor=…` | SSE RunEvent | 观察性进度、文本、面板、结果 |
| POST `/uploads` | filename/type/size → Upload | 暂存配额与上传权限 |
| PATCH `/uploads/{id}/content` | bytes + Content-Range | 单块最多 8 MiB，校验偏移/总大小 |
| POST `/uploads/{id}/commit` | expected hash → SourceRevision/Job | 封存原件；后续解析失败不撤销接入 |
| GET `/workspaces/{id}/content/{revision_id}` | 授权 bytes、Range | 文件名/MIME 由可信元数据产生 |
| PUT `/providers/{id}/credential` | write-only secret → status | 控制面专用；不得通过普通命令任意传密钥 |

除上传块外，初始 JSON 请求上限 64 KiB；聊天正文上限 8,000 Unicode 字符。历史由服务按权限与预算装配，不接受无限客户端 history。附件走来源 ID。分页最多 100 项；图遍历默认最多 3 跳、500 个授权节点，超限返回截断标志。限额属于可配置策略，不是性能承诺。

上传/下载是大内容传输适配，不是业务旁路：commit 内部调用 `source.import`，由已有接入 Grant 生成内部 Plan/Action/Receipt，并与来源登记同事务。Secret 写入是独立控制面能力，只有收到 broker 成功回执才显示 configured；秘密落盘与元数据之间使用操作 ID 对账，不能假设跨进程原子提交。

Query 成功仍需表达 `freshness`、`coverage`、`conflicts`、`unknowns`、`evidence_refs`、`next_cursor`。Cursor 是不透明令牌，绑定空间、查询和策略代际；撤权后旧 cursor 失效。

## 3. 请求、结果与错误

```json
{
  "workspace_id": "ws-family",
  "command": "family.repair.prepare",
  "command_version": "1.0",
  "input": {"asset_id": "asset-ac-01", "include_contact_draft": true},
  "idempotency_key": "repair-ac-request-01",
  "expected_revisions": {"asset-ac-01": 7},
  "authorization_ref": "grant-workspace-drafts"
}
```

`expected_revisions` 使用有类型的资源 ID；服务展开来源/证据依赖，客户端不能省略已知依赖来绕过检查。副作用请求必须提供幂等键；同主体、空间、命令、键而参数摘要不同返回 `CONFLICT`。相同请求返回原 Plan/Job/Receipt，重试不重复产生效果。

```json
{
  "api_version": "2.0",
  "request_id": "req-01",
  "trace_id": "trace-01",
  "workspace_id": "ws-family",
  "policy_revision": 12,
  "data": {
    "status": "accepted", "job_id": "job-01", "plan_id": "plan-01"
  }
}
```

`CommandResult.status` 为 `completed`、`accepted` 或 `waiting_decision`；completed 不表示资料齐全，缺失保修条款必须留在结果的 unknowns。命令未执行不返回伪造 Receipt。

错误 envelope 与成功互斥：`error = {code,message,retryable,details}`，无栈、密码、完整模型请求。HTTP 状态与错误码映射：

| HTTP | code | 客户端行为 |
|---|---|---|
| 401 | AUTH_REQUIRED / SESSION_EXPIRED | 登录；不静默恢复外部行动 |
| 403 | FORBIDDEN / OUTBOUND_NOT_AUTHORIZED | 申请适当授权 |
| 404 | NOT_FOUND | 无此可见资源 |
| 409 | CONFLICT / POLICY_CHANGED / SOURCE_STALE | 刷新或重新生成计划 |
| 413 / 422 | LIMIT_EXCEEDED / INVALID_INPUT | 缩小输入/修正参数 |
| 429 | RATE_LIMITED | 按 retry_after 延后 |
| 503 | CAPABILITY_UNAVAILABLE / WORKSPACE_LOCKED / AUDIT_UNAVAILABLE | 展示原因，不绕过门禁 |

外部效果 unknown 是 Action/Job 的业务结果，不应用一个通用 HTTP 500 掩盖。客户端必须显示“结果待查证”，不能提供无条件再发按钮。

## 4. Command Manifest 与能力

每个命令必须登记名称、语义版本、JSON Schema、能力、效果、幂等方式、确认条件与补偿性质。初始发布拒绝未知命令、额外参数及未经登记的扩展。OpenAPI 的 `input` 动态结构不是开放执行权限。

```json
{
  "name": "family.repair.prepare",
  "version": "1.0",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "required": ["asset_id"],
    "properties": {
      "asset_id": {"type": "string"},
      "include_contact_draft": {"type": "boolean", "default": true}
    }
  },
  "output_schema_ref": "RepairPacketResult@1",
  "capabilities": ["knowledge.read", "source.read", "artifact.create", "task.propose"],
  "effect": "local_reversible",
  "authorization": "scoped_grant_or_plan_approval",
  "idempotency": "required",
  "compensation": "versioned_artifact_tombstone",
  "offline": true,
  "engine_required": false
}
```

权限不是“分析/建议/执行”数字等级。Grant 定义 `主体 × 数据范围 × 能力 × 有效期`，附数量、预算与用途；技能声明只是申请能力。查询也受数据 ACL，外发另有独立批准。

### 核心命令目录

| 领域 | 命令 | 目标阶段 / 边界 |
|---|---|---|
| 来源 | `source.list/get/preview/import/export` | P0；固定版本，导出重新检查权限 |
| 文件 | `file.list/read/create/rename/move/trash` | P1；仅登记用户资源，本地回滚策略；不触及内部库 |
| 接入 | `connection.list/configure/sync` | P1；凭据另走 write-only 入口，固定 Connector |
| 理解 | `understanding.run/status/correct` | P0；候选与解析版本，不能确认家庭事实 |
| 知识 | `knowledge.search`、`object.get/create` | P0；有证据、有界查询 |
| 断言 | `assertion.propose/decide`、`relation.propose/decide` | P0；decide 限可信人或已登记确定性规则 |
| 身份归一 | `identity.link/unlink` | P1；保留决策与证据，可拆分；不自动跨空间合并 |
| 价值 | `value.explain/evaluate` | P0；上下文价值不决定原件删除 |
| 家庭事务 | `family.repair.prepare`、`artifact.get`、`task.create/update` | P0；资料包、待办、草稿，无外发 |
| 记忆 | `memory.query/get/propose/confirm/reject/tombstone` | P1；现有 JSONL 语义，确认不能由模型自授权 |
| 对话 | `context.build`、`session.compact`、`run.cancel` | P1；有界摘要，保留证据，compact 不是删除历史 |
| 媒体 | `media.search/open`、`voice.transcribe` | P1；授权流地址；语音先回填草稿 |
| 外部行动 | `mail.send`、`calendar.publish` | P2；精确 Plan，连接端幂等/查证，禁止盲重放 |
| 系统 | `provider.list/configure/test`、`engine.list/configure` | P1；测试明确费用/外发内容，key 不进入响应 |
| 协作 | `agent.delegate`、`team.result.collect` | P2；根 Job 管理，子委托不能扩大授权或代用户确认 |
| 管理 | `backup.create/verify/restore`、`device.share.configure` | P2；设备管理授权，恢复先停止业务写入 |

P0/P1/P2 是 V2 能力范围，不对应当前 0.2.0 的实现程度；实现顺序见 [重构计划](refactor-plan.md)。扩展到相册、音乐等应用时，必须先定义 Manifest 与 CLI 验收，不能先造只支持鼠标的孤立流程。

## 5. Plan、Decision 与 Action

Plan 包含：`id/revision/hash`、目标命令版本、输入摘要、全部来源版本、diff、影响对象、动作清单、风险、可逆性、所需授权、policy_revision、费用/数量上限、期限。

Decision 请求：`workspace_id, expected_revision, plan_hash, decision=approve|reject`。用户可以缩小计划范围，不能通过 Decision 扩大原 Plan；修改目标必须生成新版本。Decision 来自可信用户界面或用户 CLI，不接受模型文本“用户已同意”。

Apply 请求：`workspace_id, expected_revision, plan_hash, idempotency_key`。服务检验有效 Decision 或已有精确 Grant 后，在同一事务写 Action、Job 与事件。执行排队后还要重验权限/来源；证据失效进入 waiting_decision 并重新预览，不继续使用过期授权。

Proposal：`proposed → accepted | rejected | expired | superseded`。

Action：`pending → running → succeeded | failed | unknown | partial`；需要补偿时 `compensation_pending → compensated | compensation_failed`。每次补偿是新行动，由原行动关联，不能抹掉历史。

Job：`queued | running | waiting_decision | waiting_unlock | paused | succeeded | failed | cancelled | blocked_unknown`。跨状态跳转由服务校验；取消不保证撤回已提交外部效果。UI 的等待与任务成功不是聊天模型自己宣告的状态。

## 6. 两类事件与流式可靠性

### 领域事件（持久、至少一次）

```json
{
  "event_id": "evt-01", "workspace_id": "ws-family", "sequence": 42,
  "type": "source.revision.created", "aggregate_id": "src-invoice-01",
  "aggregate_revision": 2, "job_id": "job-ingest-01",
  "occurred_at": "2026-10-04T04:00:00Z",
  "payload": {"revision_id": "rev-invoice-02"}
}
```

业务写入与 outbox 同事务。消费者以 event_id 去重，以 aggregate_revision 判断因果；工作空间 sequence 提供重放顺序，不宣称跨空间全局顺序。订阅先过滤 ACL，cursor 过期返回 reset_required，重新获取授权快照；事件不可包含不可见内容或计数。

### Run 事件（观察性、最终消息权威）

`run.started / progress / tool.started / tool.finished / text.delta / panel.updated / message.completed / usage / run.completed / run.failed / stream.reset`。

每条带 `run_id, sequence, message_id（文本时）, emitted_at`；文本另带 chunk_index。服务按字节解码 UTF-8、完整 NDJSON 行解析、单队列归并；不通过并发回调拼接字符。UI 按 sequence 去重、有序应用，不从思考/工具内容拼接最终答案。最终 `message.completed` 含权威全文，替换 delta 缓冲并做 Markdown 渲染。

短期事件 ring 支持断线续传；超出 ring 发 stream.reset，客户端读取最终/当前消息快照后替换，不重复追加。SSE 断线不取消 Job。普通进度不永久记录 token 级刷屏；错误、工具回执、最终产物与真实 usage 持久保存。

“分析过程”仅展示执行器公开的安全摘要和可观察阶段；隐藏思维链不对外承诺可见。Harness 只支持批量输出时明确 stream_mode=batch，不制造虚假的实时思考。

## 7. PanelSpec、内容与外发

可信后端根据业务结果产生 PanelSpec：`object_choice / conflict_review / plan_approval / artifact / media / timeline`。结构为 `panel_id,type,revision,title,visible_refs,actions`；actions 只含已注册命令、预填授权参数与需要的版本。前端不得执行模型生成的 JS、HTML 或任意 URL。

Markdown 净化、外链策略与媒体 MIME 检查独立于模型。原件下载按每次请求/Range 分块检查权限；撤权停止后续块，已发送给用户/云端的数据无法物理追回。

OutboundGrant 绑定 `provider_id, purpose, source_revision_ids, allowed_derivations, bytes_limit, request_limit, expires_at`。ContextSnapshot 保存内容清单与版本，Model Gateway 只接受快照/租约引用；Agent 不自由指定 endpoint 或 API key。超预算/增加来源重新确认。

## 8. Engine 与 Worker 内部接口

```ts
interface EngineAdapter {
  describe(): EngineCapabilities;
  prepare(input: RunInput): Promise<PreparedRun>;
  run(run: PreparedRun): AsyncIterable<SafeRunEvent>;
  abort(runId: string): Promise<AbortReceipt>;
}
// RunInput: agent/skill versions, ContextSnapshot ref, delegation ref,
// model gateway lease, tool manifest refs, budgets; no raw key or host path.
// EngineCapabilities: tools, streaming, usage, reasoning_summary,
// model_protocols, adapter_version, runtime_version, isolation_verified.
```

Worker 发工具请求到 Hub：`run_id, call_id, command, version, input, idempotency_key`；主体由受认证 worker connection + run 委托取得。Hub 校验 capability，返回工具 Result/等待确认；Agent 不能自行运行 Plan Decision。Extractor 输出候选、来源 locator 与模型/解析器版本，不持主库写权。

UDS 使用版本化 JSON-RPC 2.0：`v2/command.invoke`、`v2/command.plan`、`v2/plan.decide`、`v2/plan.apply`、`v2/job.control`。业务错误用 JSON-RPC server error + `data.code`，与 HTTP 语义一致；传输错误与业务错误分开。v1 stdio 的 ID 范围和错误码不变，两个协议不混在同一未协商连接。

MCP 未来作为 Manifest 的受限投影：调用 `depdek.command` 等固定工具，工具名不授予权限；外部 MCP 服务安装、网络、输入和输出都需注册及沙箱。禁止 token 透传，按目标 audience 与任务委托授权。[MCP 安全规范](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

## 9. CLI 对等与兼容迁移

```bash
depdek command knowledge.search --workspace ws-family --input '{"query":"客厅空调"}' --json
depdek plan family.repair.prepare --workspace ws-family --input '{"asset_id":"asset-ac-01"}' --json
depdek plan approve plan-01 --hash <reviewed-plan-hash>
depdek plan apply plan-01 --hash <reviewed-plan-hash> --idempotency repair-ac-request-01
depdek job inspect job-01 --json
depdekadmin backup verify --snapshot <snapshot-id> --json
```

CLI 不收任意 bash；批准命令仍要求用户身份和精确 hash。Agent 使用的是类型化工具，不拥有 depdekadmin。每个视觉业务流程必须可以用上述类型化命令完成，并得到同样的产物与回执。

| 当前接口 | V2 适配方式 |
|---|---|
| 桌面 `vault/*` | v1 Adapter 调用同一 Vault；不直接映射任意路径到新内库 |
| `agent/create_session/send/analyze` | Session/Run + Context + Engine Adapter，保留只读分析边界 |
| `memory/*`、`todo/*` | 单一权威源代理；确认与写入权限逐步加强 |
| Webdesk `/api/agent/status/chat/providers` | v1 BFF 映射新服务；旧四人 ID 保留别名 |
| agent-service 自定义 op NDJSON | 接入 Adapter，过渡后停用独立会话/Provider 主写 |
| space-service CLI/socket | 只读兼容/命令转发；主写切换后禁 direct 模式 |

废弃条件：两代客户端契约测试通过、数据迁移可验证、回滚可用、使用日志确认旧入口不再需要；不靠改 URL 一次性切断旧功能。
