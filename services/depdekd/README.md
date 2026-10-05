# depdekd：AgentOS R1 本机服务切片

独立 Rust 业务服务与 `depdek` CLI。复用 `src-tauri` 的无 GUI 核心；支持受管只读文件查询和可选加密凭据管理，没有模型调用、业务文件修改、浏览器身份代理或真实数据迁移。当前支持 Linux/macOS 的 Unix socket。

实际接口、启动限制和故障处理见 [只读运行时契约](../../docs/agentos-v2/runtime-r1.md) 与 [凭据运行时契约](../../docs/agentos-v2/runtime-r1-secrets.md)，完整演进见 [重构计划](../../docs/agentos-v2/refactor-plan.md)。

第三批提供可选业务用户/目录授权与独立会话，见 [访问契约](../../docs/agentos-v2/runtime-r1-access.md)。`access_users` 默认空；开启时启动配置须在业务 root 外、文件 0600/父目录 0700，由实际非 root owner 拥有。密码 PHC 用 `depdek auth hash-password` 隐藏 TTY 生成，无默认业务密码。Webdesk 固定代理暂仅支持 loopback 合成开发，不自动切换原界面或开启模型。

```bash
# 从仓库根目录运行
npm run daemon:test
npm run daemon:build
services/depdekd/target/release/depdekd --help
services/depdekd/target/release/depdek --help
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
