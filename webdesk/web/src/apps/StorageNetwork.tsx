import { Meter, toneFor } from "../components/charts";
import { formatBytes, formatRate, type Summary } from "../api";

export default function StorageNetwork({ summary, onRefresh, refreshing }: { summary: Summary | null; onRefresh: () => void; refreshing: boolean }) {
  if (!summary) return <p className="muted">正在读取存储与网络信息…</p>;
  const { disks, disk_io, networks } = summary;
  const totalSpace = disks.reduce((sum, disk) => sum + disk.total_bytes, 0);
  const usedSpace = disks.reduce((sum, disk) => sum + disk.used_bytes, 0);
  const availableSpace = disks.reduce((sum, disk) => sum + disk.available_bytes, 0);
  const pressureVolumes = disks.filter((disk) => disk.used_pct >= 85).length;

  return (
    <div className="grid">
      <section className="card card--wide">
        <header className="card__head storage-manager__head">
          <div className="storage-manager__title"><span aria-hidden="true">▦</span><div><h3>存储空间</h3><small>本机挂载卷 · 只读信息</small></div></div>
          <button className="storage-manager__refresh" onClick={onRefresh} disabled={refreshing} aria-label="刷新存储信息">
            <span aria-hidden="true" className={refreshing ? "storage-manager__spin" : ""}>↻</span>{refreshing ? "刷新中" : "刷新"}
          </button>
        </header>
        <div className="storage-manager__summary">
          <div><span>挂载卷</span><b>{disks.length}<small> 个</small></b></div>
          <div><span>卷容量使用</span><b>{formatBytes(usedSpace)}<small> / {formatBytes(totalSpace)}</small></b></div>
          <div><span>可用空间合计</span><b>{formatBytes(availableSpace)}</b></div>
          <div className={pressureVolumes ? "storage-manager__pressure" : "storage-manager__healthy"}><span>空间状态</span><b>{disks.length === 0 ? "暂无卷数据" : pressureVolumes ? `${pressureVolumes} 卷偏紧` : "正常"}</b></div>
        </div>
        <div className="list storage-manager__volumes">
          {disks.map((disk) => (
            <div key={disk.mount_point} className={`list__row storage-manager__volume ${disk.used_pct >= 85 ? "storage-manager__volume--pressure" : ""}`}>
              <div className="list__main">
                <b title={disk.mount_point}>{disk.name || disk.mount_point}</b>
                <small title={disk.mount_point}>{disk.mount_point} · {disk.file_system} · {disk.kind}{disk.removable ? " · 可移动设备" : ""}</small>
              </div>
              <div className="list__meter">
                <Meter value={disk.used_pct} tone={toneFor(disk.used_pct)} />
                <small>{formatBytes(disk.used_bytes)} / {formatBytes(disk.total_bytes)}（{disk.used_pct.toFixed(1)}%） · 可用 {formatBytes(disk.available_bytes)}</small>
              </div>
            </div>
          ))}
          {disks.length === 0 && <p className="muted">未读取到挂载点</p>}
        </div>
        <p className="muted card__note storage-manager__notice"><span aria-hidden="true">◇</span>按挂载卷统计；共享存储容器可能重复计数。仅读取容量信息，不扫描文件内容、不执行磁盘写入。</p>
      </section>

      <section className="card card--wide">
        <header className="card__head">
          <h3>网络接口与磁盘吞吐</h3>
          <span className="muted">
            磁盘读 {formatRate(disk_io.read_bytes_per_sec)} · 写 {formatRate(disk_io.write_bytes_per_sec)}
          </span>
        </header>
        <p className="muted card__note">网卡累计流量与实时速率。</p>
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
