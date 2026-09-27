import { useEffect, useRef, useState } from "react";
import Overview from "../apps/Overview";
import Performance from "../apps/Performance";
import Processes from "../apps/Processes";
import StorageNetwork from "../apps/StorageNetwork";
import SystemInfo from "../apps/SystemInfo";
import {
  api,
  type AppList,
  type Series,
  type SessionInfo,
  type Summary,
} from "../api";
import FloatingWindow from "./FloatingWindow";
import PerformanceWidget from "./PerformanceWidget";

type AppId = "overview" | "performance" | "processes" | "storage" | "system";

const APPS: Array<{ id: AppId; label: string; icon: string; hint: string; tint: string }> = [
  { id: "overview", label: "设备概览", icon: "⌂", hint: "设备与系统状态", tint: "mint" },
  { id: "performance", label: "性能监控", icon: "⌁", hint: "实时资源趋势", tint: "blue" },
  { id: "processes", label: "应用与进程", icon: "≋", hint: "资源占用排行", tint: "violet" },
  { id: "storage", label: "存储空间", icon: "▧", hint: "卷容量、使用情况与网络", tint: "amber" },
  { id: "system", label: "系统信息", icon: "ⓘ", hint: "审计状态与关于", tint: "slate" },
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
  const stageRef = useRef<HTMLElement>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryRefresh, setSummaryRefresh] = useState(0);
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
  const [series, setSeries] = useState<Series | null>(null);
  const [apps, setApps] = useState<AppList | null>(null);
  const [windowSize, setWindowSize] = useState(120);
  const [activeApp, setActiveApp] = useState<AppId | null>(null);
  const [performanceVisible, setPerformanceVisible] = useState(true);
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
      } finally {
        if (active) setSummaryRefreshing(false);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [summaryRefresh]);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await api.series(windowSize);
        if (active) setSeries(next);
      } catch {
        // The next tick retries; the connection state stays visible in the top bar.
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
  const performanceMiniVisible = performanceVisible && activeApp !== "performance";
  const open = (app: AppId) => setActiveApp((current) => current === app ? null : app);

  return (
    <div className="desktop">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark">D</span>
          <div><b>DepDek</b><small>AgentOS · Webdesk</small></div>
        </div>
        <div className="topbar__host">
          <span className={`dot ${error ? "dot--bad" : "dot--ok"}`} />
          <div><b>{summary?.host.hostname ?? "正在连接设备"}</b><small>{summary?.host.os_name ?? "本地系统管理"} · {summary ? `${summary.process_count} 个进程` : "等待指标"}</small></div>
        </div>
        <div className="topbar__right">
          {demo && <span className="chip chip--warn">预览模式</span>}
          {session.insecure_no_auth && <span className="chip chip--danger">无认证</span>}
          <span className="topbar__clock"><b>{clock.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</b><small>{clock.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}</small></span>
          <button className="topbar__logout" onClick={onLogout}>退出</button>
        </div>
      </header>

      <main ref={stageRef} className="desktop__body">
        <div className="desktop__wallpaper" aria-hidden="true"><i /><i /><i /></div>
        <div className="desktop__caption"><span>我的设备</span><small>常用应用</small></div>
        <nav className="desktop__shortcuts" aria-label="桌面应用">
          {APPS.map((app) => (
            <button key={app.id} className={`desktop-icon desktop-icon--${app.tint}`} onDoubleClick={() => setActiveApp(app.id)} onClick={() => setActiveApp(app.id)}>
              <span className="desktop-icon__image">{app.icon}</span>
              <span className="desktop-icon__label">{app.label}</span>
            </button>
          ))}
        </nav>

        {openApp && (
          <section className="window window--open" aria-label={openApp.label}>
            <header className="window__head">
              <div className={`window__app-icon window__app-icon--${openApp.tint}`}>{openApp.icon}</div>
              <div className="window__title"><b>{openApp.label}</b><small>{openApp.hint}</small></div>
              <span className="window__host">{summary?.host.hostname ?? "DepDek Webdesk"}</span>
              <div className="window__controls">
                <button aria-label="最小化到桌面" title="最小化" onClick={() => setActiveApp(null)}>−</button>
                <button className="window__close" aria-label="关闭窗口" title="关闭" onClick={() => setActiveApp(null)}>×</button>
              </div>
            </header>
            <div className="window__body">
              {activeApp === "overview" && <Overview summary={summary} series={series} />}
              {activeApp === "performance" && (
                <Performance summary={summary} series={series} windowSize={windowSize} onWindowChange={setWindowSize} />
              )}
              {activeApp === "processes" && <Processes apps={apps} />}
              {activeApp === "storage" && <StorageNetwork summary={summary} onRefresh={() => { setSummaryRefreshing(true); setSummaryRefresh((value) => value + 1); }} refreshing={summaryRefreshing} />}
              {activeApp === "system" && <SystemInfo session={session} summary={summary} />}
            </div>
          </section>
        )}

        {performanceMiniVisible && (
          <FloatingWindow stageRef={stageRef} storageKey="webdesk.performance-window.v2" className="floating-window--performance">
            {(dragHandleProps) => (
              <PerformanceWidget
                summary={summary}
                series={series}
                apps={apps}
                dragHandleProps={dragHandleProps}
                onMinimize={() => setPerformanceVisible(false)}
                onOpenPerformance={() => setActiveApp("performance")}
                onOpenProcesses={() => setActiveApp("processes")}
              />
            )}
          </FloatingWindow>
        )}

        <nav className="dock" aria-label="应用程序坞">
          <button className="dock__home" title="桌面" aria-label="返回桌面" onClick={() => setActiveApp(null)}>⌂</button>
          <span className="dock__divider" />
          {APPS.map((app) => (
            <button key={app.id} className={`dock__app ${activeApp === app.id ? "dock__app--active" : ""}`} title={app.label} aria-label={app.label} onClick={() => open(app.id)}>
              <span className={`dock__icon dock__icon--${app.tint}`}>{app.icon}</span>
              <i />
            </button>
          ))}
          <span className="dock__divider" />
          <button className={`dock__app dock__app--monitor ${performanceMiniVisible || activeApp === "performance" ? "dock__app--active" : ""}`} title={performanceMiniVisible ? "性能窗口已显示" : "显示性能窗口"} aria-label={performanceMiniVisible ? "性能窗口已显示" : "显示性能窗口"} onClick={() => { setPerformanceVisible(true); if (activeApp === "performance") setActiveApp(null); }}>
            <span className="dock__monitor"><i /><i /><i /></span><i />
          </button>
          <div className="dock__system"><span className={`dock__connection ${error ? "dock__connection--bad" : ""}`} /><span>{error ? "设备离线" : "本机在线"}</span><span>{session.tls ? "TLS" : "局域网"}</span></div>
        </nav>
      </main>

      <footer className="statusbar">
        <span>DepDek Webdesk <i>·</i> v{session.version}</span>
        <span>{error ? `连接异常：${error}` : "系统指标只读采集自本机"}</span>
        <span>快捷访问 <kbd>Alt</kbd> + <kbd>方向键</kbd> 移动性能窗口</span>
      </footer>
    </div>
  );
}
