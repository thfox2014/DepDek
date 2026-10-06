# V2 重构实施记录：第五批

2026-10-06；VERSION=0.2.1。接续第四批，只使用合成临时空间/假凭据/本机 Provider。没有访问 NAS、迁移真实 Home/凭据、切换旧业务主写或提交 Git。完整 R1–R5 未完成。

## 本批实现

- Linux 可选独立 uid/gid Worker socket。真实 peer 校验、固定两个 invoke 方法；owner 控制 socket 仍私有。Worker 不获得登录/签发/凭据/普通 owner 查询或任意 RPC。
- 默认关闭的单次本机 Model Gateway。显式授权精确 prompt、Profile revision、输出/TTL 预算；调用不能扩大内容/端点/模型或申请工具。数值 loopback `/v1`，禁 DNS/远端/redirect/环境 proxy/HTTP 自动重试。
- API Key 仅 core 内部限定 Provider 回调使用，校验引用/用途/版本/撤销；Secret Store 锁覆盖有界使用，rotate/revoke/lock 排空已有请求后生效。无明文 getter、秘密 argv 或 Agent Key。
- 意图审计后消费授权，再请求；失败/超时无自动重试，同授权不能换 call_id 重用。授权签发和返回前复验父 session/TTL，过期结果不释放；单次授权不是持久 Job/外部行动回执。
- 仅解析有界文本/usage（缺失为 null），不转发任意 Provider 字段/工具/错误。当前 Key 反射被拒绝；不宣称通用秘密识别、消除所有 HTTP/OS 内存副本或追回已送出字节。
- 固定 Worker 客户端新增 model/预期 server uid，CLI 新增 model stdin 及显式 stdin PHC 初始化，旧 Tauri/sidecar/React/Webdesk 业务接口不变。

## 验收

| 验证 | 最终结果 |
|---|---|
| Rust core（无 GUI） | 98 单测 + 2 RPC 集成通过；新增 6 个 Gateway 用例 |
| daemon/CLI/Worker | 13 集成通过；含新增实际子进程/选定 Context/一次性模型授权链路 |
| Webdesk / agent-service / space-service | 分别 40 / 16 / 3 测试通过，保留旧配置回归 |
| sidecar | 116 测试通过；没有把 fake-dsh 当作真实 Harness 验收 |
| strict clippy | core（无 GUI）及 daemon all-targets `-D warnings` 通过 |
| 构建 | macOS daemon/CLI/Worker release、Linux amd64 debug 通过 |
| 版本 / 设计 | VERSION=0.2.1 一致；22 操作/216 引用/76 链接/11 SQL 设计约束通过 |
| 真实模型 / 真机 | 未调用真实模型；未做 NAS/N3160 真机验收 |

Linux 由已有 Debian builder 镜像构建 x86_64 debug 二进制，在 macOS arm64 的 Docker Linux 环境（amd64 仿真）运行。6 组实际容器验收通过：

1. Worker uid=1002、core uid=1001；只读 rootfs/挂载、cap-drop/no-new-privileges、独立无网络 namespace。
2. Worker 未挂载原件、Secrets 或 owner socket，不能直连 core 的合成 Provider。
3. 错 uid 在实际 socket peer 层拒绝；正确 Worker uid 的 owner 凭据 RPC 被拒绝并审计。
4. 独立客户端经授权文件查询成功，跨用户目录不泄漏。
5. Worker 通过 core 实际连接合成 Provider，UTF-8/邮箱/usage 正确，授权消费后重放拒绝。
6. Logout 撤销票据；daemon 日志与两条审计不含假密钥、密码、bearer 或 prompt。

运行入口：[os/test-r1-isolation.sh](../../os/test-r1-isolation.sh)，控制脚本 [r1-isolation.py](../../os/tests/r1-isolation.py)。仅指定已有、含 Rust/Python 的本机 builder，不自动拉镜像或改服务。构建仓库/registry 只读，独立 Docker volume 保留合成 fixture/构建产物；本次 volume `depdek-r1-isolation-20261005-b5`。测试仅清理自己创建的临时容器，不删除 volume/证据，不操作其它容器。

启动 Docker 按原有策略恢复了已有容器，本批未改它们的配置/镜像或停止它们。Linux 初轮错 uid 连接会在发/收帧时重置，脚本原先只接受 JSON 拒绝；补支持连接层拒绝后复跑通过，不放宽业务授权。macOS 进程测试曾因合成配置父目录未设 0700 被正确拒绝，修正夹具权限后复验。

## 仍需完成

| 工作 | 本批之后的状态 |
|---|---|
| R0/生产执行 | Pi/Harness 真实受控工具/Gateway 可行性、远端 TLS/DNS/IP 策略、Context 与外发授权、真机隔离/性能仍未关闭 |
| R1 控制与迁移 | 持久 Profile/身份/对象 ACL、BFF 分 uid/TLS、三条凭据路径统一、独占 Adapter、显式迁移/恢复、审计轮转仍待实现 |
| R2–R3 | 来源 DB/版本/持久流水线、家庭知识与可信维修资料包/待办闭环仍待实现 |
| R4–R5 | 统一执行器/共享上下文治理、NAS 镜像/磁盘/SMB/更新/换机与断电真机验收仍待实现 |

合成 Provider 回执不是真实大模型或 Harness 成功；没有将新出口自动绑定旧 Agent Room，也没有因容器绿色结果宣称可向家庭用户开放全部业务能力。
