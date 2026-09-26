import { Meter, Ring, Sparkline, toneFor } from "../components/charts";
import { formatBytes, formatDuration, formatRate, type Series, type Summary } from "../api";

export default function Overview({ summary, series }: { summary: Summary | null; series: Series | null }) {
  if (!summary) return <p className="muted">正在读取系统信息…</p>;
  const { host, cpu, memory, disks, disk_io, networks, apps } = summary;
  const cpuHistory = (series?.samples ?? []).map((sample) => sample.cpu_pct);
  const memHistory = (series?.samples ?? []).map((sample) => sample.mem_pct);

  return (
    <div className="grid">
      <section className="card card--wide">
        <header className="card__head">
          <h3>设备</h3>
          <span className="chip">{host.hostname}</span>
        </header>
        <div className="facts">
          <div><span>系统</span><b>{host.os_name} {host.os_version}</b></div>
          <div><span>内核</span><b>{host.kernel}</b></div>
          <div><span>处理器</span><b>{host.cpu_brand || "未知"} · {host.cores_physical} 核 / {host.cores_logical} 线程</b></div>
          <div><span>运行时长</span><b>{formatDuration(host.uptime_secs)}</b></div>
          <div><span>进程数</span><b>{summary.process_count}</b></div>
          <div><span>负载</span><b>{cpu.load1.toFixed(2)} / {cpu.load5.toFixed(2)} / {cpu.load15.toFixed(2)}</b></div>
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>CPU</h3><span className="muted">{summary.interval_ms / 1000}s 采样</span></header>
        <div className="ring-row">
          <Ring value={cpu.usage_pct} label="占用" tone={toneFor(cpu.usage_pct)} />
          <div className="ring-row__chart">
            <Sparkline values={cpuHistory} />
            <div className="core-bars">
              {cpu.per_core.map((core) => (
                <div key={core.index} className="core-bars__item">
                  <span>CPU{core.index}</span>
                  <Meter value={core.usage_pct} tone={toneFor(core.usage_pct)} />
                  <b>{core.usage_pct.toFixed(0)}%</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>内存</h3><span className="muted">{formatBytes(memory.used_bytes)} / {formatBytes(memory.total_bytes)}</span></header>
        <div className="ring-row">
          <Ring value={memory.used_pct} label="已用" tone={toneFor(memory.used_pct)} />
          <div className="ring-row__chart">
            <Sparkline values={memHistory} stroke="#7fb2ff" fill="rgba(127,178,255,.16)" />
            <div className="facts facts--compact">
              <div><span>可用</span><b>{formatBytes(memory.available_bytes)}</b></div>
              <div><span>Swap</span><b>{formatBytes(memory.swap_used_bytes)} / {formatBytes(memory.swap_total_bytes)}（{memory.swap_used_pct.toFixed(0)}%）</b></div>
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>磁盘</h3><span className="muted">读 {formatRate(disk_io.read_bytes_per_sec)} · 写 {formatRate(disk_io.write_bytes_per_sec)}</span></header>
        <div className="list">
          {disks.map((disk) => (
            <div key={disk.mount_point} className="list__row">
              <div className="list__main">
                <b>{disk.mount_point}</b>
                <small>{disk.name} · {disk.file_system} · {disk.kind}{disk.removable ? " · 可移动" : ""}</small>
              </div>
              <div className="list__meter">
                <Meter value={disk.used_pct} tone={toneFor(disk.used_pct)} />
                <small>{formatBytes(disk.used_bytes)} / {formatBytes(disk.total_bytes)}（{disk.used_pct.toFixed(0)}%）</small>
              </div>
            </div>
          ))}
          {disks.length === 0 && <p className="muted">未读取到挂载点</p>}
        </div>
      </section>

      <section className="card">
        <header className="card__head"><h3>网络</h3><span className="muted">来自 /proc/net/dev</span></header>
        <div className="list">
          {networks.map((interface_) => (
            <div key={interface_.name} className="list__row">
              <div className="list__main">
                <b>{interface_.name}</b>
                <small>累计 ↓ {formatBytes(interface_.received_bytes)} · ↑ {formatBytes(interface_.transmitted_bytes)}{interface_.errors > 0 ? ` · 错误 ${interface_.errors}` : ""}</small>
              </div>
              <div className="list__rates">
                <span className="rate rate--down">↓ {formatRate(interface_.rx_bytes_per_sec)}</span>
                <span className="rate rate--up">↑ {formatRate(interface_.tx_bytes_per_sec)}</span>
              </div>
            </div>
          ))}
          {networks.length === 0 && <p className="muted">未读取到网络接口</p>}
        </div>
      </section>

      <section className="card card--wide">
        <header className="card__head"><h3>应用程序占用 TOP</h3><span className="muted">按 cgroup 归并</span></header>
        <table className="table">
          <thead>
            <tr><th>应用</th><th>进程</th><th>CPU</th><th>整机占比</th><th>内存</th></tr>
          </thead>
          <tbody>
            {apps.slice(0, 8).map((app) => (
              <tr key={app.key}>
                <td>
                  <b>{app.label}</b>
                  <small className="muted"> {app.from_unit ? "systemd 单元" : "可执行文件"}</small>
                </td>
                <td>{app.processes}</td>
                <td>{app.cpu_pct.toFixed(1)}%</td>
                <td>{app.cpu_pct_total.toFixed(1)}%</td>
                <td>{formatBytes(app.mem_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
