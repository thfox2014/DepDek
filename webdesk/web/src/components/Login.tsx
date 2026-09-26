import { useState, type FormEvent } from "react";

interface LoginProps {
  version: string;
  insecure: boolean;
  tls: boolean;
  demo: boolean;
  onAuthenticated: () => void;
  onLogin: (password: string) => Promise<void>;
}

export default function Login({ version, insecure, tls, demo, onAuthenticated, onLogin }: LoginProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(password);
      onAuthenticated();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__brand">
          <span className="login__mark">D</span>
          <div>
            <b>DepDek Webdesk</b>
            <small>远程管理控制台 · v{version}</small>
          </div>
        </div>

        {demo && <p className="login__demo">浏览器预览模式：不会真正登录，展示的是示例数据。</p>}

        <label className="login__field">
          <span>管理员密码</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            placeholder={demo ? "预览模式可直接进入" : "请输入 webdesk.toml 中配置的密码"}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error && <p className="login__error">{error}</p>}

        <button className="login__submit" type="submit" disabled={busy || (!demo && password.length === 0)}>
          {busy ? "正在登录…" : "进入控制台"}
        </button>

        <ul className="login__notes">
          <li>会话使用 HttpOnly + SameSite=Strict Cookie，支持绝对与空闲超时</li>
          <li>连续失败会按来源地址指数退避，所有登录尝试写入审计日志</li>
          <li className={tls ? "ok" : "warn"}>
            {tls ? "已启用 TLS 证书配置" : "当前为 HTTP：请仅在可信局域网使用，或在前端加反向代理终止 TLS"}
          </li>
          {insecure && <li className="danger">服务端以 --insecure-no-auth 启动：任何能访问该端口的人都能看到全部数据</li>}
        </ul>
      </form>
      <p className="login__foot">DepDek AI-OS · 本机数据优先 · 所有管理操作均记录审计</p>
    </div>
  );
}
