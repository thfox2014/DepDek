# R1 第三批：业务会话与受限 Webdesk 代理

> 2026-10-05；VERSION=0.2.0。新增已运行的单 workspace、目录级只读会话切片；不是完整家庭身份系统、对象 ACL、Run 委托或 Credential Lease。正式登记见 [contract §11](../contract.md#11-agentos-r1-第三批独立业务会话与目录授权)，接续 [只读入口](runtime-r1.md) 与 [凭据库](runtime-r1-secrets.md)。

## 1. 信任边界

```text
浏览器业务登录（不是 Webdesk admin）
   → Webdesk：固定路由、Origin、独立 HttpOnly cookie
   → 私有 Unix socket：同时验证服务 peer uid 与业务 session
   → Vault/access：注册主体、CSRF、期限、目录范围
   → Vault：fd/no-follow、预算、严格审计、返回前期限复核
```

服务 Unix uid 只证明本机进程；业务用户名/密码由 daemon 校验并签发不透明会话，不允许 JSON 中的 actor/role 自封身份。Webdesk 管理员 cookie 不能访问业务目录；`--insecure-no-auth` 下新业务代理入口拒绝运行，不降级成 admin。

业务用户没有凭据管理权限、文件写权限、动态角色/用户注册、shell、模型外发或原始磁盘句柄。BFF 不读 Home、秘密或控制配置，不拥有任意 RPC 转发入口；只读原件仍由 daemon 的 Vault 打开。

本切片仍是**可信同 uid、可信内核与本地文件系统**原型：BFF 与 daemon 的 socket 依赖同一 OS owner，不能抵抗恶意同账号进程。生产 BFF/Worker 独立 OS 账号、可信服务委托及其 socket ACL 尚需 Linux 验收；不能把这条链路称为完整的多租户隔离。

## 2. 显式注册与启动保护

daemon 配置新增 `access_users`，默认空，旧功能不变。示例见 [config.access.example.json](../../services/depdekd/config.access.example.json)。

```json
{
  "principal_id": "alice",
  "password_hash": "<从隐藏 TTY 生成的 PHC；不是明文密码>",
  "read_paths": ["documents/alice"]
}
```

- 最多 32 个用户，每人 1–32 个相对目录；所有目录必须已存在、位于 root 的已登记可读范围中。越顶、内部目录、根范围、symlink、重复主体和 `local:` 冒充均拒绝。
- 启用业务用户时，**启动配置必须在业务 root 外**，为当前运行账号拥有的私有单硬链接普通文件（0600），父目录私有（0700）、末级非 symlink，读取上限 64 KiB。验证仍在 Vault。服务不自动 chmod。
- 只保存密码验证 PHC，不保存明文登录密码。只接受 Argon2id v19、m=65536 KiB/t=3/p=1、16 字节 salt/32 字节输出的固定格式；拒绝配置提供超大 KDF 参数。
- 无默认业务帐号/密码。`depdek auth hash-password` 使用无回显 TTY 输出 PHC；它不是把密钥写进普通配置。PHC 也应私有保存，不能放到可读文档或公开仓库。
- 用户/目录注册是受信启动配置，不是知识中的 Person。当前仅一个 workspace/静态 policy_revision=1；改成员、密码或权限需受控停机、改私有配置并重启。重启使旧会话失效，未实现热更新或持久 membership API。

密码 API 使用已验证的 [RustCrypto Argon2 PHC 接口](https://docs.rs/argon2/latest/argon2/)，不复用 SecretStore 的解密密钥或主密码。隐藏 TTY 哈希命令至少要求 12 字节，不等于密码强度评估或 MFA。

## 3. 已实现的本机 RPC

沿用有界 NDJSON/Unix peer 校验与 V2 envelope。业务 session token 是认证 bearer，不是 Provider key；只限 `depdek-business-read` 目的。Owner CLI 的旧只读/凭据方法仍是独立本机管理入口，不向 BFF 暴露。

| 方法 | params | result.data |
|---|---|---|
| `v2/auth.login` | username, password | session_token、csrf_token、principal_id、workspace_id、expires_in、idle_timeout、audience |
| `v2/auth.session` | session_token | principal_id/workspace_id/policy_revision/audience；不返回 token/password/PHC |
| `v2/auth.logout` | session_token, csrf_token | logged_out:true；原会话失效 |
| `v2/delegated.workspaces` | session_token | 当前用户可见的单一空间列表，无其它空间总数 |
| `v2/delegated.commands` | session_token, workspace_id | 三个版本化只读 file Manifest |
| `v2/delegated.invoke` | session_token, csrf_token, workspace_id, command, command_version, input | completed/result/freshness/source_revisions_available:false |

查询命令仍只有 `file.list/read/stat@1.0`。未登记版本/写命令拒绝，不回落到 owner 命令；未知字段拒绝。不可见路径/空间返回 NOT_FOUND，不披露它是否存在。访问工具能力不等于获准读取所有注册目录。

会话随机 256 bit，内存索引只持 token SHA-256；CSRF 也只存摘要。绝对期限 3600 秒、空闲 600 秒、最多 64 个有效会话；登录清理过期项。已知用户各有失败桶，未知用户共享一个有界桶，5 次失败后 30 秒冷却；未知用户也执行相同预算 KDF，不返回“帐号不存在”。无持久会话/MFA/IP 风险评估。调用者需保留登录获得的 CSRF nonce；session 查询不回发原 nonce，丢失后需重新登录，正式前端会话续接尚未实现。

认证读取与 logout 同一 mutex 串行化，锁覆盖读取/审计；I/O 完成后检查绝对/空闲期限，再释放内容。logout 返回后旧 token 不能取得新的 scope。长阻塞 I/O、已经写进 socket 的字节不能被“收回”；不是取消已送达结果的承诺。同步审计失败不签发会话、不释放正文。

每个进入 Vault 的认证/授权操作和文件成功/拒绝都有严格审计，不记录密码/PHC/session/CSRF/正文。启动注册失败也记录；前置 JSON 形状/传输拒绝仍属于待补统一协议安全审计。会话无磁盘持久化，daemon 重启后无法复用。

## 4. 已实现的 Webdesk HTTP 子集

独立契约见 [Webdesk 设计增量](../webdesk-design.md#agentos-v2-业务只读-bff第三批)。默认关闭，不影响既有 `/api/login`、`/api/files` 和 Agent Room；当前 SPA 未增加业务登录表单，也没有自动切換数据源。

| HTTP | 对应语义 |
|---|---|
| POST `/api/v2/auth/login` | username/password；精确 Origin 校验，防登录 CSRF |
| GET `/api/v2/auth/session` | 获取当前业务主体，无凭据/会话 token |
| POST `/api/v2/auth/logout` | 精确 Origin + x-depdek-business-csrf |
| GET `/api/v2/workspaces` | 可见单 workspace |
| GET `/api/v2/commands?workspace_id=…` | 可见只读 Manifest |
| POST `/api/v2/commands/invoke` | 精确 Origin + CSRF；固定 delegated.invoke |

`business_socket` 与 `business_origin` 必须同时显式配置。**当前只允许绑定 loopback、数值 loopback Origin 的开发 HTTP，拒绝远程启用。** 现有 Webdesk tls_cert/tls_key 只是反向代理提示，serve 仍为 HTTP，不能作为加密链路证明；本切片同时配置证书标志也会拒绝。后续须验证真实 TLS/受限代理部署，不依据 X-Forwarded-* 假设加密。Origin 必须完整精确、不含路径/用户信息/query/fragment；Host 不作为信任来源。

```toml
# 仅本机合成开发；实际部署需已有 TLS 配置
bind = "127.0.0.1:8787"
business_socket = "/absolute/private/runtime/command.sock"
business_origin = "http://127.0.0.1:8787"
```

原 Webdesk auth 仍要正常配置，不能靠 insecure 标志开启业务代理。业务帐号来自 daemon，不是原管理员密码。

登录响应移除 `session_token`，只以 `depdek_business_session`、Path=/api/v2、HttpOnly、SameSite=Strict、Max-Age=3600 cookie 设置。当前允许的 loopback HTTP 模式不带 Secure，生产 Secure cookie/TLS 必须与真实链路同批接入。csrf_token 提供给客户端用于 POST header。响应一律 no-store，不开跨域 CORS；有 Origin 的 GET 也必须匹配。

BFF 请求上限 64 KiB、响应 2 MiB、固定 20 秒网络期限、对端 uid 验证、固定业务方法、不日志请求体。无通用 `/rpc`、CredentialRef getter 或凭据管理路由。密码/关键传输缓冲尽力 zeroize，不承诺擦除浏览器/解析器/OS 副本。登录/退出另在 Webdesk 本地追加脱敏状态审计；正文放行以 daemon 的严格审计为准。

## 5. 验收与未完成

[第三批记录](implementation-status-batch3.md) 记录单测、真实子进程、HTTP 路由 + 真实 socket 验证。Linux 分 uid、真实 TLS、同账号隔离、磁盘/日志轮转、掉电和 NAS 性能尚未验证；合成 HTTP Router 验收不能代替部署 TLS 验收。

后续必须完成：单一写入者互斥、持久身份/空间/对象权限、Worker run-scoped 委托/凭据租约、Gateway 外发授权、控制 profile 引用和旧客户端 Adapter，再进入 SourceRevision/可恢复 Job/家庭知识闭环。禁止用本批业务 token 给 Worker/模型授予 owner 权限。
