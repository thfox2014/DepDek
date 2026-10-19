# DepDek 首启 · BitBay 公共账户 API

更新：2026-10-19。适用原生 AI-OS，不改变 R1、Webdesk 或 sidecar 权限。

## 已部署接口

公网地址为 `https://api.bitbay.site`，统一使用 `/v2`。无需管理员 Cookie、后台 Key 或租户 slug。

| 用途 | 方法和路径 | 请求/成功判据 |
| --- | --- | --- |
| 检测 | `POST /v2/user/login` | 固定 `{}`；预期 HTTP 400、`code:400`、`message:请求参数错误`，证明匿名参数校验端点可达；不是登录失败，也不尝试任何账号 |
| 验证码 | `POST /v2/email/send-code` | `{email}`；`code:0`；不返回开发验证码给前端 |
| 平台注册 | `POST /v2/user/register` | `{email, code, password}`；`code:0`、正整数 `data.userId` |
| 平台登录 | `POST /v2/user/login` | `{username:email, password}`；`code:0`、正整数 `data.userId`、返回邮箱与提交邮箱一致 |

接口目录位于 `src-tauri/src/bitbay_public_api.rs`，只有三个枚举项；没有调用方提供 URL、内部/管理员地址或兼容地址回退。发送账号资料的请求由 `vault/welcome/bitbay.rs` 处理，授权、审计和本机身份关联仍由 `vault/welcome.rs` 完成。网络检测先经过 WelcomeVault 审计，不因此解锁 Home 或模型权限。HTTP 超时/大小、禁止代理/重定向/自动重试、错误脱敏及本机持久化边界见 [首启契约](agentos-v2/runtime-welcome.md)。

## 核对来源

用户指定的 `OPC0608-wechat/opc-aicom` 项目：

- `docs/independent-site-frontend-auth.md`：公共登录、注册和邮箱验证码，不复制后台业务规则。
- `docs/dramaforge-external-integration.md` §8：当前正式对外认证接口使用 `/v2/user/login`。
- `docs/independent-site-tools.md`：平台通用注册 `/v2/user/register` 不带独立站 slug。
- `backend/internal/handler/router_v2.go`：上述三条路由明确注册在 public 分组；`/api` 为旧兼容前缀。
- `backend/internal/handler/{user,email}.go`：请求字段、统一回执，以及空请求在数据库/账户操作前被拒绝的实现。

`docs/openapi/bitbay-paas-v1.yaml` 自述为目标契约而非已部署清单，入口为 example.com；不据此切换到 `/v1/tenants/...` 或 OAuth 草案。

## 真实接口验证

2026-10-19 对公网三个 `/v2` 接口分别发送空 JSON，均得到 HTTP 400 的参数校验响应，而非 404、重定向或管理鉴权。Rust 实际 HTTP 客户端的两项显式 smoke 均通过：

```bash
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false cargo test \
  --manifest-path src-tauri/Cargo.toml --no-default-features --lib live_ -- --ignored
```

其中网络检测验证公共登录端点可达；账户路由 smoke 验证三个公共地址的参数校验。测试不携带真实邮箱、密码、验证码或 Token，不发送邮件、不创建账户、不进行真实登录；不能据此宣称 SMTP 投递和真实用户登录已端到端验收。

`http://127.0.0.1:1427/` 是显式标注的隔离布局预览，其模拟数据不构成公网请求证据。真实注册/登录在原生应用中由 Rust 调用以上公共接口。
