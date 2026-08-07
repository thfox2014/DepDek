import { useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../api";

interface TreeNode {
  entries?: api.DirEntry[];
  expanded: boolean;
  loading: boolean;
}

// Preview pane state, discriminated by kind.
type Preview =
  | { path: string; kind: "loading" }
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "image"; dataUrl: string; size: number; sha256: string }
  | { path: string; kind: "video"; url: string; size: number; sha256: string }
  | { path: string; kind: "error"; message: string }
  | { path: string; kind: "unsupported" };

interface Props {
  // Lowercase extensions without dot; only files are filtered, dirs always show.
  extFilter?: string[];
}

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

const join = (parent: string, name: string) => (parent === "." ? name : `${parent}/${name}`);

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

const formatSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const base64ToBlobUrl = (base64: string, mime: string) => {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
};

export default function FileTree({ extFilter }: Props) {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  // Guards against out-of-order async preview loads (click A, then B quickly).
  const requestRef = useRef(0);

  // Replaces the preview, revoking any previous video object URL.
  const replacePreview = (p: Preview | null) => {
    if (videoUrlRef.current && (!p || p.kind !== "video" || p.url !== videoUrlRef.current)) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    if (p?.kind === "video") videoUrlRef.current = p.url;
    setPreview(p);
  };

  // Revoke the object URL on unmount. StrictMode replays this once at mount,
  // when no URL exists yet, so it is safe.
  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  const load = async (path: string) => {
    setNodes((prev) => ({ ...prev, [path]: { ...prev[path], expanded: true, loading: true } }));
    try {
      const { entries } = await api.vaultListDir(path);
      const sorted = [...entries].sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
      );
      const visible = extFilter
        ? sorted.filter((e) => e.kind === "dir" || extFilter.includes(extOf(e.name)))
        : sorted;
      setNodes((prev) => ({ ...prev, [path]: { entries: visible, expanded: true, loading: false } }));
    } catch (e) {
      setNodes((prev) => ({ ...prev, [path]: { entries: [], expanded: true, loading: false } }));
      replacePreview({ path, kind: "error", message: String(e) });
    }
  };

  useEffect(() => {
    load(".");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDir = (path: string) => {
    const node = nodes[path];
    if (node?.expanded) {
      setNodes((prev) => ({ ...prev, [path]: { ...node, expanded: false } }));
    } else if (node?.entries) {
      setNodes((prev) => ({ ...prev, [path]: { ...node, expanded: true } }));
    } else {
      load(path);
    }
  };

  const openFile = async (path: string) => {
    const ext = extOf(path);
    const isImage = IMAGE_EXT.includes(ext);
    const isVideo = VIDEO_EXT.includes(ext);
    const requestId = ++requestRef.current;
    replacePreview({ path, kind: "loading" });
    try {
      if (isImage || isVideo) {
        const res = await api.vaultReadBinary(path);
        if (requestId !== requestRef.current) return;
        if (isImage) {
          replacePreview({
            path,
            kind: "image",
            dataUrl: `data:${res.mime};base64,${res.data_base64}`,
            size: res.size,
            sha256: res.sha256,
          });
        } else {
          replacePreview({
            path,
            kind: "video",
            url: base64ToBlobUrl(res.data_base64, res.mime),
            size: res.size,
            sha256: res.sha256,
          });
        }
        return;
      }
      const res = await api.vaultReadFile(path);
      if (requestId !== requestRef.current) return;
      replacePreview({ path, kind: "text", content: res.content });
    } catch (e) {
      if (requestId !== requestRef.current) return;
      const msg = String(e);
      // Binary files are rejected by the vault as non-UTF-8 (E32005).
      if (msg.includes("E32005")) {
        replacePreview({ path, kind: "unsupported" });
      } else {
        replacePreview({ path, kind: "error", message: msg });
      }
    }
  };

  const renderDir = (path: string, depth: number): ReactNode => {
    const node = nodes[path];
    if (!node?.entries) return null;
    return node.entries.map((entry) => {
      const childPath = join(path, entry.name);
      const child = nodes[childPath];
      return (
        <div key={childPath}>
          <div
            className={`tree-row ${entry.kind}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (entry.kind === "dir" ? toggleDir(childPath) : openFile(childPath))}
          >
            <span className="tree-icon">{entry.kind === "dir" ? (child?.expanded ? "▾" : "▸") : "·"}</span>
            <span className="tree-name">{entry.name}</span>
          </div>
          {entry.kind === "dir" && child?.expanded && renderDir(childPath, depth + 1)}
        </div>
      );
    });
  };

  const renderPreviewBody = (p: Preview): ReactNode => {
    switch (p.kind) {
      case "loading":
        return <p className="hint">加载中…</p>;
      case "text":
        return <pre>{p.content}</pre>;
      case "image":
        return (
          <div className="file-preview__media">
            <img className="file-preview__image" src={p.dataUrl} alt={p.path} />
            <span className="file-preview__meta">
              {formatSize(p.size)} · sha256 {p.sha256.slice(0, 8)}
            </span>
          </div>
        );
      case "video":
        return (
          <div className="file-preview__media">
            <video className="file-preview__video" src={p.url} controls />
            <span className="file-preview__meta">
              {formatSize(p.size)} · sha256 {p.sha256.slice(0, 8)}
            </span>
          </div>
        );
      case "error":
        return <pre className="error-text">{p.message}</pre>;
      case "unsupported":
        return <pre className="hint">暂不支持预览二进制文件</pre>;
    }
  };

  return (
    <div className="file-tree">
      <div className="tree-scroll">{renderDir(".", 0)}</div>
      {preview && (
        <div className="file-preview">
          <div className="preview-header">
            <span className="preview-path" title={preview.path}>
              {preview.path}
            </span>
            <button onClick={() => replacePreview(null)}>×</button>
          </div>
          {renderPreviewBody(preview)}
        </div>
      )}
      <div className="tree-hint">文件操作由审计接口记录</div>
    </div>
  );
}
