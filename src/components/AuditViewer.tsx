import { useEffect, useState } from "react";
import * as api from "../api";

const PAGE = 100;

const formatTime = (ms: number) => new Date(ms).toLocaleString();

export default function AuditViewer() {
  const [entries, setEntries] = useState<api.AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // audit_read returns newest-first; offset paginates into older entries.
  const load = async (offset: number) => {
    try {
      const res = await api.auditRead(offset, PAGE);
      setEntries((prev) => (offset === 0 ? res.entries : [...prev, ...res.entries]));
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    load(0);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    api
      .onAuditEntry((entry) => {
        setEntries((prev) => [entry, ...prev]);
        setTotal((t) => t + 1);
      })
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="audit-viewer">
      <div className="panel-title">
        审计日志
        <button className="link" onClick={() => load(0)}>
          刷新
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="audit-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>session</th>
              <th>op</th>
              <th>path</th>
              <th>结果</th>
              <th>sha256</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.ts_ms}-${i}`} className={e.ok ? "" : "failed"}>
                <td>{formatTime(e.ts_ms)}</td>
                <td>{e.session_id}</td>
                <td>{e.op}</td>
                <td className="path-cell" title={e.path}>
                  {e.path}
                </td>
                <td title={e.error ?? ""}>{e.ok ? "ok" : (e.error ?? "error")}</td>
                <td>{e.sha256 ? e.sha256.slice(0, 8) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length < total && (
        <button className="link" onClick={() => load(entries.length)}>
          加载更多（{entries.length}/{total}）
        </button>
      )}
    </div>
  );
}
