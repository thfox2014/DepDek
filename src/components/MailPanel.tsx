import { useCallback, useEffect, useState } from "react";
import * as api from "../api";

const CONFIG_PATH = "mail/accounts.json";

// "我的邮件" side-menu group: accounts from mail/accounts.json in the vault
// (written by an agent or by hand, contract section 7) shown as a tree —
// account nodes expand to their fetched messages. Fetching is forwarded to
// the sidecar via the mail_fetch command.
export default function MailPanel() {
  const [accounts, setAccounts] = useState<api.MailAccount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // account name or "*" while fetching
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, api.DirEntry[]>>({});
  const [reading, setReading] = useState<{ path: string; content: string } | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const res = await api.vaultReadFile(CONFIG_PATH);
      const parsed = JSON.parse(res.content) as { accounts?: api.MailAccount[] };
      setAccounts(parsed.accounts ?? []);
    } catch (e) {
      // E32002 = not configured yet; anything else is a real error.
      if (String(e).includes("E32002")) {
        setAccounts(null);
      } else {
        setNotice(`读取配置失败：${String(e)}`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const loadMessages = useCallback(async (name: string) => {
    try {
      const { entries } = await api.vaultListDir(`mail/${name}`);
      // File names start with epoch millis, so reverse name order = newest first.
      setMessages((prev) => ({
        ...prev,
        [name]: entries
          .filter((e) => e.kind === "file" && e.name.endsWith(".md"))
          .sort((a, b) => b.name.localeCompare(a.name)),
      }));
    } catch {
      setMessages((prev) => ({ ...prev, [name]: [] }));
    }
  }, []);

  const fetch = async (account?: string) => {
    setBusy(account ?? "*");
    setNotice(null);
    try {
      const result = await api.mailFetch(account);
      const parts = result.accounts.map((a) =>
        a.error ? `${a.name} 失败（${a.error}）` : `${a.name} 收到 ${a.new_messages} 封`,
      );
      setNotice(parts.join("；") || "没有可收取的账号");
      await loadConfig();
      for (const a of result.accounts) {
        if (expanded[a.name]) await loadMessages(a.name);
      }
    } catch (e) {
      setNotice(`收取失败：${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleAccount = async (name: string) => {
    setReading(null);
    if (expanded[name]) {
      setExpanded((prev) => ({ ...prev, [name]: false }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [name]: true }));
    if (!messages[name]) await loadMessages(name);
  };

  const openMessage = async (path: string) => {
    try {
      const res = await api.vaultReadFile(path);
      setReading({ path, content: res.content });
    } catch (e) {
      setNotice(`读取邮件失败：${String(e)}`);
    }
  };

  // "<epoch_ms>-<uid>.md" -> "01-02 13:04 #uid"; falls back to the raw name.
  const messageLabel = (name: string) => {
    const m = /^(\d+)-(\d+)\.md$/.exec(name);
    if (!m) return name;
    const d = new Date(Number(m[1]));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} #${m[2]}`;
  };

  return (
    <div className="mail-panel">
      <div className="mail-panel__actions">
        <button
          className="primary"
          disabled={busy !== null || !accounts || accounts.length === 0}
          onClick={() => fetch()}
        >
          {busy === "*" ? "收取中…" : "收取全部"}
        </button>
      </div>
      {notice && <p className="hint">{notice}</p>}

      <div className="mail-panel__tree">
        {loading ? (
          <p className="hint">加载中…</p>
        ) : !accounts || accounts.length === 0 ? (
          <p className="hint">
            还没有配置邮箱。在对话中告诉 agent
            你的邮箱地址、IMAP 授权码和服务器（如「帮我配置 QQ
            邮箱收邮件」），它会写入 mail/accounts.json。
          </p>
        ) : (
          accounts.map((a) => (
            <div key={a.name}>
              <div className="tree-row dir" onClick={() => toggleAccount(a.name)}>
                <span className="tree-icon">{expanded[a.name] ? "▾" : "▸"}</span>
                <span className="tree-name">{a.name}</span>
                <span className="mail-panel__account-user">{a.user}</span>
                <button
                  className="mail-panel__fetch"
                  disabled={busy !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    fetch(a.name);
                  }}
                >
                  {busy === a.name ? "…" : "收取"}
                </button>
              </div>
              {expanded[a.name] &&
                (messages[a.name] ? (
                  messages[a.name].length === 0 ? (
                    <div className="tree-row file" style={{ paddingLeft: 22 }}>
                      <span className="hint">暂无邮件</span>
                    </div>
                  ) : (
                    messages[a.name].map((m) => (
                      <div
                        key={m.name}
                        className="tree-row file"
                        style={{ paddingLeft: 22 }}
                        onClick={() => openMessage(`mail/${a.name}/${m.name}`)}
                        title={m.name}
                      >
                        <span className="tree-icon">·</span>
                        <span className="tree-name">{messageLabel(m.name)}</span>
                      </div>
                    ))
                  )
                ) : (
                  <div className="tree-row file" style={{ paddingLeft: 22 }}>
                    <span className="hint">加载中…</span>
                  </div>
                ))}
            </div>
          ))
        )}
      </div>

      {reading && (
        <div className="file-preview">
          <div className="preview-header">
            <span className="preview-path" title={reading.path}>
              {reading.path}
            </span>
            <button onClick={() => setReading(null)}>×</button>
          </div>
          <pre>{reading.content}</pre>
        </div>
      )}
    </div>
  );
}
