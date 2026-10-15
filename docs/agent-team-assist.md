# Agent 团队助手（审批、MCP、例程）

这一步让团队更接近一个可管理的本地助手：外部动作要人点头，连接器只走用户配置的 HTTP MCP，例程可以定时或跟着邮件/待办跑。它仍然不提供 shell，也不让 Agent 自己选审计 session。

契约见 `docs/contract.md` 的 2.12、2.13、2.14，以及 2.11 里补上的持久化和委托策略。

## MCP

连接器是 `{id, label, url, auth}`，存在 `mcp/connectors.json`。客户端只发 HTTP JSON-RPC。`mcp.md` 里形如 `notes/search` 的行才是授权，别的文字仍然只是说明。令牌进现有的加密凭据（scope `mcp`），界面只知道有没有，不知道内容。OAuth 在 401 时用 refresh token 换一次新的 access token。

每次 `tools/call` 先对授权，再弹出审批卡，然后才出网，并用 `mcp/audit` 记一条逻辑审计。

## 审批与发信

`write_file`、`delete_file`、`compress`、`fetch_mail` 和 MCP 调用会停在审批卡上。`draft_email` 只落草稿；用户在卡片上选择「批准并发送」之后，才走原来的 SMTP `mail/send`。拒绝、过期或发送失败都不会被说成已经发出。

## 例程

五段 cron 用本机时区。新邮件来自 `mail/fetch` 的新邮件计数，新待办来自 TodoBus 的入队事件。目标 Agent 必须已经在线，例程不会偷偷创建会话，也不能跳过审批。

## 委托

`team/tasks.json` 在每次状态变化后写回。策略文件默认允许，以便已有团队不用先写规则；改成 `deny` 后，只有显式允许的 from/to 才能委托或发消息。
