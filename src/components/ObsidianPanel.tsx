import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, BookOpen, CheckCircle, FolderOpen, MagnifyingGlass, ShieldCheck, Trash, WarningCircle } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import "./obsidian.css";

const PREVIEW_NOTES: api.ObsidianNote[] = [
  { path: "项目/DepDek 产品规划.md", title: "DepDek 产品规划", folder: "项目", size: 18_240, modified_ms: Date.now() },
  { path: "项目/会议纪要/2026-08-13.md", title: "2026-08-13", folder: "项目/会议纪要", size: 7_410, modified_ms: Date.now() - 86_400_000 },
  { path: "读书/本地优先软件.md", title: "本地优先软件", folder: "读书", size: 4_980, modified_ms: Date.now() - 172_800_000 },
];

const PREVIEW_CONTENT: Record<string, string> = {
  "项目/DepDek 产品规划.md": "# DepDek 产品规划\n\n个人数据先回到本地，再由 Agent 提出可解释的整理建议。\n\n## 原则\n\n- 数据主权在用户\n- 外部写操作逐次确认\n- 来源和推断分开记录\n",
  "项目/会议纪要/2026-08-13.md": "# 2026-08-13\n\n- 确认 Obsidian 只读连接\n- 设计笔记来源回溯\n- 下一步：接入本地索引\n",
  "读书/本地优先软件.md": "# 本地优先软件\n\n本地数据应该可访问、可导出、可删除，并且不依赖云端服务才能阅读。\n",
};

