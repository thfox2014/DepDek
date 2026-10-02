import { useEffect, useRef, useState, type CSSProperties } from "react";
import Overview from "../apps/Overview";
import Performance from "../apps/Performance";
import Processes from "../apps/Processes";
import StorageNetwork from "../apps/StorageNetwork";
import Files from "../apps/Files";
import SystemInfo from "../apps/SystemInfo";
import Agent from "../apps/Agent";
import AppArtwork, { type AppArtworkKind } from "../components/AppArtwork";
import {
  api,
  type AppList,
  type Series,
  type SessionInfo,
  type Summary,
} from "../api";
import FloatingWindow from "./FloatingWindow";
import PerformanceWidget from "./PerformanceWidget";

type AppId = "agent" | "overview" | "performance" | "processes" | "storage" | "files" | "system";
interface AppWindowState { id: AppId; maximized: boolean }

const APPS: Array<{ id: AppId; label: string; icon: AppArtworkKind; hint: string; tint: string }> = [
  { id: "agent", label: "Agent Team", icon: "agent", hint: "西游协作室 · 四位伙伴", tint: "amber" },
  { id: "overview", label: "设备概览", icon: "overview", hint: "设备与系统状态", tint: "mint" },
  { id: "performance", label: "性能监控", icon: "performance", hint: "实时资源趋势", tint: "blue" },
  { id: "processes", label: "应用与进程", icon: "processes", hint: "资源占用排行", tint: "violet" },
  { id: "storage", label: "存储空间", icon: "storage", hint: "卷容量、使用情况与网络", tint: "amber" },
  { id: "files", label: "文件管理", icon: "files", hint: "浏览、预览与下载文件", tint: "blue" },
  { id: "system", label: "系统信息", icon: "system", hint: "审计状态与关于", tint: "slate" },
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
  const brandMenuRef = useRef<HTMLDivElement>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryRefresh, setSummaryRefresh] = useState(0);
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
  const [series, setSeries] = useState<Series | null>(null);
  const [apps, setApps] = useState<AppList | null>(null);
  const [windowSize, setWindowSize] = useState(120);
  const [appWindows, setAppWindows] = useState<AppWindowState[]>([]);
  const [minimizedApps, setMinimizedApps] = useState<AppId[]>([]);
  const [performanceVisible, setPerformanceVisible] = useState(true);
  const [performanceMaximized, setPerformanceMaximized] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(() => new Date());
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [dockRevealed, setDockRevealed] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!brandMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!brandMenuRef.current?.contains(event.target as Node)) setBrandMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBrandMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [brandMenuOpen]);

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

  const visibleWindows = appWindows.filter((entry) => !minimizedApps.includes(entry.id));
  const activeApp = visibleWindows.at(-1)?.id ?? null;
  const activeWindow = visibleWindows.at(-1);
  const agentImmersive = activeWindow?.id === "agent" && activeWindow.maximized;
  useEffect(() => {
    if (!agentImmersive) setDockRevealed(false);
  }, [agentImmersive]);
  const performanceMiniVisible = performanceVisible && !visibleWindows.some((entry) => entry.id === "performance");
  const networkActivity = summary?.networks.reduce(
    (total, network) => total + network.rx_bytes_per_sec + network.tx_bytes_per_sec,
    0,
  ) ?? 0;
  const open = (app: AppId) => {
    setAppWindows((current) => {
      const existing = current.find((entry) => entry.id === app);
      const ordered = current.filter((entry) => entry.id !== app);
      return [...ordered, existing ?? { id: app, maximized: app === "agent" }];
    });
    setMinimizedApps((current) => current.filter((entry) => entry !== app));
  };
  const minimize = (app: AppId) => setMinimizedApps((current) => current.includes(app) ? current : [...current, app]);
  const close = (app: AppId) => {
    setAppWindows((current) => current.filter((entry) => entry.id !== app));
    setMinimizedApps((current) => current.filter((entry) => entry !== app));
  };
  const toggleMaximize = (app: AppId) => setAppWindows((current) => current.map((entry) => entry.id === app ? { ...entry, maximized: !entry.maximized } : entry));
  const focus = (app: AppId) => setAppWindows((current) => [...current.filter((entry) => entry.id !== app), ...current.filter((entry) => entry.id === app)]);

  return (
    <div className={`desktop ${agentImmersive ? "desktop--agent-immersive" : ""} ${dockRevealed ? "dock-is-revealed" : ""}`}>
      <header className="topbar">
        <div className="topbar__brand-wrap" ref={brandMenuRef}>
          <button
            className="topbar__brand"
            aria-label="打开 DepDek 菜单"
            aria-haspopup="menu"
            aria-expanded={brandMenuOpen}
            onClick={() => setBrandMenuOpen((isOpen) => !isOpen)}
          >
            <span className="topbar__mark">D</span>
            <b>DepDek</b>
            <span className="topbar__brand-chevron" aria-hidden="true">⌄</span>
          </button>
          {brandMenuOpen && (
            <div className="topbar__menu" role="menu" aria-label="DepDek 菜单">
              <div className="topbar__menu-heading">
                <b>DepDek AgentOS</b>
                <small>{summary?.host.hostname ?? "本机桌面"} · v{session.version}</small>
              </div>
              <button role="menuitem" onClick={() => { setBrandMenuOpen(false); open("overview"); }}>
                <span className="topbar__menu-glyph">⌂</span>设备概览
              </button>
              <button role="menuitem" onClick={() => { setBrandMenuOpen(false); open("system"); }}>
                <span className="topbar__menu-glyph">⚙</span>系统信息
              </button>
              <div className="topbar__menu-separator" />
              <button className="topbar__menu-logout" role="menuitem" onClick={() => { setBrandMenuOpen(false); onLogout(); }}>
                <span className="topbar__menu-glyph">↪</span>退出
              </button>
            </div>
          )}
        </div>
        <div className="topbar__host">
          <span className={`dot ${error ? "dot--bad" : "dot--ok"}`} />
          <div><b>{summary?.host.hostname ?? "正在连接设备"}</b><small>{summary?.host.os_name ?? "本地系统管理"} · {summary ? `${summary.process_count} 个进程` : "等待指标"}</small></div>
        </div>
        <div className="topbar__right">
          {demo && <span className="chip chip--warn">预览模式</span>}
          {session.insecure_no_auth && <span className="chip chip--danger">无认证</span>}
          <span className="topbar__clock" aria-label={`时间 ${clock.toLocaleTimeString("zh-CN", { hour12: false })}`}>
            <b>{clock.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</b>
            <small>{clock.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}</small>
          </span>
          <button className="topbar__control" title="打开存储与网络" aria-label={`网络${networkActivity > 0 ? "活动中" : "状态"}`} onClick={() => open("storage")}>
            <NetworkGlyph active={networkActivity > 0} />
            <span>网络</span>
          </button>
          <button className="topbar__control" title="设置与系统信息" aria-label="打开设置" onClick={() => open("system")}>
            <SettingsGlyph />
            <span>设置</span>
          </button>
        </div>
      </header>

      <main ref={stageRef} className="desktop__body">
        <div className="desktop__wallpaper" aria-hidden="true"><i /><i /><i /></div>
        <div className="desktop__caption"><span>我的设备</span><small>常用应用</small></div>
        <nav className="desktop__shortcuts" aria-label="桌面应用">
          {APPS.map((app) => (
            <button key={app.id} className={`desktop-icon desktop-icon--${app.tint}`} onDoubleClick={() => open(app.id)} onClick={() => open(app.id)}>
              <span className="desktop-icon__image"><AppArtwork kind={app.icon} /></span>
              <span className="desktop-icon__label">{app.label}</span>
            </button>
          ))}
        </nav>

        {visibleWindows.map((appWindow, index) => {
          const app = APPS.find((entry) => entry.id === appWindow.id)!;
          return (
            <section
              key={appWindow.id}
              className={`window window--open ${appWindow.id === "agent" ? "window--agent" : ""} ${appWindow.maximized ? "window--maximized" : ""} ${activeApp === appWindow.id ? "window--focused" : ""}`}
              aria-label={app.label}
              style={{ "--window-cascade": `${Math.min(index * 28, 84)}px`, top: `${22 + Math.min(index * 22, 88)}px`, zIndex: 5 + index } as CSSProperties}
              onPointerDown={() => focus(appWindow.id)}
            >
              <header className="window__head">
                <div className="window__app-icon"><AppArtwork kind={app.icon} /></div>
                <div className="window__title"><b>{app.label}</b><small>{app.hint}</small></div>
                <span className="window__host">{summary?.host.hostname ?? "DepDek Webdesk"}</span>
                <div className="window__controls">
                  <button aria-label="最小化窗口" title="最小化" onClick={() => minimize(appWindow.id)}>−</button>
                  <button aria-label={appWindow.maximized ? "还原窗口" : "最大化窗口"} title={appWindow.maximized ? "还原" : "最大化"} onClick={() => toggleMaximize(appWindow.id)}>{appWindow.maximized ? "❐" : "□"}</button>
                  <button className="window__close" aria-label="关闭窗口" title="关闭" onClick={() => close(appWindow.id)}>×</button>
                </div>
              </header>
              <div className="window__body">
                {appWindow.id === "overview" && <Overview summary={summary} series={series} />}
                {appWindow.id === "performance" && <Performance summary={summary} series={series} windowSize={windowSize} onWindowChange={setWindowSize} />}
                {appWindow.id === "processes" && <Processes apps={apps} />}
                {appWindow.id === "storage" && <StorageNetwork summary={summary} onRefresh={() => { setSummaryRefreshing(true); setSummaryRefresh((value) => value + 1); }} refreshing={summaryRefreshing} />}
                {appWindow.id === "files" && <Files />}
                {appWindow.id === "system" && <SystemInfo session={session} summary={summary} />}
                {appWindow.id === "agent" && <Agent />}
              </div>
            </section>
          );
        })}

        {agentImmersive && <div className="immersive-window-controls" role="group" aria-label="全屏窗口控制">
          <button title="最小化 Agent 窗口" aria-label="最小化 Agent 窗口" onClick={() => minimize("agent")}>−</button>
          <button title="还原 Agent 窗口" aria-label="还原 Agent 窗口" onClick={() => toggleMaximize("agent")}>↙</button>
        </div>}

        {performanceMiniVisible && (
          <FloatingWindow stageRef={stageRef} storageKey="webdesk.performance-window.v2" className={`floating-window--performance ${performanceMaximized ? "floating-window--maximized" : ""}`}>
            {(dragHandleProps) => (
              <PerformanceWidget
                summary={summary}
                series={series}
                apps={apps}
                dragHandleProps={dragHandleProps}
                onMinimize={() => setPerformanceVisible(false)}
                onClose={() => setPerformanceVisible(false)}
                maximized={performanceMaximized}
                onToggleMaximize={() => setPerformanceMaximized((value) => !value)}
              />
            )}
          </FloatingWindow>
        )}

        <div
          className={`dock-reveal-zone ${dockRevealed ? "is-revealed" : ""}`}
          onMouseEnter={() => { if (agentImmersive) setDockRevealed(true); }}
          onMouseLeave={() => { if (agentImmersive) setDockRevealed(false); }}
          onFocusCapture={() => { if (agentImmersive) setDockRevealed(true); }}
          onBlurCapture={(event) => {
            if (agentImmersive && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDockRevealed(false);
          }}
        >
        <button className="dock-reveal-zone__trigger" aria-label="显示应用程序坞" tabIndex={agentImmersive ? 0 : -1} onClick={() => setDockRevealed((value) => !value)} />
        <nav className="dock" aria-label="应用程序坞">
          <button className="dock__home" title="桌面" aria-label="最小化所有应用窗口" onClick={() => setMinimizedApps(appWindows.map((entry) => entry.id))}>⌂</button>
          <span className="dock__divider" />
          {APPS.map((app) => (
            <button key={app.id} className={`dock__app ${appWindows.some((entry) => entry.id === app.id && !minimizedApps.includes(app.id)) ? "dock__app--active" : ""} ${minimizedApps.includes(app.id) ? "dock__app--minimized" : ""}`} title={minimizedApps.includes(app.id) ? `恢复${app.label}` : app.label} aria-label={minimizedApps.includes(app.id) ? `恢复${app.label}` : app.label} onClick={() => open(app.id)}>
              <span className="dock__icon"><AppArtwork kind={app.icon} /></span>
              <i />
            </button>
          ))}
          <span className="dock__divider" />
          <button className={`dock__app dock__app--monitor ${performanceMiniVisible || appWindows.some((entry) => entry.id === "performance") ? "dock__app--active" : ""}`} title={performanceMiniVisible ? "性能窗口已显示" : "显示性能窗口"} aria-label={performanceMiniVisible ? "性能窗口已显示" : "显示性能窗口"} onClick={() => { setPerformanceVisible(true); setPerformanceMaximized(false); if (appWindows.some((entry) => entry.id === "performance")) open("performance"); }}>
            <span className="dock__monitor"><i /><i /><i /></span><i />
          </button>
          <div className="dock__system"><span className={`dock__connection ${error ? "dock__connection--bad" : ""}`} /><span>{error ? "设备离线" : "本机在线"}</span><span>{session.tls ? "TLS" : "局域网"}</span></div>
        </nav>
        </div>
      </main>

      <footer className="statusbar">
        <span>DepDek Webdesk <i>·</i> v{session.version}</span>
        <span>{error ? `连接异常：${error}` : "系统指标只读采集自本机"}</span>
        <span>快捷访问 <kbd>Alt</kbd> + <kbd>方向键</kbd> 移动性能窗口</span>
      </footer>
    </div>
  );
}

function NetworkGlyph({ active }: { active: boolean }) {
  return (
    <svg className={`topbar__glyph ${active ? "topbar__glyph--active" : ""}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2.5 7.1a11.3 11.3 0 0 1 15 0M5.2 9.9a7.2 7.2 0 0 1 9.6 0M7.9 12.7a3.2 3.2 0 0 1 4.2 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="10" cy="15.8" r="1.15" fill="currentColor" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg className="topbar__glyph" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M8.4 2.5h3.2l.5 1.8c.5.2 1 .4 1.4.8l1.8-.6 1.6 2.8-1.3 1.3c.1.5.1 1.1 0 1.6l1.3 1.3-1.6 2.8-1.8-.6c-.4.3-.9.6-1.4.8l-.5 1.8H8.4l-.5-1.8a6 6 0 0 1-1.4-.8l-1.8.6-1.6-2.8 1.3-1.3a6 6 0 0 1 0-1.6L3.1 7.3l1.6-2.8 1.8.6c.4-.4.9-.6 1.4-.8l.5-1.8Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <circle cx="10" cy="9.5" r="2.35" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}
