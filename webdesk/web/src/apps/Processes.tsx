import { useEffect, useMemo, useState } from "react";
import { Meter, toneFor } from "../components/charts";
import { api, formatBytes, formatDuration, type AppList, type ProcessList } from "../api";

type SortKey = "cpu" | "mem" | "disk";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "cpu", label: "按 CPU" },
  { key: "mem", label: "按内存" },
  { key: "disk", label: "按磁盘 IO" },
];

export default function Processes({ apps }: { apps: AppList | null }) {
  const [sort, setSort] = useState<SortKey>("cpu");
  const [list, setList] = useState<ProcessList | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api.processes(sort, 80);
        if (active) {
          setList(next);
          setError("");
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sort]);

  const rows = useMemo(() => {
    const processes = list?.processes ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return processes;
    return processes.filter(
      (process) =>
        process.name.toLowerCase().includes(needle) ||
        process.app_label.toLowerCase().includes(needle) ||
        process.cmd.toLowerCase().includes(needle) ||
        String(process.pid) === needle,
    );
  }, [filter, list]);

  const totalMemory = apps?.total_memory_bytes ?? 0;

  return (
    <div className="grid">
      <section className="card card--wide">
        <header className="card__head">
          <h3>应用程序占用</h3>
          <span className="muted">按 systemd cgroup 归并 · 共 {apps?.apps.length ?? 0} 组</span>
        </header>
        <div className="app-list">
          {(apps?.apps ?? []).map((app) => (
            <div key={app.key} className="app-list__row">
              <div className="app-list__head">
                <b>{app.label}</b>
                <small>{app.processes} 个进程 · {app.from_unit ? "systemd 单元" : "可执行文件"} · PID {app.top_pids.join(", ")}</small>
              </div>
              <div className="app-list__metrics">
                <div className="app-list__metric">
                  <span>CPU {app.cpu_pct.toFixed(1)}%</span>
                  <Meter value={Math.min(100, app.cpu_pct / (apps?.cores ?? 1))} tone={toneFor(app.cpu_pct / (apps?.cores ?? 1))} />
                </div>
                <div className="app-list__metric">
                  <span>内存 {formatBytes(app.mem_bytes)}</span>
                  <Meter value={totalMemory ? (app.mem_bytes / totalMemory) * 100 : 0} tone="blue" />
                </div>
                <div className="app-list__io">
                  读 {formatBytes(app.disk_read_bytes)} · 写 {formatBytes(app.disk_write_bytes)}
                </div>
              </div>
            </div>
          ))}
          {(apps?.apps.length ?? 0) === 0 && <p className="muted">暂无数据</p>}
        </div>
      </section>

      <section className="card card--wide">
        <header className="card__head">
          <h3>进程明细</h3>
          <div className="tabs">
            {SORTS.map((entry) => (
              <button
                key={entry.key}
                className={entry.key === sort ? "tab tab--active" : "tab"}
                onClick={() => setSort(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </header>
        <div className="toolbar">
          <input
            className="toolbar__search"
            placeholder="搜索进程名 / 应用 / 命令 / PID"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className="muted">显示 {rows.length} / {list?.total ?? 0} 个进程 · 每 3 秒刷新</span>
        </div>
        {error && <p className="error">{error}</p>}
        <table className="table table--dense">
          <thead>
            <tr><th>PID</th><th>进程</th><th>应用</th><th>CPU</th><th>整机</th><th>内存</th><th>运行时长</th><th>命令</th></tr>
          </thead>
          <tbody>
            {rows.map((process) => (
              <tr key={process.pid}>
                <td className="mono">{process.pid}</td>
                <td><b>{process.name || process.app_label}</b></td>
                <td>{process.app_label}</td>
                <td>{process.cpu_pct.toFixed(1)}%</td>
                <td className="muted">{process.cpu_pct_total.toFixed(1)}%</td>
                <td>{formatBytes(process.mem_bytes)}</td>
                <td className="muted">{formatDuration(process.run_time_secs)}</td>
                <td className="mono ellipsis" title={process.cmd}>{process.cmd || process.exe || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