const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const formatSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export default function ObsidianPanel({ onOpenAppConfig }: { onOpenAppConfig?: () => void } = {}) {
  const [root, setRoot] = useState<string | null>(browserPreview ? "~/Obsidian/我的知识库 · UX 预览" : null);
  const [notes, setNotes] = useState<api.ObsidianNote[]>(browserPreview ? PREVIEW_NOTES : []);
  const [selectedPath, setSelectedPath] = useState<string | null>(browserPreview ? PREVIEW_NOTES[0]?.path ?? null : null);
  const [content, setContent] = useState(browserPreview ? PREVIEW_CONTENT[PREVIEW_NOTES[0]?.path ?? ""] ?? "" : "");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!browserPreview);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(browserPreview ? "浏览器预览使用示例笔记；桌面版可连接真实 Obsidian Vault。" : null);

  const loadNotes = async (search = query) => {
    setLoading(true);
    setError(null);
    try {
      if (browserPreview) {
        const filtered = PREVIEW_NOTES.filter((note) => !search || `${note.title} ${note.path}`.toLowerCase().includes(search.toLowerCase()));
        setNotes(filtered);
        if (filtered.length && !filtered.some((note) => note.path === selectedPath)) setSelectedPath(filtered[0].path);
        return;
      }
      const result = await api.obsidianListNotes(search || undefined);
      setNotes(result.notes);
      if (result.notes.length && !result.notes.some((note) => note.path === selectedPath)) setSelectedPath(result.notes[0].path);
      if (!result.notes.length) setSelectedPath(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (browserPreview) return;
    void api.obsidianGetRoot().then((savedRoot) => {
      setRoot(savedRoot);
      if (savedRoot) void loadNotes();
      else setLoading(false);
    }).catch((reason) => { setError(String(reason)); setLoading(false); });
    // Initial connection is loaded once; searching is explicit via Enter/button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedPath) { setContent(""); return; }
    if (browserPreview) {
      setContent(PREVIEW_CONTENT[selectedPath] ?? "# 笔记\n\n暂无示例正文");
      return;
    }
    let active = true;
    setReading(true);
    setError(null);
    void api.obsidianReadNote(selectedPath).then((result) => { if (active) setContent(result.content); }).catch((reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, [selectedPath]);

  const selected = useMemo(() => notes.find((note) => note.path === selectedPath) ?? null, [notes, selectedPath]);

  const connect = async () => {
    if (browserPreview) { setNotice("浏览器预览不能访问本机目录，请在桌面版选择 Obsidian Vault。"); return; }
    setError(null);
    try {
      const selectedDirectory = await open({ directory: true, multiple: false, title: "选择 Obsidian Vault" });
      if (typeof selectedDirectory !== "string") return;
      const normalized = await api.obsidianSetRoot(selectedDirectory);
      setRoot(normalized);
      setNotice("Obsidian 已连接；DepDek 只读展示 Markdown 笔记，不会修改原 Vault。");
      await loadNotes("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const disconnect = async () => {
    if (browserPreview) { setRoot(null); setNotes([]); setSelectedPath(null); setContent(""); return; }
    try {
      await api.obsidianClearRoot();
      setRoot(null); setNotes([]); setSelectedPath(null); setContent(""); setNotice("已断开 Obsidian 连接，原 Vault 未被修改。"); setError(null);
    } catch (reason) { setError(String(reason)); }
  };

  return (
    <div className="dd-obsidian">
      <div className="dd-view-head dd-obsidian-head"><div><div className="dd-eyebrow">KNOWLEDGE / OBSIDIAN</div><h1>知识</h1></div><span>连接你的 Obsidian 知识库，在 DepDek 中统一浏览和回溯。</span></div>
      <section className="dd-obsidian-shell">
        <header className="dd-obsidian-toolbar"><div className="dd-obsidian-connection"><BookOpen size={21} /><div><b>{root ? "Obsidian Vault" : "尚未连接 Obsidian"}</b><small>{root ?? "选择一个本地 Vault 开始展示 Markdown 笔记"}</small></div></div><div className="dd-obsidian-actions">{root && <span className="dd-obsidian-status"><CheckCircle size={14} />已连接 · 只读</span>}<button className="dd-obsidian-connect" onClick={() => onOpenAppConfig ? onOpenAppConfig() : void connect()}><FolderOpen size={15} />{onOpenAppConfig ? "应用配置" : root ? "更换 Vault" : "连接 Obsidian"}</button>{root && <button className="dd-obsidian-disconnect" onClick={() => void disconnect()}><Trash size={14} />断开</button>}</div></header>
        {notice && <div className="dd-obsidian-notice"><ShieldCheck size={15} />{notice}</div>}
        {error && <div className="dd-obsidian-error"><WarningCircle size={15} />{error}</div>}
        {root ? <div className="dd-obsidian-body"><aside className="dd-obsidian-notes"><div className="dd-obsidian-notes-head"><b>Markdown 笔记</b><span>{notes.length}{notes.length >= 5000 ? "+" : ""} 篇</span></div><div className="dd-obsidian-search"><MagnifyingGlass size={14} /><input value={query} placeholder="搜索笔记名称…" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadNotes(event.currentTarget.value); }} /><button onClick={() => void loadNotes()} aria-label="搜索"><ArrowClockwise size={13} /></button></div><div className="dd-obsidian-note-list">{loading ? <span className="dd-obsidian-empty">扫描笔记中…</span> : notes.length ? notes.map((note) => <button key={note.path} className={note.path === selectedPath ? "dd-obsidian-note dd-obsidian-note--active" : "dd-obsidian-note"} onClick={() => setSelectedPath(note.path)}><span><b>{note.title}</b><small>{note.folder} · {formatSize(note.size)}</small></span></button>) : <span className="dd-obsidian-empty">没有匹配的 Markdown 笔记</span>}</div></aside><article className="dd-obsidian-reader">{selected ? <><header><div><b>{selected.title}</b><span>{selected.path}</span></div><small>来源：Obsidian · 只读</small></header>{reading ? <div className="dd-obsidian-reader-loading">读取笔记中…</div> : <pre>{content}</pre>}</> : <div className="dd-obsidian-reader-empty"><BookOpen size={32} /><b>选择一篇笔记</b><span>笔记内容将在本地读取，不会写回 Obsidian。</span></div>}</article></div> : <div className="dd-obsidian-disconnected"><BookOpen size={38} /><b>连接 Obsidian Vault</b><span>选择本机的 Obsidian Vault 后，DepDek 会展示其中的 Markdown 笔记。</span><button className="dd-obsidian-connect" onClick={() => onOpenAppConfig ? onOpenAppConfig() : void connect()}><FolderOpen size={15} />{onOpenAppConfig ? "打开应用配置" : "选择 Vault 文件夹"}</button></div>}
      </section>
    </div>
  );
}
