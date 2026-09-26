import { useEffect, useState } from "react";
import { api, formatDuration, type AuditTail, type SessionInfo, type Summary } from "../api";

export default function SystemInfo({ session, summary }: { session: SessionInfo; summary: Summary | null }) {
  const [audit, setAudit] = useState<AuditTail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api
      .audit(50)
      .then((next) => active && setAudit(next))
      .catch((loadError) => active && setError(loadError instanceof Error ? loadError.message : String(loadError)));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="grid">
      <section className="card">
        <header className="card__head"><h3>关于</h3><span className="chip">v{session.version}</span></header>
        <div className="facts">
          <div><span>控制台</span><b>depdek-webdesk v{session.version}</b></div>
          <div><span>登录用户</span><b>{session.user ?? "—"}</b></div>
          <div><span>服务时长</span><b>{summary ? formatDuration(summary.uptime_secs) : "—"}</b></div>
          <div><span>采样点</span><b>{summary?.sample_count ?? 0}</b></div>
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>安全状态</h3></header>
        <ul className="checks">
          <li className={session.insecure_no_auth ? "danger" : "ok"}>
            {session.insecure_no_auth ? "认证已关闭（--insecure-no-auth）" : "密码登录 + Argon2id 哈希"}
          </li>
          <li className="ok">会话 Cookie：HttpOnly · SameSite=Strict · 空闲超时 {Math.round(session.session_ttl_secs / 3600)} 小时</li>
          <li className="ok">写操作需要 CSRF 令牌，登录失败按来源地址指数退避</li>
          <li className={session.tls ? "ok" : "warn"}>
            {session.tls ? "已配置 TLS 证书" : "HTTP 明文传输：仅建议可信局域网，或用 nginx/caddy 反向代理终止 TLS"}
          </li>
          <li className="ok">管理动作写入 append-only 审计日志（webdesk-audit.jsonl）</li>
          <li className="ok">不提供 shell / 任意文件读写；后续能力需逐项确认并审计</li>
        </ul>
      </section>

      <section className="card card--wide">
        <header className="card__head">
          <h3>审计日志</h3>
          <span className="muted mono ellipsis">{audit?.path ?? "—"}</span>
        </header>
        {error && <p className="error">{error}</p>}
        <table className="table table--dense">
          <thead>
            <tr><th>时间</th><th>动作</th><th>主体</th><th>来源</th><th>结果</th><th>详情</th></tr>
          </thead>
          <tbody>
            {(audit?.entries ?? []).slice().reverse().map((entry, index) => (
              <tr key={`${entry.ts}-${index}`}>
                <td className="mono">{entry.ts.replace("T", " ").slice(0, 19)}</td>
                <td>{entry.action}</td>
                <td>{entry.actor}</td>
                <td className="mono">{entry.ip}</td>
                <td className={entry.ok ? "ok" : "danger"}>{entry.ok ? "成功" : "失败"}</td>
                <td className="mono ellipsis">{JSON.stringify(entry.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(audit?.entries.length ?? 0) === 0 && <p className="muted">暂无审计记录</p>}
      </section>
    </div>
  );
}
