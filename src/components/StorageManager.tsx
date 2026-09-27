import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, HardDrives, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import * as api from "../api";
import "./storage-manager.css";

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const tier = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** tier).toFixed(tier > 1 ? 1 : 0)} ${units[tier]}`;
};

const normalizedPath = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || "/";
};

function containsPath(mountPoint: string, target: string) {
  if (!target.trim()) return false;
  const mount = normalizedPath(mountPoint);
  const path = normalizedPath(target);
  return mount === "/" ? path.startsWith("/") : path === mount || path.startsWith(`${mount}/`);
}

export default function StorageManager({ root }: { root: string }) {
  const [snapshot, setSnapshot] = useState<api.StorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await api.storageSummary());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const volumes = snapshot?.volumes ?? [];
  const homeVolume = useMemo(
    () => volumes.filter((volume) => containsPath(volume.mount_point, root)).sort((a, b) => b.mount_point.length - a.mount_point.length)[0],
    [volumes, root],
  );
  const lowSpaceCount = volumes.filter((volume) => volume.used_pct >= 85).length;
  const totalAvailable = volumes.reduce((sum, volume) => sum + volume.available_bytes, 0);
  const sampledAt = snapshot ? new Date(snapshot.sampled_at_ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  return (
    <div className="dd-storage">
      <header className="dd-storage__head">
        <div className="dd-storage__heading">
          <span className="dd-storage__eyebrow">LOCAL VOLUMES / 只读监控</span>
          <h1>存储空间</h1>
          <p>查看本机磁盘与挂载卷容量，定位 DepDek Home 所在位置。</p>
        </div>
        <button className="dd-storage__refresh" onClick={() => void refresh()} disabled={loading}>
          <ArrowClockwise size={16} className={loading ? "dd-storage__spin" : ""} />刷新
        </button>
      </header>

      {error && <div className="dd-storage__error" role="alert"><WarningCircle size={17} />读取存储信息失败：{error}</div>}

      <section className="dd-storage__overview" aria-label="存储概览">
        <article className="dd-storage__overview-card dd-storage__overview-card--volumes">
          <span>挂载卷</span><strong>{snapshot ? volumes.length : "—"}</strong><small>按系统报告的卷分别展示</small>
        </article>
        <article className="dd-storage__overview-card dd-storage__overview-card--free">
          <span>剩余空间合计</span><strong>{snapshot ? formatBytes(totalAvailable) : "—"}</strong><small>跨挂载卷汇总；共享容器可能重复</small>
        </article>
        <article className={`dd-storage__overview-card ${lowSpaceCount ? "dd-storage__overview-card--warning" : "dd-storage__overview-card--health"}`}>
          <span>空间健康</span><strong>{snapshot ? (volumes.length === 0 ? "暂无卷数据" : lowSpaceCount ? `${lowSpaceCount} 卷需关注` : "状态良好") : "—"}</strong><small>使用率达到 85% 时提示关注</small>
        </article>
      </section>

      <section className="dd-storage__home" aria-label="DepDek Home 所在位置">
        <div className="dd-storage__home-icon"><HardDrives size={21} /></div>
        <div className="dd-storage__home-copy"><span>DEPDEK HOME</span><b>{homeVolume ? `位于 ${homeVolume.mount_point}` : "暂未匹配到挂载卷"}</b><small title={root}>{root || "尚未连接 Home"}</small></div>
        <span className={`dd-storage__home-status ${homeVolume ? "" : "dd-storage__home-status--muted"}`}><ShieldCheck size={15} />{homeVolume ? "本地目录" : "待确认路径"}</span>
      </section>

      <div className="dd-storage__section-head">
        <div><span className="dd-storage__eyebrow">VOLUME INVENTORY</span><h2>磁盘与卷</h2></div>
        <span>{loading && !snapshot ? "正在读取…" : `最近读取 ${sampledAt}`}</span>
      </div>

      {snapshot && volumes.length === 0 ? (
        <div className="dd-storage__empty"><HardDrives size={26} /><b>没有可显示的挂载卷</b><span>系统当前未报告可用容量信息。</span></div>
      ) : (
        <div className="dd-storage__volumes">
          {volumes.map((volume) => {
            const isHome = volume === homeVolume;
            const pressure = volume.used_pct >= 85;
            return (
              <article className={`dd-storage__volume ${isHome ? "dd-storage__volume--home" : ""}`} key={`${volume.mount_point}:${volume.name}`}>
                <header>
                  <div className="dd-storage__volume-icon"><HardDrives size={19} /></div>
                  <div className="dd-storage__volume-name"><b>{volume.name || volume.mount_point}</b><small title={volume.mount_point}>{volume.mount_point}</small></div>
                  <span className={`dd-storage__volume-badge ${pressure ? "dd-storage__volume-badge--warn" : ""}`}>{isHome ? "Home 所在卷" : pressure ? "空间偏紧" : "正常"}</span>
                </header>
                <div className="dd-storage__bar" role="progressbar" aria-label={`${volume.mount_point} 已用空间`} aria-valuenow={Math.round(volume.used_pct)} aria-valuemin={0} aria-valuemax={100}>
                  <i className={pressure ? "dd-storage__bar-fill--warn" : ""} style={{ width: `${Math.max(0, Math.min(100, volume.used_pct))}%` }} />
                </div>
                <div className="dd-storage__capacity"><b>{formatBytes(volume.used_bytes)} <span>/ {formatBytes(volume.total_bytes)}</span></b><span>{volume.used_pct.toFixed(1)}% 已使用</span></div>
                <footer><span>可用 <b>{formatBytes(volume.available_bytes)}</b></span><span>{volume.file_system || "未知文件系统"} · {volume.kind}{volume.removable ? " · 可移动" : ""}</span></footer>
              </article>
            );
          })}
        </div>
      )}

      <p className="dd-storage__notice"><ShieldCheck size={15} />仅读取系统容量元数据；不会扫描文件内容，也不会格式化、移动或删除磁盘数据。{snapshot && ` · ${volumes.length} 个挂载卷`}</p>
    </div>
  );
}
