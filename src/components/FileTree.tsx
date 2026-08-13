import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CaretDown,
  CaretRight,
  File,
  FileCode,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  HouseLine,
  Info,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import * as api from "../api";
import logo from "../assets/depdek-logo.png";
import AIAnalysisPanel from "./AIAnalysisPanel";

interface TreeNode {
  entries?: api.DirEntry[];
  expanded: boolean;
  loading: boolean;
}

type Preview =
  | { path: string; kind: "loading"; size: number }
  | { path: string; kind: "text"; content: string; size: number; sha256?: string }
  | { path: string; kind: "image"; dataUrl: string; size: number; sha256: string }
  | { path: string; kind: "video"; url: string; size: number; sha256: string }
  | { path: string; kind: "pdf"; url: string; size: number; sha256: string }
  | { path: string; kind: "error"; message: string; size: number }
  | { path: string; kind: "unsupported"; size: number };

export type FileViewMode = "tree" | "list" | "preview";

interface Props {
  /** Lowercase extensions without dot; directories always stay visible. */
  extFilter?: string[];
  /** Category tabs show matching files from every folder as one flat collection. */
  flatFiles?: boolean;
  viewMode?: FileViewMode;
  variant?: "sidebar" | "page";
}

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const TEXT_EXT = [
  "txt",
  "md",
  "mdx",
  "json",
  "csv",
  "xml",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "yaml",
  "yml",
  "toml",
  "log",
  "ics",
  "eml",
];

// The browser build has no Rust Vault. These fixtures keep the file manager
// interactive for visual review; the Tauri app always reads the selected Home.
const PREVIEW_ENTRIES: Record<string, api.DirEntry[]> = {
  ".": [
    { name: "安化黑茶", kind: "dir", size: 0 },
    { name: "比特润湾", kind: "dir", size: 0 },
    { name: "出国申请资料", kind: "dir", size: 0 },
    { name: "湖南公司证件", kind: "dir", size: 0 },
    { name: "留学", kind: "dir", size: 0 },
    { name: "轻智资料", kind: "dir", size: 0 },
    { name: "谭皓羽照片", kind: "dir", size: 0 },
    { name: "我的图片", kind: "dir", size: 0 },
    { name: "溪居科技", kind: "dir", size: 0 },
    { name: "香港量弦科技", kind: "dir", size: 0 },
    { name: "calendar", kind: "dir", size: 0 },
    { name: "mail", kind: "dir", size: 0 },
    { name: "tasks", kind: "dir", size: 0 },
    { name: "todo", kind: "dir", size: 0 },
    { name: "DepDek 2.0 产品规划.md", kind: "file", size: 38_420 },
    { name: "个人数据目录.pdf", kind: "file", size: 624_000 },
    { name: "工商大学资料.xlsx", kind: "file", size: 84_000 },
    { name: "品牌图标.png", kind: "file", size: 248_000 },
    { name: "产品介绍.mp4", kind: "file", size: 8_340_000 },
  ],
  溪居科技: [
    { name: "合同", kind: "dir", size: 0 },
    { name: "溪居科技营业执照.jpg", kind: "file", size: 196_000 },
    { name: "公司资料.md", kind: "file", size: 12_880 },
    { name: "年度预算.xlsx", kind: "file", size: 91_200 },
  ],
  "溪居科技/合同": [
    { name: "办公室租赁合同.pdf", kind: "file", size: 1_248_000 },
    { name: "供应商合同.docx", kind: "file", size: 148_000 },
  ],
  出国申请资料: [
    { name: "申请清单.md", kind: "file", size: 8_200 },
    { name: "护照扫描件.pdf", kind: "file", size: 1_120_000 },
  ],
};

const join = (parent: string, name: string) => (parent === "." ? name : `${parent}/${name}`);

const extOf = (name: string) => {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
};

const fileNameOf = (path: string) => {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
};

const folderNameOf = (path: string) => {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return "我的数据";
  return path.slice(0, separator) || "我的数据";
};

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const typeLabel = (entry: api.DirEntry) => {
  if (entry.kind === "dir") return "文件夹";
  const ext = extOf(entry.name);
  if (ext === "pdf") return "PDF 文档";
  if (["doc", "docx", "pages", "rtf"].includes(ext)) return "文字文档";
  if (["xls", "xlsx", "numbers", "csv"].includes(ext)) return "表格";
  if (["ppt", "pptx", "key"].includes(ext)) return "演示文稿";
  if (IMAGE_EXT.includes(ext)) return "图片";
  if (VIDEO_EXT.includes(ext)) return "视频";
  if (["md", "mdx"].includes(ext)) return "Markdown";
  if (TEXT_EXT.includes(ext)) return "文本";
  return ext ? `${ext.toUpperCase()} 文件` : "文件";
};

