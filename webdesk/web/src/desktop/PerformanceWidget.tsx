import { Meter, Ring, Sparkline, toneFor } from "../components/charts";
import { formatBytes, formatRate, type AppList, type Series, type Summary } from "../api";

interface Props {
  summary: Summary | null;
  series: Series | null;
  apps: AppList | null;
  onOpenPerformance: () => void;
  onOpenProcesses: () => void;
}

/**
 * The desktop performance monitor: CPU/memory rings, a live CPU sparkline,
 * per-core meters and the applications that currently dominate the machine.
 */
export default function PerformanceWidget({ summary, series, apps, onOpenPerformance, onOpenProcesses }: Props) {
  const samples = series?.samples ?? [];
  const cpuHistory = samples.map((sample) => sample.cpu_pct);
  const latest = samples[samples.length - 1];
  const cpu = summary?.cpu.usage_pct ?? latest?.cpu_pct ?? 0;
  const memory = summary?.memory.used_pct ?? latest?.mem_pct ?? 0;
  const topApps = (apps?.apps ?? summary?.apps ?? []).slice(0, 4);

  return (
    <section className="widget widget--performance">
      <header className="widget__head">
        <div>
          <h2>系统性能监控</h2>
          <small>
            {summary ? `${summary.host.hostname} · ${summary.host.cores_logical} 线程 · ${summary.host.cpu_brand || "CPU"}` : "正在连接…"}
          </small>
        </div>
        <div className="widget__actions">
          <button className="ghost" onClick={onOpenProcesses}>进程与占用</button>
          <button className="primary" onClick={onOpenPerformance}>打开性能监控</button>
        </div>
      </header>

      <div className="widget__body">
        <div className="widget__rings">
          <Ring value={cpu} label="CPU" tone={toneFor(cpu)} caption={`负载 ${summary?.cpu.load1.toFixed(2) ?? "--"}`} />
          <Ring value={memory} label="内存" tone={toneFor(memory)} caption={`${formatBytes(summary?.memory.used_bytes ?? 0)} / ${formatBytes(summary?.memory.total_bytes ?? 0)}`} />
        </div>

        <div className="widget__chart">
          <div className="widget__chart-head">
            <span>CPU 占用趋势</span>
            <b>{cpu.toFixed(0)}%</b>
          </div>
          <Sparkline values={cpuHistory} height={92} />
          <div className="core-bars core-bars--wrap">
            {(summary?.cpu.per_core ?? []).map((core) => (
              <div key={core.index} className="core-bars__item">
                <span>CPU{core.index}</span>
                <Meter value={core.usage_pct} tone={toneFor(core.usage_pct)} />
                <b>{core.usage_pct.toFixed(0)}%</b>
              </div>
            ))}
          </div>
          <div className="widget__io">
            <span className="rate rate--down">↓ {formatRate(latest?.net_rx_bps ?? 0)}</span>
            <span className="rate rate--up">↑ {formatRate(latest?.net_tx_bps ?? 0)}</span>
            <span>磁盘 读 {formatRate(summary?.disk_io.read_bytes_per_sec ?? 0)}</span>
            <span>写 {formatRate(summary?.disk_io.write_bytes_per_sec ?? 0)}</span>
          </div>
        </div>
      </div>

      <div className="widget__apps">
        <header>
          <h3>占用最高的应用</h3>
          <small>{apps ? `${apps.apps.length} 组 · 共 ${apps.cores} 线程` : ""}</small>
        </header>
        {topApps.map((app) => (
          <div key={app.key} className="widget__app-row">
            <div className="widget__app-name">
              <b>{app.label}</b>
              <small>{app.processes} 进程{app.from_unit ? " · systemd" : ""}</small>
            </div>
            <div className="widget__app-meter">
              <Meter value={Math.min(100, app.cpu_pct / Math.max(1, apps?.cores ?? 1))} tone={toneFor(app.cpu_pct / Math.max(1, apps?.cores ?? 1))} />
              <small>CPU {app.cpu_pct.toFixed(1)}% · 内存 {formatBytes(app.mem_bytes)}</small>
            </div>
          </div>
        ))}
        {topApps.length === 0 && <p className="muted">暂无应用数据</p>}
      </div>
    </section>
  );
}
