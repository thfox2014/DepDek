import { Bug, ClipboardText, DownloadSimple, Trash, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { captureDebugError, clearDebugErrors, isDebugCaptureEnabled, readDebugErrors, setDebugCaptureEnabled, type DebugErrorEntry } from "../lib/debugCapture";
import "./debug-capture.css";

export function DebugCaptureControls() {
  const [enabled, setEnabled] = useState(isDebugCaptureEnabled);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DebugErrorEntry[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const sync = () => setEnabled(isDebugCaptureEnabled());
    window.addEventListener("jiaho-debug-capture-changed", sync);
    return () => window.removeEventListener("jiaho-debug-capture-changed", sync);
  }, []);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setEntries(readDebugErrors());
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("jiaho-debug-capture-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("jiaho-debug-capture-changed", refresh);
    };
  }, [open]);

  const toggle = () => {
    const next = !enabled;
    setDebugCaptureEnabled(next);
    setEnabled(next);
    setNotice(next ? "调试日志已开启，仅保存在本机。" : "调试日志已关闭。既有日志不会自动删除。");
  };
  const exportLogs = () => {
    const blob = new Blob([JSON.stringify({ app: "Jiaho AI-OS", exportedAt: new Date().toISOString(), entries }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `jiaho-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; link.click();
    URL.revokeObjectURL(url);
    setNotice("诊断日志已导出到下载目录。");
  };
  const copyLogs = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(entries, null, 2)); setNotice("诊断日志已复制。"); }
    catch { setNotice("无法访问剪贴板，请改用“导出日志”。"); }
  };
  const clearLogs = () => { clearDebugErrors(); setEntries([]); setNotice("本机诊断日志已清除。"); };

  return <>
    <div className="jiaho-debug-control">
      <button type="button" aria-pressed={enabled} aria-label={`调试日志${enabled ? "已开启" : "已关闭"}`} title={`调试日志${enabled ? "已开启" : "已关闭"} · 点击查看或切换`} onClick={() => setOpen(true)}>
        <Bug size={17} /><span>调试日志</span><i className={enabled ? "is-on" : ""} />
      </button>
    </div>
    {open && <div className="jiaho-debug-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="jiaho-debug-dialog" role="dialog" aria-modal="true" aria-label="本机调试日志">
        <header><div><small>本机诊断</small><h2>调试日志</h2></div><button aria-label="关闭" onClick={() => setOpen(false)}><X size={19} /></button></header>
        <p>只记录前端异常和本机功能错误，不上传。最多保留最近 30 条。</p>
        <button className="jiaho-debug-toggle" role="switch" aria-checked={enabled} onClick={toggle}><span><b>捕获错误</b><small>{enabled ? "开启中 · 仅保存到本机" : "已关闭"}</small></span><i className={enabled ? "is-on" : ""}><em /></i></button>
        <div className="jiaho-debug-list" aria-live="polite">
          {entries.length ? entries.slice().reverse().map((entry) => <article key={entry.id}><time>{new Date(entry.time).toLocaleString()}</time><b>{entry.source}</b><p>{entry.message}</p>{entry.stack && <details><summary>调用栈</summary><pre>{entry.stack}</pre></details>}</article>) : <div className="jiaho-debug-empty">还没有记录。开启后，重试刚才出错的操作。</div>}
        </div>
        {notice && <div className="jiaho-debug-notice" role="status">{notice}</div>}
        <footer><button onClick={clearLogs} disabled={!entries.length}><Trash size={15} />清除</button><button onClick={() => void copyLogs()} disabled={!entries.length}><ClipboardText size={15} />复制</button><button className="is-primary" onClick={exportLogs} disabled={!entries.length}><DownloadSimple size={15} />导出日志</button></footer>
      </section>
    </div>}
  </>;
}

export function RootErrorFallback({ error, componentStack, onRetry }: { error: Error; componentStack: string; onRetry: () => void }) {
  const [enabled, setEnabled] = useState(isDebugCaptureEnabled);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const report = `${new Date().toISOString()}\n${error.name}: ${error.message}\n${error.stack ?? ""}\nReact component stack:\n${componentStack}`;
  const toggle = () => {
    const next = !enabled;
    setDebugCaptureEnabled(next); setEnabled(next);
    if (next) captureDebugError("react.render", error, `${error.stack ?? ""}\n${componentStack}`);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopied(true); } catch { setShowDetails(true); }
  };
  return <main className="jiaho-crash-screen" data-debug-enabled={enabled}>
    <section className="jiaho-crash-card">
      <div className="jiaho-crash-brand"><span>家合</span><small>家庭 AI 中心</small></div>
      <div className="jiaho-crash-mark"><Bug size={23} /></div>
      <p className="jiaho-crash-eyebrow">先别担心，资料仍在本机</p>
      <h1>刚才这一步没有打开。</h1>
      <p className="jiaho-crash-copy">界面遇到一个错误，已停止继续渲染。你的原始照片和资料没有被修改。</p>
      <div className="jiaho-crash-actions"><button className="is-primary" onClick={onRetry}>重新打开</button><button onClick={toggle} aria-pressed={enabled}>调试日志{enabled ? "已开启" : "已关闭"}</button><button onClick={() => void copy()}>{copied ? "已复制" : "复制错误信息"}</button></div>
      {showDetails && <details className="jiaho-crash-details" open><summary>错误详情</summary><pre>{report}</pre></details>}
      <small className="jiaho-crash-footnote">错误日志仅保存在这台设备；不含照片原件，也不会上传。</small>
    </section>
  </main>;
}
