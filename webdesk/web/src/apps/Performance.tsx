import { Meter, Sparkline, toneFor } from "../components/charts";
import { formatBytes, formatRate, type Series, type Summary } from "../api";

const WINDOWS = [60, 120, 300];

export default function Performance({
  summary,
  series,
  windowSize: selected,
  onWindowChange,
}: {
  summary: Summary | null;
  series: Series | null;
  windowSize: number;
  onWindowChange: (size: number) => void;
}) {
  const samples = series?.samples ?? [];
  const cpu = samples.map((sample) => sample.cpu_pct);
  const memory = samples.map((sample) => sample.mem_pct);
  const netDown = samples.map((sample) => sample.net_rx_bps);
  const netUp = samples.map((sample) => sample.net_tx_bps);
  const diskRead = samples.map((sample) => sample.disk_read_bps);
  const diskWrite = samples.map((sample) => sample.disk_write_bps);
  const peak = (values: number[]) => (values.length ? Math.max(...values) : 0);
  const latest = samples[samples.length - 1];

  return (
    <div className="grid">
      <section className="card card--wide">
        <header className="card__head">
          <h3>时间窗口</h3>
          <div className="tabs">
            {WINDOWS.map((value) => (
              <button
                key={value}
                className={value === selected ? "tab tab--active" : "tab"}
                onClick={() => onWindowChange(value)}
              >
                {value === 60 ? "2 分钟" : value === 120 ? "4 分钟" : "10 分钟"}
              </button>
            ))}
          </div>
        </header>
        <p className="muted">
          共 {samples.length} 个采样点，间隔 {(series?.interval_ms ?? 2000) / 1000}s；数值来自 /proc，未做平滑处理。
        </p>
      </section>

      <section className="card">
        <header className="card__head"><h3>CPU 总占用</h3><span className="muted">峰值 {peak(cpu).toFixed(0)}%</span></header>
        <Sparkline values={cpu} height={110} />
        <div className="core-bars core-bars--wrap">
          {(summary?.cpu.per_core ?? []).map((core) => (
            <div key={core.index} className="core-bars__item">
              <span>CPU{core.index}</span>
              <Meter value={core.usage_pct} tone={toneFor(core.usage_pct)} />
              <b>{core.usage_pct.toFixed(0)}%</b>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>内存占用</h3><span className="muted">当前 {summary?.memory.used_pct.toFixed(0) ?? "--"}%</span></header>
        <Sparkline values={memory} height={110} stroke="#7fb2ff" fill="rgba(127,178,255,.16)" />
        <div className="facts facts--compact">
          <div><span>已用</span><b>{formatBytes(summary?.memory.used_bytes ?? 0)}</b></div>
          <div><span>Swap</span><b>{formatBytes(summary?.memory.swap_used_bytes ?? 0)}</b></div>
          <div><span>负载 1 分钟</span><b>{latest ? latest.load1.toFixed(2) : "--"}</b></div>
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>网络吞吐</h3><span className="muted">峰值 ↓ {formatRate(peak(netDown))}</span></header>
        <div className="chart-legend"><span className="rate rate--down">↓ 接收</span><span className="rate rate--up">↑ 发送</span></div>
        <Sparkline values={netDown} max={Math.max(peak(netDown), peak(netUp), 1)} height={84} />
        <Sparkline values={netUp} max={Math.max(peak(netDown), peak(netUp), 1)} height={64} stroke="#ffb27f" fill="rgba(255,178,127,.14)" />
        <div className="facts facts--compact">
          <div><span>当前下行</span><b>{formatRate(latest?.net_rx_bps ?? 0)}</b></div>
          <div><span>当前上行</span><b>{formatRate(latest?.net_tx_bps ?? 0)}</b></div>
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>磁盘 IO</h3><span className="muted">/proc/diskstats</span></header>
        <div className="chart-legend"><span className="rate rate--down">读</span><span className="rate rate--up">写</span></div>
        <Sparkline values={diskRead} max={Math.max(peak(diskRead), peak(diskWrite), 1)} height={84} stroke="#9d8cff" fill="rgba(157,140,255,.16)" />
        <Sparkline values={diskWrite} max={Math.max(peak(diskRead), peak(diskWrite), 1)} height={64} stroke="#ff8fb0" fill="rgba(255,143,176,.14)" />
        <div className="facts facts--compact">
          <div><span>当前读</span><b>{formatRate(latest?.disk_read_bps ?? 0)}</b></div>
          <div><span>当前写</span><b>{formatRate(latest?.disk_write_bps ?? 0)}</b></div>
        </div>
      </section>
    </div>
  );
}
