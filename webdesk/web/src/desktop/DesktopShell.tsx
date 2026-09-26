import { useEffect, useState } from "react";
import Overview from "../apps/Overview";
import Performance from "../apps/Performance";
import Processes from "../apps/Processes";
import StorageNetwork from "../apps/StorageNetwork";
import SystemInfo from "../apps/SystemInfo";
import {
  api,
  formatDuration,
  type AppList,
  type Series,
  type SessionInfo,
  type Summary,
} from "../api";
import PerformanceWidget from "./PerformanceWidget";

type AppId = "overview" | "performance" | "processes" | "storage" | "system";

const APPS: Array<{ id: AppId; label: string; icon: string; hint: string }> = [
  { id: "overview", label: "概览", icon: "◎", hint: "设备、CPU、内存、磁盘、网络" },
  { id: "performance", label: "性能监控", icon: "↗", hint: "实时趋势与峰值" },
  { id: "processes", label: "进程与占用", icon: "≡", hint: "每应用 / 每进程资源" },
  { id: "storage", label: "存储与网络", icon: "▤", hint: "挂载点与网卡吞吐" },
  { id: "system", label: "审计与关于", icon: "ⓘ", hint: "安全状态与审计日志" },
];

export default function DesktopShell({
  session,
  demo,
  onLogout,
}: {
  session: SessionInfo;
  demo: boolean;
  onLogout: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [apps, setApps] = useState<AppList | null>(null);
  const [windowSize, setWindowSize] = useState(120);
  const [activeApp, setActiveApp] = useState<AppId | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const [nextSummary, nextApps] = await Promise.all([api.summary(), api.apps(24)]);
        if (!active) return;
        setSummary(nextSummary);
        setApps(nextApps);
        setError("");
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await api.series(windowSize);
        if (active) setSeries(next);
      } catch {
        // The next tick retries; the banner already reports connectivity issues.
      }
    };
    void tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [windowSize]);

  const openApp = APPS.find((entry) => entry.id === activeApp);

  return (
    <div className="desktop">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark">D</span>
          <div>
            <b>DepDek Webdesk</b>
            <small>{summary?.host.hostname ?? "连接中"} · {summary?.host.os_name ?? ""}</small>
          </div>
        </div>
        <div className="topbar__status">
          <span className={`dot ${error ? "dot--bad" : "dot--ok"}`} />
          {error ? `连接异常：${error}` : `已连接 · 进程 ${summary?.process_count ?? "--"} · 运行 ${summary ? formatDuration(summary.uptime_secs) : "--"}`}
        </div>
        <div className="topbar__right">
          <span className="chip">v{session.version}</span>
          {demo && <span className="chip chip--warn">浏览器预览</span>}
          {session.insecure_no_auth && <span className="chip chip--danger">无认证</span>}
          <span className="topbar__clock">{clock.toLocaleTimeString("zh-CN", { hour12: false })}</span>
          <button className="ghost" onClick={onLogout}>退出</button>
        </div>
      </header>

      <main className="desktop__body">
        {activeApp && openApp ? (
          <section className="window">
            <header className="window__head">
              <button className="ghost" onClick={() => setActiveApp(null)}>← 返回桌面</button>
              <div className="window__title">
                <b>{openApp.label}</b>
                <small>{openApp.hint}</small>
              </div>
              <span className="chip">{summary?.host.hostname ?? ""}</span>
            </header>
            <div className="window__body">
              {activeApp === "overview" && <Overview summary={summary} series={series} />}
              {activeApp === "performance" && (
                <Performance summary={summary} series={series} windowSize={windowSize} onWindowChange={setWindowSize} />
              )}
              {activeApp === "processes" && <Processes apps={apps} />}
              {activeApp === "storage" && <StorageNetwork summary={summary} />}
              {activeApp === "system" && <SystemInfo session={session} summary={summary} />}
            </div>
          </section>
        ) : (
          <>
            <PerformanceWidget
              summary={summary}
              series={series}
              apps={apps}
              onOpenPerformance={() => setActiveApp("performance")}
              onOpenProcesses={() => setActiveApp("processes")}
            />
            <nav className="launcher">
              {APPS.map((app) => (
                <button key={app.id} className="launcher__item" onClick={() => setActiveApp(app.id)}>
                  <span className="launcher__icon">{app.icon}</span>
                  <b>{app.label}</b>
                  <small>{app.hint}</small>
                </button>
              ))}
            </nav>
          </>
        )}
      </main>

      <footer className="statusbar">
        <span>DepDek AI-OS · webdesk v{session.version}</span>
        <span>数据来自本机 /proc，只读展示</span>
        <span>{session.tls ? "TLS" : "HTTP（局域网）"}</span>
      </footer>
    </div>
  );
}
