import { Meter, toneFor } from "../components/charts";
import { formatBytes, formatRate, type Summary } from "../api";

export default function StorageNetwork({ summary }: { summary: Summary | null }) {
  if (!summary) return <p className="muted">正在读取存储与网络信息…</p>;
  const { disks, disk_io, networks } = summary;
  const totalSpace = disks.reduce((sum, disk) => sum + disk.total_bytes, 0);
  const usedSpace = disks.reduce((sum, disk) => sum + disk.used_bytes, 0);

  return (
    <div className="grid">
      <section className="card card--wide">
        <header className="card__head">
          <h3>存储概览</h3>
          <span className="muted">
            合计 {formatBytes(usedSpace)} / {formatBytes(totalSpace)} · 读 {formatRate(disk_io.read_bytes_per_sec)} · 写 {formatRate(disk_io.write_bytes_per_sec)}
          </span>
        </header>
        <div className="list">
          {disks.map((disk) => (
            <div key={disk.mount_point} className="list__row">
              <div className="list__main">
                <b>{disk.mount_point}</b>
                <small>{disk.name} · {disk.file_system} · {disk.kind}{disk.removable ? " · 可移动设备" : ""}</small>
              </div>
              <div className="list__meter">
                <Meter value={disk.used_pct} tone={toneFor(disk.used_pct)} />
                <small>
                  {formatBytes(disk.used_bytes)} / {formatBytes(disk.total_bytes)}（{disk.used_pct.toFixed(1)}%）· 可用 {formatBytes(disk.available_bytes)}
                </small>
              </div>
            </div>
          ))}
          {disks.length === 0 && <p className="muted">未读取到挂载点</p>}
        </div>
        <p className="muted card__note">
          只读展示。后续版本会在这里接入 NAS 共享、快照与备份（见 docs/webdesk-design.md 的路线图），所有写操作都需要二次确认并记入审计。
        </p>
      </section>

      <section className="card card--wide">
        <header className="card__head"><h3>网络接口</h3><span className="muted">累计流量与实时速率</span></header>
        <table className="table">
          <thead>
            <tr><th>接口</th><th>实时接收</th><th>实时发送</th><th>累计接收</th><th>累计发送</th><th>错误</th></tr>
          </thead>
          <tbody>
            {networks.map((interface_) => (
              <tr key={interface_.name}>
                <td><b>{interface_.name}</b></td>
                <td className="rate rate--down">{formatRate(interface_.rx_bytes_per_sec)}</td>
                <td className="rate rate--up">{formatRate(interface_.tx_bytes_per_sec)}</td>
                <td>{formatBytes(interface_.received_bytes)}</td>
                <td>{formatBytes(interface_.transmitted_bytes)}</td>
                <td className={interface_.errors > 0 ? "warn" : "muted"}>{interface_.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {networks.length === 0 && <p className="muted">未读取到网络接口</p>}
      </section>
    </div>
  );
}
