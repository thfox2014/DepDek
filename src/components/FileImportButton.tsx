import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, CircleNotch, Plus, WarningCircle, X } from "@phosphor-icons/react";
import * as api from "../api";
import { announceFileLibrary, importError, prepareImports, runImports, type ImportEntry, type ImportService } from "../lib/fileLibrary";
import "./file-library.css";

export default function FileImportButton({ service, resolveLibrary, onProgress, label = "添加资料", accept }: {
  service?: ImportService; resolveLibrary?: () => Promise<string>; onProgress?: (lines: string[]) => void; label?: string; accept?: string;
}) {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const importer = service ?? (native ? api.fileLibraryImport : undefined);
  const library = resolveLibrary ?? (native ? async () => (await api.fileIndexQuery({ limit: 1 })).summary.library_id ?? "" : undefined);
  const input = useRef<HTMLInputElement>(null), alive = useRef(true), operation = useRef(false);
  const callbacks = useRef(onProgress); callbacks.current = onProgress;
  const [entries, setEntries] = useState<ImportEntry[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const save = async (items: ImportEntry[]) => {
    if (!importer || operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try {
      await runImports(items, importer, {
        active: () => alive.current,
        changed: (next) => {
          if (!alive.current) return;
          setEntries(next);
          const saved = next.filter((item) => item.state === "saved").length;
          callbacks.current?.([`正在收纳所选资料 · ${saved} / ${next.length}`, "在本机保存副本并自动分类", "原始文件保持原位"]);
        },
        saved: (result) => announceFileLibrary(result.summary),
      });
      if (alive.current) {
        const saved = items.filter((item) => item.state === "saved").length;
        const failed = items.filter((item) => item.state === "failed").length;
        callbacks.current?.([`已收纳 ${saved} 份资料${failed ? `，${failed} 份未完成` : ""}`, failed ? "未完成项可以重试，已保存的资料不会重复添加" : "已按文件类型分类，可以按名称、路径或 SHA 查找", "资料保存在本机，未调用模型"]);
      }
    } finally { operation.current = false; if (alive.current) setBusy(false); }
  };
  const choose = async (files: File[]) => {
    if (!files.length || !library || operation.current) return;
    operation.current = true; setBusy(true); setError(""); setEntries([]);
    let libraryId: string;
    try { libraryId = await library(); }
    catch (failure) {
      if (alive.current) { setError(importError(failure)); setBusy(false); }
      operation.current = false; return;
    }
    operation.current = false;
    if (!alive.current) return;
    try { const next = prepareImports(files, libraryId); setEntries(next); await save(next); }
    catch (failure) { setError(String(failure instanceof Error ? failure.message : failure)); setBusy(false); }
  };
  const saved = entries.filter((item) => item.state === "saved").length;
  const failed = entries.filter((item) => item.state === "failed");
  return <div className="file-import">
    <input ref={input} type="file" multiple accept={accept} hidden disabled={busy || !importer || !library} aria-label="选择要添加的资料" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void choose(files); }} />
    <button className="file-import__add" type="button" disabled={busy || !importer || !library} title={importer && library ? "所选文件会在本机保存副本并自动分类；单文件不超过 64 MB" : "此浏览器预览未连接本机资料服务"} onClick={() => input.current?.click()}>{busy ? <CircleNotch size={17} className="room-spin" /> : <Plus size={17} />}<span>{busy ? (entries.length ? `收纳中 ${saved}/${entries.length}` : "正在连接空间…") : label}</span></button>
    {(error || entries.length > 0) && <div className={`file-import__feedback${failed.length || error ? " has-error" : ""}`} role="status" aria-live="polite">
      <span>{busy ? <CircleNotch size={14} className="room-spin" /> : (failed.length || error ? <WarningCircle size={14} /> : <Check size={14} />)}{error || (busy ? "正在本机保存、分类…" : `已存好 ${saved} 份${failed.length ? `，${failed.length} 份未完成` : "，现在就能找"}`)}</span>
      {failed.length > 0 && !busy && <button type="button" onClick={() => void save(entries)}><ArrowClockwise size={13} />重试未完成的资料</button>}
      {!busy && <button type="button" aria-label="收起收纳结果" onClick={() => { setEntries([]); setError(""); }}><X size={13} /></button>}
      {failed.length > 0 && <details><summary>查看未完成项</summary>{failed.map((item) => <p key={item.operationId}><b>{item.file.name}</b>{item.error}</p>)}</details>}
    </div>}
  </div>;
}
