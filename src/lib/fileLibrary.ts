import type { FileIndexSummary, FileLibraryImportInput, FileLibraryImportResult } from "../api";

export const FILE_LIBRARY_CHANGED = "jiaho:file-library-changed";
export const MAX_IMPORT_FILES = 100;
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export type ImportService = (input: FileLibraryImportInput) => Promise<FileLibraryImportResult>;
export type ImportEntry = { file: File; libraryId: string; operationId: string; state: "pending" | "saving" | "saved" | "failed"; error?: string };

export function prepareImports(files: File[], libraryId: string): ImportEntry[] {
  if (!files.length || files.length > MAX_IMPORT_FILES) throw new Error("一次最多添加 100 份资料，请分批选择。");
  if (files.some((file) => file.size > MAX_IMPORT_BYTES)) throw new Error("本次添加支持单文件 64 MB 以内，大文件请先保留在原处。");
  if (!/^[0-9a-f]{64}$/.test(libraryId)) throw new Error("还没有连接到资料空间，请登录后重试。");
  return files.map((file) => ({ file, libraryId, operationId: crypto.randomUUID().replaceAll("-", ""), state: "pending" }));
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onabort = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string" || !value.includes(",")) reject(new Error("FILE_READ_FAILED"));
      else resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function importError(error: unknown): string {
  const value = String(error);
  if (value.includes("Home changed")) return "空间已切换，请在当前空间重新选择资料；原空间资料保持不动。";
  if (value.includes("E32006")) return "空间已锁定，请登录后重试。";
  if (value.includes("E32003")) return "这份文件超过了本次添加的大小上限。";
  if (value.includes("E32001") || value.includes("E32602")) return "文件名、保存位置或已有副本发生变化，请检查后重新选择。";
  if (value.includes("FILE_READ_FAILED")) return "没有读到所选文件，请检查文件是否仍在原处。";
  return "保存或登记尚未完成，可重试；已经存好的资料不会重复添加。";
}

/** Sequential, bounded reads; retain IDs when retrying only failed items. */
export async function runImports(entries: ImportEntry[], service: ImportService, options: {
  changed: (entries: ImportEntry[]) => void;
  saved: (result: FileLibraryImportResult) => void;
  active?: () => boolean;
  read?: (file: File) => Promise<string>;
}) {
  for (const entry of entries) {
    if (options.active?.() === false) break;
    if (entry.state === "saved") continue;
    entry.state = "saving"; entry.error = undefined; options.changed([...entries]);
    try {
      const dataBase64 = await (options.read ?? readBase64)(entry.file);
      if (options.active?.() === false) { entry.state = "pending"; break; }
      const result = await service({ libraryId: entry.libraryId, operationId: entry.operationId, name: entry.file.name, dataBase64 });
      if (result.status !== "indexed" || result.file.file_id !== entry.operationId
        || result.summary.library_id !== entry.libraryId
        || result.file.size !== entry.file.size || !/^[0-9a-f]{64}$/.test(result.file.sha256)) throw new Error("INVALID_IMPORT_RECEIPT");
      entry.state = "saved"; options.saved(result);
    } catch (error) { entry.state = "failed"; entry.error = importError(error); }
    options.changed([...entries]);
  }
}

export function announceFileLibrary(summary: FileIndexSummary) {
  window.dispatchEvent(new CustomEvent(FILE_LIBRARY_CHANGED, { detail: summary }));
}
