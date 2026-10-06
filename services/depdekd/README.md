# depdekd：AgentOS R1 本机服务切片

独立 Rust 业务服务、`depdek` CLI 与 `depdek-worker` 客户端。复用 `src-tauri` 的无 GUI 核心；支持受管只读文件查询、可选加密凭据管理与固定 loopback 业务代理，第五批增加默认关闭的一次性本机模型出口。没有业务文件修改或真实数据迁移。当前支持 Linux/macOS Unix socket，独立 uid Worker 通道仅 Linux。

实际接口、启动限制和故障处理见 [只读运行时契约](../../docs/agentos-v2/runtime-r1.md) 与 [凭据运行时契约](../../docs/agentos-v2/runtime-r1-secrets.md)，完整演进见 [重构计划](../../docs/agentos-v2/refactor-plan.md)。

第三批提供可选业务用户/目录授权与独立会话，见 [访问契约](../../docs/agentos-v2/runtime-r1-access.md)。`access_users` 默认空；开启时启动配置须在业务 root 外、文件 0600/父目录 0700，由实际非 root owner 拥有。密码 PHC 用 `depdek auth hash-password` 隐藏 TTY 生成，无默认业务密码。Webdesk 固定代理暂仅支持 loopback 合成开发，不自动切换原界面或开启模型。

第四批提供短期、可撤销、目录子集/命令/调用数受限的 Worker 只读委托，以及启动 Provider Profile 的凭据引用检查，见 [Worker/Profile 契约](../../docs/agentos-v2/runtime-r1-workers.md)。`depdek-worker` 只转发固定 worker.invoke，不提供 owner/凭据方法；仍是同 uid **受信**开发客户端，不抵御恶意同 uid 程序，也不向 Agent 自动注册。

第五批的 [Worker/Gateway 契约](../../docs/agentos-v2/runtime-r1-gateway.md) 提供可选分 uid 固定 listener 与 exact-input model bearer。`local_model_profiles` 只接受数值 loopback `/v1` 端点，禁止 DNS/云端/redirect/proxy/自动重试；调用次数为一次，Key 留在 core 内部，轮换/撤销排空当前请求。Linux 验收脚本只用合成 Provider，不是真实模型、Pi/Harness 或 NAS 真机验收。

[Worker/Profile 配置示例](config.workers.example.json) 含不可直接运行的密码 PHC 占位符、合成凭据引用和 example.invalid 模型地址。必须先准备独立测试空间、生成用户 PHC、将已暂存凭据的真实引用填入受保护配置；不要用它覆盖真实服务配置。

```bash
# 从仓库根目录运行
npm run daemon:test
npm run daemon:build
services/depdekd/target/release/depdekd --help
services/depdekd/target/release/depdek --help
services/depdekd/target/release/depdek-worker --help
```

使用 [配置示例](config.example.json) 登记一个独立测试数据根、明确的可读目录和私有 socket 路径。不要直接指向现有 DepDek Home；旧数据写入端和新服务尚未完成协调切换。

```bash
# 配置文件必须先按实际非 root 账号与路径填写
services/depdekd/target/release/depdekd serve --config /absolute/path/config.json

# 另一个终端，以相同 OS 用户运行
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock health
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock commands --workspace family-demo
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock command file.list --workspace family-demo --input '{"path":"documents","limit":20}' --json
```

测试只使用临时合成材料，并真实启动 daemon 和 CLI。非 root 身份用例在 root 环境会跳过，不能把该环境的绿色结果视为完整身份验收。

凭据管理默认禁用。选择 [凭据配置示例](config.secrets.example.json) 后，预先准备与业务 root 无包含关系、当前账号所有的独立 0700 目录；不得在配置文件放主密码/key。初始化与解锁用 CLI 隐藏 TTY：

```bash
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock credentials init --workspace family-demo --operation init-001
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock credentials unlock --workspace family-demo
services/depdekd/target/release/depdek --socket /absolute/private/runtime/command.sock credentials list --workspace family-demo
```

保存/撤销/导入使用显式 `--stdin` JSON，不接受秘密 argv/env，不回显秘密。导入只暂存绑定，不修改旧源或启用模型；真实迁移、平台恢复与 Worker 租约尚未接入，见运行时契约。

业务登录用 `depdek --socket PATH auth login --stdin`，传入 username/password JSON；Worker issue/revoke/invoke 使用 `--workspace ID --stdin`。将签发的短期票据通过 stdin 交给对应受信 Worker，不能放进 argv、日志或模型上下文。`provider_profiles` 只含凭据引用，`depdek --socket PATH providers --workspace ID` 报告锁定/不存在/用途或版本不匹配/撤销；始终不启用模型，不能把引用状态当作连接测试。

模型 issue/revoke/invoke 同样用 `--workspace ID --stdin`，独立 Worker 以 `--model --server-uid UID` 访问固定调用。`auth hash-password --stdin` 支持受控无 TTY 合成初始化；输入只含 password，输出 PHC，不接受秘密 argv。新出口不会读取 agent.env 或改变旧 Agent Room 模型，生产接线仍待后续。
