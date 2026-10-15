# V2 重构实施记录：第六批

2026-10-06；VERSION=0.2.1，接续已提交的第四/第五批。本批只用合成数据、假密钥和本机假 Provider，未读取或迁移真实配置/资料，未改 NAS、提交 Git 或切换旧 UI/运行服务。完整 R1–R5 仍未完成。

## 实现

- 新增独立 `r1-engine-worker.mjs`，而不是把 owner 凭据/文件方法塞进旧 Agent 工具。实际 Pi Agent 0.73.1 使用自定义 streamFn；实际 Harness AgentLoop 0.1.0-rc.6 使用最小 Cordis services/自定义 LlmAdapter，不加载 dsh-base/headless 默认 profile、Settings、Home、FS/bash/web/子 Agent 或 session persistence。
- 两种 SDK 的最终请求均通过固定 Rust Worker 客户端，Key 只在 core 内使用；模型/输出预算/精确单 user 文本同一规则。body/context 未由 Node 校验后直接外发，core 在消费授权后再次验证，engine-bound 票据不能走无 context 旧入口。
- ModelIssue 新增可选 engine，返回非秘密模型元数据；默认未绑定保持第五批兼容。Core result.engine 不把 caller 标签当实际执行证明；受信 Worker runtime facts 来自支持包版本检查和实际 SDK 生命周期。
- 有序 safe progress/result/error，丢失 usage/cost 显示未知。SDK 所需占位/不同 cache 语义不用于产品统计；结果保留 core 上报值。假 Provider 的 12/8 只是合成测试报告，不是实际模型消费。
- 输入/输出/时间有界，错误只传播固定白名单代码，不输出原始异常/敏感字段/隐藏思维；无自动重试。Node 初始化剥离秘密环境，Rust 子进程只拿最小环境；OS 隔离/启动前环境清理仍必须由可信 launcher 负责。
- 新 Worker 与旧 main bundle 分开；桌面/Webdesk/SessionManager/ProviderConfig 接口保持不变，实际扩展已登记 contract §14。代码包 metadata 读取仅用于固定 SDK 版本，不是业务文件访问工具。

## 验证及问题修正

| 验证 | 最终结果 |
|---|---|
| Rust core（无 GUI） | 100 单测 + 2 RPC 集成通过；新增 2 个 engine/final-context 用例 |
| daemon/CLI/Worker | 13 集成通过，单独/串行复跑通过 |
| sidecar | build + 124 测试通过；新增 8 个实际 SDK/错误/形状/取消用例 |
| 旧服务回归 | Webdesk 40、agent-service 16、space-service 3 测试通过 |
| strict clippy | core（无 GUI）与 daemon all-targets `-D warnings` 通过 |
| 构建 | macOS release daemon/CLI/Worker、Linux amd64 debug、独立 Node Worker 通过 |
| Linux 容器 | 9 组通过；实际两 SDK loop、跨引擎伪造拒绝、Provider 请求计数无增长、授权不可重放 |
| 版本/设计 | VERSION=0.2.1；22 操作/216 引用/80 链接/11 SQL 设计约束通过 |
| 真实模型/真机 | 未调用真实大模型；未做 NAS/N3160 真机验收 |

Linux amd64 二进制在本机 Docker Linux/amd64 仿真环境复验，9 组检查通过：第五批 6 组继续成立，加两种实际 SDK loop 和结果一致性。Worker uid=1002、core uid=1001；只读 code/rootfs、无网络、cap-drop/no-new-privileges、无原件/Secrets/owner socket挂载。两种 SDK 真实循环都经 Unix → core → 假 Provider 得到相同文本/模型/上报 usage；不是 fake-dsh，不是直接调用自制 model 函数就标记 SDK 完成，也不是真实模型或 NAS 真机验收。

出口使用受 VERSION 管理的静态公开产品 User-Agent，符合 Harness 自定义 adapter 的白标归因要求；假 Provider 验证实际 header，不附带用户/路径/session/prompt。运行信息不是硬件远程证明；context 中的请求引擎标签始终只作授权约束。

本批暴露并修正：

1. npm peer 自动选到 rc.8 与 rc.6 混合导致 ERESOLVE；固定同版 peer 家族/lockfile，未用 force/legacy-peer-deps。
2. Pi 把单条文本规范化为 TextContent block；适配受支持表示后仍由 core 逐字节检验，不放行历史/工具/系统扩展。
3. 并行 debug Argon2 测试与多个编译使一次业务进程登录达到 deadline，EOF 验收失败；核心测试通过后单独/串行复跑服务，不放宽运行期授权/HTTP/RPC deadline。目标低端设备性能仍需实测。

容器只挂载新 Worker 代码与依赖、固定 Rust 客户端、worker socket；保留合成 fixture/build volume `depdek-r1-isolation-20261005-b5`。测试清理自己的临时容器，未操作其它服务/容器。运行 `npm --prefix sidecar ci --ignore-scripts && npm --prefix sidecar run build` 后再执行 `bash os/test-r1-isolation.sh`（本机已有 builder/公开依赖 cache）。

## 剩余工作

1. 持久控制 Profile/身份与对象 ACL，统一 AES/R1/agent.env 凭据路径；显式迁移/备份/恢复、独占旧客户端 Adapter、生产 BFF/TLS 与审计轮转。
2. 带来源版本/权限的完整 Context、受控云端出口与真实模型验收；给 Pi/Harness 接受控工具/持久 Job，按实际能力逐项开放，不恢复危险默认工具。
3. R2 SourceRevision/原件/DB/可重入理解流水线；R3 家庭知识/冲突/价值/Plan/Grant/Receipt 与维修资料包/待办闭环。
4. R4 共享记忆/Obsidian 权限投影/应用技能及 R5 Debian NAS 安装/磁盘/SMB/更新/备份/换机/断电真机发布门。

最小受控 SDK 文本链路已经证明可行，但不能据此声称原 Agent Room 已无密钥、云端/所有技能已可用或整个 R1 已关闭。
