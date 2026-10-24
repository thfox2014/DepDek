import type * as api from "../api";

export type DocumentServices = Pick<typeof api, "fileIndexQuery" | "documentLibraryState" | "documentSearch" | "documentPreview" | "documentFavoriteSet" | "documentCollectionPut" | "documentBundleExport"> & Partial<Pick<typeof api, "fileLibraryImport" | "contentAnnotationGet" | "contentAnalyze" | "contentAnnotationUpdate" | "settingsGet">>;
export const documentReference = (file: api.FileIndexRecord): api.DocumentReference => ({ path: file.path, sha256: file.sha256 });
export const documentKey = (reference: api.DocumentReference) => `${reference.path}:${reference.sha256}`;
export const documentName = (reference: api.DocumentReference) => reference.path.split("/").at(-1) ?? reference.path;

export function toggleDocumentReference(selection: Record<string, api.DocumentReference>, reference: api.DocumentReference, limit: number) {
  const next = { ...selection }, key = documentKey(reference);
  if (next[key]) { delete next[key]; return next; }
  for (const [oldKey, old] of Object.entries(next)) if (old.path === reference.path) delete next[oldKey];
  if (Object.keys(next).length < limit) next[key] = reference;
  return next;
}

/** Filename hints, not semantic conclusions. User can edit every group. */
export function suggestedDocumentGroup(file: Pick<api.FileIndexRecord, "name">): string {
  if (/发票|收据|凭证|receipt|invoice/i.test(file.name)) return "购买凭证";
  if (/报价|预算|方案|quote|proposal/i.test(file.name)) return "方案与报价";
  if (/尺寸|图纸|测量|drawing/i.test(file.name)) return "测量与图纸";
  if (/说明|手册|manual|guide/i.test(file.name)) return "使用说明";
  if (/合同|协议|contract|agreement/i.test(file.name)) return "约定文书";
  return "待归类";
}

export function documentDuplicates(files: api.FileIndexRecord[]) {
  const groups = new Map<string, api.FileIndexRecord[]>();
  for (const file of files) groups.set(file.sha256, [...(groups.get(file.sha256) ?? []), file]);
  return [...groups.values()].filter((items) => items.length > 1);
}

export function documentQuestionQuery(text: string): string | undefined {
  const explicit = text.slice(0, 4096).match(/(?:找资料|查资料|搜索资料|找文档|搜索文档)\s*[:：]\s*([^。！？\n]{1,120})/);
  if (explicit) return explicit[1].trim();
  const quoted = text.slice(0, 4096).match(/[「“"]([^」”"\n]{1,120})[」”"]/);
  if (quoted && /找|查|搜索/.test(text)) return quoted[1].trim();
  return undefined;
}

export function documentLibraryError(error: unknown): string {
  const value = String(error);
  if (value.includes("缺项最多")) return value.replace(/^Error:\s*/, "");
  if (value.includes("invalid bundle receipt")) return "资料包回执校验失败，未发起下载，请重试。";
  if (value.includes("Home changed")) return "空间已切换，请重新打开资料；没有将旧请求写入新空间。";
  if (value.includes("revision conflict")) return "资料记录已被其它窗口更新，请更新列表后重试，未覆盖新记录。";
  if (value.includes("changed") || value.includes("not indexed")) return "原文件或索引已经变化，请在工作台核对并显式更新索引后重试。";
  if (value.includes("E32006")) return "空间已锁定，请先登录。";
  if (value.includes("E32003")) return "超过本次处理上限：单文件 16 MB，资料包共 64 MB、最多 50 份。";
  if (value.includes("E32005")) return "这份资料不是 UTF-8 文本，可保留原件并加入资料包。";
  if (value.includes("E32001")) return "资料来源不安全或超出当前空间，已停止处理。";
  return "资料服务暂时不可用，请重试；原件未被修改。";
}

/** Refuse mixed snapshots rather than displaying another Home's results. */
export async function loadDocumentPage(service: DocumentServices, offset: number, expectedLibrary?: string) {
  const [catalog, state] = await Promise.all([service.fileIndexQuery({ category: "documents", offset, limit: 50 }), service.documentLibraryState()]);
  if (!state.library_id || catalog.summary.library_id !== state.library_id || expectedLibrary && state.library_id !== expectedLibrary) throw new Error("Home changed");
  return { catalog, state };
}

export function collectionInput(libraryId: string, record: api.DocumentCollection): api.DocumentCollectionInput {
  const { revision, updated_at_ms: _updated, ...content } = record;
  return { ...content, libraryId, expectedRevision: revision };
}

/** A bounded content comparison, not a semantic version decision. */
export function documentLineChanges(left: string, right: string) {
  const a = left.split(/\r?\n/).slice(0, 3000), b = right.split(/\r?\n/).slice(0, 3000);
  const as = new Set(a), bs = new Set(b);
  return { removed: a.filter((line) => line.trim() && !bs.has(line)).slice(0, 80), added: b.filter((line) => line.trim() && !as.has(line)).slice(0, 80), truncated: left.split("\n").length > 3000 || right.split("\n").length > 3000 };
}

export function missingDocumentItems(text: string): string[] {
  const items = [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  if (items.length > 30 || items.some((value) => value.length > 120 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error("缺项最多 30 条，每条 120 字以内。");
  return items;
}

export async function verifyDocumentDownload(result: api.ReadBinaryResult): Promise<Uint8Array> {
  if (result.mime !== "application/gzip" || result.size > 65 * 1024 * 1024 || result.data_base64.length > 92 * 1024 * 1024) throw new Error("invalid bundle receipt");
  const bytes = Uint8Array.from(atob(result.data_base64), (char) => char.charCodeAt(0));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== result.size || hash !== result.sha256 || bytes[0] !== 31 || bytes[1] !== 139) throw new Error("invalid bundle receipt");
  return bytes;
}