const iconFor = (entry: api.DirEntry, expanded = false): Icon => {
  if (entry.kind === "dir") return expanded ? FolderOpen : Folder;
  const ext = extOf(entry.name);
  if (ext === "pdf") return FilePdf;
  if (IMAGE_EXT.includes(ext)) return FileImage;
  if (VIDEO_EXT.includes(ext)) return FileVideo;
  if (["js", "jsx", "ts", "tsx", "json", "html", "css", "xml"].includes(ext)) return FileCode;
  if (TEXT_EXT.includes(ext) || ["doc", "docx", "pages", "rtf", "xls", "xlsx", "csv", "ppt", "pptx", "key"].includes(ext)) return FileText;
  return File;
};

const base64ToBlobUrl = (base64: string, mime: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
};

type FlatFileEntry = { entry: api.DirEntry; path: string; folder: string };

export default function FileTree({ extFilter, flatFiles = false, viewMode = "tree", variant = "sidebar" }: Props) {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({});
  const [flatEntries, setFlatEntries] = useState<FlatFileEntry[]>([]);
  const [flatLoading, setFlatLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState(".");
  const [selected, setSelected] = useState<{ path: string; entry: api.DirEntry } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

  const replacePreview = (next: Preview | null) => {
    if (objectUrlRef.current && (!next || !((next.kind === "video" || next.kind === "pdf") && next.url === objectUrlRef.current))) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (next && (next.kind === "video" || next.kind === "pdf")) objectUrlRef.current = next.url;
    setPreview(next);
  };

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const sortedVisible = (entries: api.DirEntry[]) => {
    const sorted = [...entries].sort((left, right) =>
      left.kind === right.kind ? left.name.localeCompare(right.name, "zh-CN") : left.kind === "dir" ? -1 : 1,
    );
    return extFilter
      ? sorted.filter((entry) => entry.kind === "dir" || extFilter.includes(extOf(entry.name)))
      : sorted;
  };

  const load = async (path: string, expanded = true) => {
    setNodes((previous) => ({
      ...previous,
      [path]: { ...previous[path], expanded, loading: true },
    }));

    if (browserPreview) {
      setNodes((previous) => ({
        ...previous,
        [path]: { entries: sortedVisible(PREVIEW_ENTRIES[path] ?? []), expanded, loading: false },
      }));
      return;
    }

    try {
      const { entries } = await api.vaultListDir(path);
      setNodes((previous) => ({
        ...previous,
        [path]: { entries: sortedVisible(entries), expanded, loading: false },
      }));
    } catch (error) {
      setNodes((previous) => ({
        ...previous,
        [path]: { entries: [], expanded, loading: false },
      }));
      replacePreview({ path, kind: "error", message: String(error), size: 0 });
    }
  };

  const loadFlatFiles = async () => {
    setFlatLoading(true);
    const visited = new Set<string>();
    const collect = async (path: string): Promise<FlatFileEntry[]> => {
      if (visited.has(path)) return [];
      visited.add(path);
      const entries = browserPreview
        ? PREVIEW_ENTRIES[path] ?? []
        : (await api.vaultListDir(path)).entries;
      const files: FlatFileEntry[] = [];
      for (const entry of sortedVisible(entries)) {
        const childPath = join(path, entry.name);
        if (entry.kind === "dir") {
          files.push(...await collect(childPath));
        } else if (!extFilter || extFilter.includes(extOf(entry.name))) {
          files.push({ entry, path: childPath, folder: folderNameOf(childPath) });
        }
      }
      return files;
    };

    try {
      const files = await collect(".");
      files.sort((left, right) => left.entry.name.localeCompare(right.entry.name, "zh-CN") || left.folder.localeCompare(right.folder, "zh-CN"));
      setFlatEntries(files);
    } catch (error) {
      setFlatEntries([]);
      replacePreview({ path: ".", kind: "error", message: String(error), size: 0 });
    } finally {
      setFlatLoading(false);
    }
  };

  useEffect(() => {
    if (flatFiles) void loadFlatFiles();
    else void load(".");
    // The tab key remounts this component whenever extFilter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatFiles]);

  const toggleDir = (path: string) => {
    const node = nodes[path];
    if (node?.expanded) {
      setNodes((previous) => ({ ...previous, [path]: { ...node, expanded: false } }));
    } else if (node?.entries) {
      setNodes((previous) => ({ ...previous, [path]: { ...node, expanded: true } }));
    } else {
      load(path);
    }
  };

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setSelected(null);
    setAnalysisOpen(false);
    replacePreview(null);
    if (!nodes[path]?.entries) load(path);
  };

  const openFile = async (path: string, entry: api.DirEntry) => {
    if (entry.kind === "dir") return;

    setSelected({ path, entry });
    setAnalysisOpen(false);
    const ext = extOf(path);
    const isImage = IMAGE_EXT.includes(ext);
    const isVideo = VIDEO_EXT.includes(ext);
    const isPdf = ext === "pdf";
    const isText = TEXT_EXT.includes(ext);
    const requestId = ++requestRef.current;
    replacePreview({ path, kind: "loading", size: entry.size });

    if (browserPreview) {
      if (isImage) {
        replacePreview({ path, kind: "image", dataUrl: logo, size: entry.size, sha256: "preview" });
      } else if (isText) {
        replacePreview({
          path,
          kind: "text",
          size: entry.size,
          sha256: "preview",
          content: `# ${fileNameOf(path)}\n\n这是 DepDek 浏览器演示中的本地文档预览。\n\n真实桌面应用会通过 Rust Vault 读取内容，文件读取会进入审计记录；Agent 只能使用经过授权的数据范围。`,
        });
      } else {
        replacePreview({ path, kind: "unsupported", size: entry.size });
      }
      return;
    }

    try {
      if (isImage || isVideo || isPdf) {
        const result = await api.vaultReadBinary(path);
        if (requestId !== requestRef.current) return;
        if (isImage) {
          replacePreview({
            path,
            kind: "image",
            dataUrl: `data:${result.mime};base64,${result.data_base64}`,
            size: result.size,
            sha256: result.sha256,
          });
        } else {
          const url = base64ToBlobUrl(result.data_base64, result.mime);
          replacePreview({
            path,
            kind: isPdf ? "pdf" : "video",
            url,
            size: result.size,
            sha256: result.sha256,
          });
        }
        return;
      }

      if (!isText) {
        replacePreview({ path, kind: "unsupported", size: entry.size });
        return;
      }

      const result = await api.vaultReadFile(path);
      if (requestId !== requestRef.current) return;
      replacePreview({ path, kind: "text", content: result.content, size: result.size, sha256: result.sha256 });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      const message = String(error);
      if (message.includes("E32005")) {
        replacePreview({ path, kind: "unsupported", size: entry.size });
      } else {
        replacePreview({ path, kind: "error", message, size: entry.size });
      }
    }
  };

  const closePreview = () => {
    setSelected(null);
    setAnalysisOpen(false);
    replacePreview(null);
  };

  const fileAnalysisContext = useMemo(() => {
    if (!preview) return null;
    const content = preview.kind === "text"
      ? preview.content
      : `文件：${fileNameOf(preview.path)}\n路径：${preview.path}\n类型：${extOf(preview.path).toUpperCase() || "未知"}\n大小：${formatSize(preview.size)}\n当前仅有文件元数据，未进行视觉或媒体内容识别。`;
    return {
      domain: "files" as const,
      title: `文件：${fileNameOf(preview.path)}`,
      sources: [{ label: fileNameOf(preview.path), path: preview.path, content }],
    };
  }, [preview]);

  const renderDir = (path: string, depth: number): ReactNode => {
    const node = nodes[path];
    if (!node?.entries) return node?.loading ? <div className="file-manager__loading">正在读取…</div> : null;

    return node.entries.map((entry) => {
      const childPath = join(path, entry.name);
      const child = nodes[childPath];
      const EntryIcon = iconFor(entry, child?.expanded);
      const active = selected?.path === childPath;
      return (
        <div key={childPath}>
          <button
            className={`file-manager__tree-row ${active ? "file-manager__item--selected" : ""}`}
            style={{ paddingLeft: 10 + depth * 17 }}
            onClick={() => (entry.kind === "dir" ? toggleDir(childPath) : openFile(childPath, entry))}
            title={childPath}
          >
            <span className="file-manager__disclosure">
              {entry.kind === "dir" ? child?.expanded ? <CaretDown size={12} /> : <CaretRight size={12} /> : null}
            </span>
            <EntryIcon size={17} weight={entry.kind === "dir" ? "fill" : "regular"} />
            <span className="file-manager__name">{entry.name}</span>
            {entry.kind === "file" && <small>{formatSize(entry.size)}</small>}
          </button>
          {entry.kind === "dir" && child?.expanded && renderDir(childPath, depth + 1)}
        </div>
      );
    });
  };

  const currentEntries = nodes[currentPath]?.entries ?? [];
  const breadcrumbs = useMemo(() => {
    if (currentPath === ".") return [{ label: "我的数据", path: "." }];
    const parts = currentPath.split("/");
    return [
      { label: "我的数据", path: "." },
      ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join("/") })),
    ];
  }, [currentPath]);

  const renderBreadcrumbs = () => (
    <div className="file-manager__breadcrumbs" aria-label="当前位置">
      {breadcrumbs.map((item, index) => (
        <span key={item.path}>
          {index > 0 && <CaretRight size={11} />}
          <button onClick={() => navigateTo(item.path)} title={item.path}>
            {index === 0 && <HouseLine size={14} />}
            {item.label}
          </button>
        </span>
      ))}
      <small>{currentEntries.length} 项</small>
    </div>
  );

  const activateEntry = (entry: api.DirEntry) => {
    const path = join(currentPath, entry.name);
    if (entry.kind === "dir") navigateTo(path);
    else openFile(path, entry);
  };

  const renderList = () => (
    <div className={`file-manager__list ${flatFiles ? "file-manager__list--flat" : ""}`} role="table" aria-label="文件列表">
      <div className="file-manager__list-head" role="row">
        <span role="columnheader">名称</span>
        {flatFiles && <span role="columnheader">所在文件夹</span>}
        <span role="columnheader">类型</span>
        <span role="columnheader">大小</span>
      </div>
      {(flatFiles ? flatEntries : currentEntries).map((item) => {
        const flatItem = flatFiles ? item as FlatFileEntry : undefined;
        const entry = flatItem?.entry ?? item as api.DirEntry;
        const path = join(currentPath, entry.name);
        const flatPath = flatItem?.path ?? path;
        const EntryIcon = iconFor(entry);
        const active = selected?.path === flatPath;
        return (
          <button
            key={flatPath}
            className={`file-manager__list-row ${active ? "file-manager__item--selected" : ""}`}
            onClick={() => flatFiles ? openFile(flatPath, entry) : activateEntry(entry)}
            role="row"
            title={flatPath}
          >
            <span className="file-manager__list-name" role="cell">
              <EntryIcon size={18} weight={entry.kind === "dir" ? "fill" : "regular"} />
              <b>{entry.name}</b>
            </span>
            {flatItem && <span className="file-manager__location" role="cell" title={flatItem.folder}>{flatItem.folder}</span>}
            <span role="cell">{typeLabel(entry)}</span>
            <span role="cell">{entry.kind === "file" ? formatSize(entry.size) : "—"}</span>
          </button>
        );
      })}
    </div>
  );

  const renderPreviewGrid = () => (
    <div className="file-manager__grid" aria-label="文件预览视图">
      {(flatFiles ? flatEntries : currentEntries).map((item) => {
        const flatItem = flatFiles ? item as FlatFileEntry : undefined;
        const entry = flatItem?.entry ?? item as api.DirEntry;
        const path = join(currentPath, entry.name);
        const flatPath = flatItem?.path ?? path;
        const EntryIcon = iconFor(entry);
        const active = selected?.path === flatPath;
        return (
          <button
            key={flatPath}
            className={`file-manager__grid-card ${active ? "file-manager__item--selected" : ""}`}
            onClick={() => flatFiles ? openFile(flatPath, entry) : activateEntry(entry)}
            title={flatPath}
          >
            <span className={`file-manager__thumbnail file-manager__thumbnail--${entry.kind}`}>
              <EntryIcon size={entry.kind === "dir" ? 38 : 34} weight={entry.kind === "dir" ? "fill" : "duotone"} />
              {entry.kind === "file" && <small>{extOf(entry.name).toUpperCase() || "FILE"}</small>}
            </span>
            <b>{entry.name}</b>
            <small>{entry.kind === "file" ? `${typeLabel(entry)} · ${formatSize(entry.size)}` : "文件夹"}</small>
            {flatItem && <small className="file-manager__location">{flatItem.folder}</small>}
          </button>
        );
      })}
    </div>
  );

  const renderBrowser = () => {
    if (flatFiles) {
      return (
        <>
          <div className="file-manager__flat-summary"><b>{flatEntries.length} 个文件</b><span>已从所有文件夹汇总，所在文件夹显示在文件名后</span></div>
          <div className="file-manager__flat-scroll">
            {flatLoading ? <div className="file-manager__loading">正在汇总文件…</div> : viewMode === "preview" ? renderPreviewGrid() : renderList()}
          </div>
        </>
      );
    }
    if (viewMode === "tree") {
      return <div className="file-manager__tree">{renderDir(".", 0)}</div>;
    }
    return (
      <>
        {renderBreadcrumbs()}
        <div className="file-manager__directory">
          {nodes[currentPath]?.loading ? (
            <div className="file-manager__loading">正在读取文件夹…</div>
          ) : viewMode === "list" ? renderList() : renderPreviewGrid()}
        </div>
      </>
    );
  };

  const previewMeta = (item: Preview) => (
    <div className="file-manager__preview-meta">
      <span>{formatSize(item.size)}</span>
      {"sha256" in item && item.sha256 && <span>SHA-256 {item.sha256.slice(0, 10)}</span>}
      <span>本地 Home</span>
    </div>
  );

  const renderPreviewBody = (item: Preview): ReactNode => {
    switch (item.kind) {
      case "loading":
        return <div className="file-manager__preview-state"><File size={34} /><b>正在打开文件…</b></div>;
      case "text":
        return <><pre className="file-manager__text-preview">{item.content}</pre>{previewMeta(item)}</>;
      case "image":
        return <><div className="file-manager__media-preview"><img src={item.dataUrl} alt={item.path} /></div>{previewMeta(item)}</>;
      case "video":
        return <><div className="file-manager__media-preview"><video src={item.url} controls /></div>{previewMeta(item)}</>;
      case "pdf":
        return <><iframe className="file-manager__pdf-preview" title={`预览 ${item.path}`} src={item.url} />{previewMeta(item)}</>;
      case "error":
        return <div className="file-manager__preview-state file-manager__preview-state--error"><Info size={34} /><b>无法打开文件</b><span>{item.message}</span></div>;
      case "unsupported": {
        const ext = extOf(item.path).toUpperCase() || "FILE";
        return <div className="file-manager__preview-state"><FileText size={38} weight="duotone" /><b>{ext} 文件</b><span>此格式暂不支持内置预览，文件仍保留在本地 Home 中。</span>{previewMeta(item)}</div>;
      }
    }
  };

  return (
    <div className={`file-manager file-manager--${variant}`}>
      <section className="file-manager__browser">{renderBrowser()}</section>
      <aside className={`file-manager__preview ${preview ? "file-manager__preview--open" : ""}`} aria-label="文件预览">
        {preview ? (
          <>
            <header>
              <div>
                <b title={preview.path}>{fileNameOf(preview.path)}</b>
                <small title={preview.path}>{preview.path}</small>
              </div>
              {fileAnalysisContext && preview.kind !== "loading" && <button className="file-manager__preview-ai" onClick={() => setAnalysisOpen((current) => !current)} aria-pressed={analysisOpen}><Sparkle size={14} />AI 分析</button>}
              <button onClick={closePreview} title="关闭预览" aria-label="关闭预览"><X size={16} /></button>
            </header>
            <div className="file-manager__preview-body">{renderPreviewBody(preview)}{analysisOpen && fileAnalysisContext && <AIAnalysisPanel context={fileAnalysisContext} compact />}</div>
          </>
        ) : (
          <div className="file-manager__preview-empty">
            <FileText size={38} weight="duotone" />
            <b>选择文件查看预览</b>
            <span>文本、图片、视频和 PDF 均在本地打开，读取操作会写入审计记录。</span>
          </div>
        )}
      </aside>
    </div>
  );
}
