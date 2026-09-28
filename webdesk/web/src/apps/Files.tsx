import { useEffect, useMemo, useState } from "react";
import { api, demoMode, formatBytes, type FileEntry, type FilesPage } from "../api";

function iconFor(item: FileEntry) {
  if (item.kind === "directory") return "▰";
  const extension = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(extension)) return "▧";
  if (["mp4", "mov", "mkv", "webm"].includes(extension)) return "▷";
  if (["mp3", "wav", "flac", "m4a"].includes(extension)) return "♫";
  if (["pdf"].includes(extension)) return "PDF";
  if (["md", "txt", "csv", "json", "yaml", "yml", "log", "toml"].includes(extension)) return "≡";
  return "↧";
}

function dateLabel(value: number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

function previewable(name: string) {
  return /\.(txt|md|markdown|csv|json|ya?ml|toml|log|ini|xml|html|css|js|ts|rs|py|sh)$/i.test(name);
}

export default function Files() {
  const [page, setPage] = useState<FilesPage | null>(null);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState("");

  const load = async (nextPath = path) => {
    setLoading(true);
    setError("");
    try {
      const result = await api.files(nextPath);
      setPage(result);
      setPath(nextPath);
      setSelectedPath(null);
      setPreview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPage(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(""); }, []);

  const visibleItems = useMemo(() => {
    const filter = query.trim().toLocaleLowerCase();
    const items = page?.items ?? [];
    return filter ? items.filter((item) => item.name.toLocaleLowerCase().includes(filter)) : items;
  }, [page, query]);

  const selected = page?.items.find((item) => item.path === selectedPath) ?? null;
  const segments = path ? path.split("/") : [];

  const showPreview = async (item: FileEntry) => {
    if (!previewable(item.name)) return;
    setBusyAction(true);
    setPreview(null);
    setSelectedPath(item.path);
    try {
      const result = await api.filePreview(item.path);
      setPreview(result.content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyAction(false);
    }
  };

  const downloadSelected = async () => {
    if (!selected || selected.kind !== "file") return;
    setBusyAction(true);
    setError("");
    try {
      const blob = await api.fileDownload(selected.path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selected.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyAction(false);
    }
  };

  const navigate = (nextPath: string) => {
    setQuery("");
    void load(nextPath);
  };

  return (
    <div className="file-manager">
      <aside className="file-manager__rail" aria-label="文件位置">
        <div className="file-manager__rail-label">常用位置</div>
        <button className={!path ? "file-manager__place file-manager__place--active" : "file-manager__place"} onClick={() => navigate("")}>
          <span>⌂</span><b>我的资料</b>
        </button>
        <div className="file-manager__rail-note"><i />服务器只读浏览<br />不会修改原始文件</div>
      </aside>

      <section className="file-manager__main">
        <header className="file-manager__toolbar">
          <div className="file-manager__breadcrumbs" aria-label="当前路径">
            <button onClick={() => navigate("")}>{page?.root_name ?? "我的资料"}</button>
            {segments.map((segment, index) => (
              <span key={`${segment}-${index}`} className="file-manager__crumb"><i>/</i><button onClick={() => navigate(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>
            ))}
          </div>
          <div className="file-manager__tools">
            <label className="file-manager__search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前文件夹" aria-label="搜索当前文件夹" /></label>
            <button className="file-manager__refresh" disabled={loading} title="刷新" aria-label="刷新文件列表" onClick={() => void load(path)}>↻</button>
          </div>
        </header>

        {error && <div className="file-manager__notice" role="alert"><b>{error}</b>{error.includes("files_root") && <small>在服务端 webdesk.toml 设置 files_root 为允许浏览的共享目录，然后重启 Webdesk。文件服务只读，并要求启用登录认证。</small>}</div>}

        <div className="file-manager__list-head"><span>名称</span><span>修改时间</span><span>大小</span></div>
        <div className="file-manager__list" aria-busy={loading}>
          {loading && <div className="file-manager__loading"><i />正在读取文件夹…</div>}
          {!loading && visibleItems.map((item) => (
            <div key={item.path} className={`file-manager__row ${selectedPath === item.path ? "file-manager__row--selected" : ""}`} onClick={() => { setSelectedPath(item.path); setPreview(null); }} onDoubleClick={() => item.kind === "directory" ? navigate(item.path) : void showPreview(item)}>
              <span className={`file-manager__item-icon ${item.kind === "directory" ? "file-manager__item-icon--folder" : ""}`} aria-hidden="true">{iconFor(item)}</span>
              <span className="file-manager__item-name" title={item.name}><b>{item.name}</b><small>{item.kind === "directory" ? "文件夹" : (item.name.split(".").pop() ?? "文件").toUpperCase()}</small></span>
              <span className="file-manager__date">{dateLabel(item.modified_at_ms)}</span>
              <span className="file-manager__size">{item.kind === "directory" ? "—" : formatBytes(item.size_bytes)}</span>
              {item.kind === "directory" && <button className="file-manager__open" aria-label={`打开 ${item.name}`} title="打开文件夹" onClick={(event) => { event.stopPropagation(); navigate(item.path); }}>›</button>}
            </div>
          ))}
          {!loading && page && visibleItems.length === 0 && <div className="file-manager__empty"><span>◇</span><b>{query ? "没有匹配的文件" : "这个文件夹还是空的"}</b><small>{query ? "试试其他关键词" : "文件列表会显示在这里"}</small></div>}
        </div>

        <footer className="file-manager__footer"><span>{page ? `${visibleItems.length}${page.truncated ? "+" : ""} 个项目` : demoMode ? "演示数据" : "等待目录配置"}</span><span>双击文件夹进入 · 双击文本文件预览</span></footer>

        {selected?.kind === "file" && (
          <aside className="file-manager__inspector" aria-label="文件详情">
            <button className="file-manager__inspector-close" aria-label="关闭详情" onClick={() => { setSelectedPath(null); setPreview(null); }}>×</button>
            <div className={`file-manager__inspector-icon ${iconFor(selected).length > 2 ? "file-manager__inspector-icon--text" : ""}`}>{iconFor(selected)}</div>
            <b className="file-manager__inspector-name" title={selected.name}>{selected.name}</b>
            <small>{formatBytes(selected.size_bytes)} · {dateLabel(selected.modified_at_ms)}</small>
            <div className="file-manager__inspector-actions">
              {previewable(selected.name) && <button className="ghost" disabled={busyAction} onClick={() => void showPreview(selected)}>{busyAction ? "读取中…" : "快速预览"}</button>}
              <button className="primary" disabled={busyAction} onClick={() => void downloadSelected()}>下载文件</button>
            </div>
            {preview && <pre className="file-manager__preview">{preview}</pre>}
          </aside>
        )}
      </section>
    </div>
  );
}
