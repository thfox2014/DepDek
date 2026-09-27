import { Meter, Sparkline, toneFor } from "../components/charts";
import { formatBytes, formatRate, type AppList, type Series, type Summary } from "../api";
import type { DragHandleProps } from "./FloatingWindow";

interface Props {
  summary: Summary | null;
  series: Series | null;
  apps: AppList | null;
  dragHandleProps: DragHandleProps;
  onMinimize: () => void;
  onOpenPerformance: () => void;
  onOpenProcesses: () => void;
}

/** Compact, live desktop window for the read-only machine resource snapshot. */
export default function PerformanceWidget({
  summary,
  series,
  apps,
  dragHandleProps,
  onMinimize,
  onOpenPerformance,
  onOpenProcesses,
}: Props) {
  const samples = series?.samples ?? [];
  const cpuHistory = samples.map((sample) => sample.cpu_pct);
  const latest = samples[samples.length - 1];
  const cpu = summary?.cpu.usage_pct ?? latest?.cpu_pct ?? 0;
  const memory = summary?.memory.used_pct ?? latest?.mem_pct ?? 0;
  const topApps = (apps?.apps ?? summary?.apps ?? []).slice(0, 3);
  const cores = summary?.cpu.per_core ?? [];

  return (
    <section className="widget widget--performance" aria-label="系统性能监控">
      <header className="widget__head">
        <div className="widget__drag-handle" {...dragHandleProps}>
          <span className="widget__mark" aria-hidden="true">⌁</span>
          <div className="widget__title">
            <h2>性能概览</h2>
            <small><i className={`dot ${summary ? "dot--ok" : "dot--bad"}`} />{summary ? `${summary.host.hostname} · ${summary.host.cores_logical} 线程` : "正在连接本机…"}</small>
          </div>
        </div>
        <div className="widget__actions">
          <button className="widget__icon-button" title="查看进程" aria-label="查看进程与占用" onClick={onOpenProcesses}>≋</button>
          <button className="widget__icon-button" title="收起窗口" aria-label="收起性能监控" onClick={onMinimize}>−</button>
          <button className="widget__icon-button widget__icon-button--accent" title="打开完整监控" aria-label="打开完整性能监控" onClick={onOpenPerformance}>↗</button>
        </div>
      </header>

      <div className="widget__metric-grid">
        <article className="widget__metric">
          <div><span>处理器</span><b className={`metric-value ${toneFor(cpu)}`}>{cpu.toFixed(0)}<small>%</small></b></div>
          <Meter value={cpu} tone={toneFor(cpu)} />
          <small>1 分钟负载 {summary?.cpu.load1.toFixed(2) ?? "--"}</small>
        </article>
        <article className="widget__metric">
          <div><span>内存</span><b className={`metric-value ${toneFor(memory)}`}>{memory.toFixed(0)}<small>%</small></b></div>
          <Meter value={memory} tone={toneFor(memory)} />
          <small>{formatBytes(summary?.memory.used_bytes ?? 0)} / {formatBytes(summary?.memory.total_bytes ?? 0)}</small>
        </article>
      </div>

      <section className="widget__chart" aria-label="CPU 处理器使用趋势">
        <div className="widget__chart-head"><span>实时负载</span><b>{cpu.toFixed(1)}%</b></div>
        <Sparkline values={cpuHistory} height={66} />
        {cores.length > 0 && (
          <div className="widget__cores" aria-label="各处理器核心占用">
            {cores.slice(0, 8).map((core) => (
              <div key={core.index} className="widget__core" title={`CPU ${core.index}: ${core.usage_pct.toFixed(0)}%`}>
                <span>{core.index}</span><Meter value={core.usage_pct} tone={toneFor(core.usage_pct)} />
              </div>
            ))}
            {cores.length > 8 && <small className="muted">+{cores.length - 8}</small>}
          </div>
        )}
      </section>

      <div className="widget__io" aria-label="网络与磁盘吞吐">
        <span className="rate rate--down">↓ {formatRate(latest?.net_rx_bps ?? 0)}</span>
        <span className="rate rate--up">↑ {formatRate(latest?.net_tx_bps ?? 0)}</span>
        <span>磁盘读 {formatRate(summary?.disk_io.read_bytes_per_sec ?? 0)}</span>
        <span>写 {formatRate(summary?.disk_io.write_bytes_per_sec ?? 0)}</span>
      </div>

      <section className="widget__apps">
        <header><h3>资源占用热点</h3><small>{apps ? `${apps.apps.length} 个应用` : "等待数据"}</small></header>
        {topApps.map((app) => {
          const normalizedCpu = app.cpu_pct / Math.max(1, apps?.cores ?? summary?.host.cores_logical ?? 1);
          return (
            <div key={app.key} className="widget__app-row">
              <div className="widget__app-name"><b>{app.label}</b><small>{app.processes} 个进程</small></div>
              <div className="widget__app-meter"><Meter value={Math.min(100, normalizedCpu)} tone={toneFor(normalizedCpu)} /><small>CPU {app.cpu_pct.toFixed(1)}% · 内存 {formatBytes(app.mem_bytes)}</small></div>
            </div>
          );
        })}
        {topApps.length === 0 && <p className="muted widget__empty">正在读取系统指标…</p>}
      </section>
    </section>
  );
}
