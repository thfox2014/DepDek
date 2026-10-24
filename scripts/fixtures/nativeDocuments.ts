// In-memory examples for the *same* component used by native Tauri.
// No disk, model, login, Home or external API access.
import type * as api from "../../src/api";
import type { DocumentServices } from "../../src/lib/documentLibrary";

export function samplePdf(): string {
  const stream = "BT /F1 20 Tf 40 160 Td (Jiaho - local document preview) Tj 0 -35 Td /F1 12 Tf (Synthetic sample. No household files.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return pdf;
}
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => { let result = ""; for (let index = 0; index < bytes.length; index += 16384) result += String.fromCharCode(...bytes.subarray(index, index + 16384)); return btoa(result); };
const textBytes = (text: string) => new TextEncoder().encode(text);
const identity = "d".repeat(64);

export function nativeDocumentExamples(initialState: "ready" | "empty" | "error" = "ready"): DocumentServices {
  const content: Record<string, Uint8Array> = {};
  const favorites: api.DocumentFavorite[] = [], collections: api.DocumentCollection[] = [];
  const ready = Promise.all((initialState === "empty" ? [] : [
    ["洗碗机使用说明.md", "# 示例使用说明\n\n滤网：先关闭电源，再按对应设备的原厂说明拆装清洗。\n这是虚构资料，不是你家设备的操作指南。"],
    ["厨房改造报价.txt", "厨房改造（示例）\n台面：原方案\n插座：2组\n预算：21800元（虚构）"],
    ["厨房改造报价-修订版.txt", "厨房改造（示例）\n台面：一体式方案\n插座：4组\n预算：23900元（虚构）"],
    ["厨房改造报价-副本.txt", "厨房改造（示例）\n台面：原方案\n插座：2组\n预算：21800元（虚构）"],
    ["营地预订确认.md", "# 露营预订（虚构）\n周六入住，周日离开。没有真实订单或付款信息。"],
    ["露营装备清单.md", "# 露营装备（示例）\n帐篷\n睡袋\n餐具\n照明\n营地入场说明尚未添加。"],
    ["PDF阅读示例.pdf", samplePdf()],
  ]).map(async ([name, text], index) => {
    const path = `示例资料/${name}`, bytes = textBytes(text); content[path] = bytes;
    return { path, original_path: name, name, sha256: await hash(bytes), category: "documents", detected_by: name.endsWith(".pdf") ? "signature" : "extension", size: bytes.length, modified_ms: 1792324800000 + index, indexed_at_ms: 1792324800000 + index } as api.FileIndexRecord;
  }));
  let failed = initialState === "error";
  const check = (library: string) => { if (library !== identity) throw new Error("Home changed"); };
  const summary = (files: api.FileIndexRecord[]): api.FileIndexSummary => ({ library_id: identity, coverage: "imports", indexed_at_ms: 1792324800000, total: files.length, total_bytes: files.reduce((sum, file) => sum + file.size, 0), skipped: 0, categories: { documents: files.length, photos: 0, videos: 0, mail: 0, other: 0 } });
  const source = async (reference: api.DocumentReference) => { const file = (await ready).find((file) => file.path === reference.path && file.sha256 === reference.sha256); if (!file) throw new Error("document changed"); return { file, bytes: content[file.path] }; };
  return {
    fileIndexQuery: async (filter = {}) => {
      if (failed) { failed = false; throw new Error("synthetic connection failure"); }
      const all = await ready, matches = all.filter((file) => (!filter.sha256 || file.sha256 === filter.sha256) && (!filter.query || file.path.includes(filter.query)));
      return structuredClone({ items: matches.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50)), total: matches.length, summary: summary(all) });
    },
    documentLibraryState: async () => ({ library_id: identity, favorites: structuredClone(favorites), collections: structuredClone(collections) }),
    documentPreview: async ({ libraryId, reference }) => {
      check(libraryId); const { file, bytes } = await source(reference), pdf = file.name.endsWith(".pdf");
      return { kind: pdf ? "pdf" : "text", content: pdf ? undefined : new TextDecoder().decode(bytes), data_base64: pdf ? base64(bytes) : undefined, size: bytes.length, sha256: file.sha256, truncated: false };
    },
    documentSearch: async ({ libraryId, query }) => {
      check(libraryId); const files = await ready;
      return { items: files.flatMap((file) => { const index = new TextDecoder().decode(content[file.path]).split("\n").findIndex((line) => line.includes(query)); return file.name.includes(query) || index >= 0 ? [{ file, line: index >= 0 ? index + 1 : null, snippet: index >= 0 ? new TextDecoder().decode(content[file.path]).split("\n")[index] : null }] : []; }), catalog_total: files.length, body_examined: files.filter((file) => !file.name.endsWith(".pdf")).length, skipped: 1, incomplete: true };
    },
    documentFavoriteSet: async ({ libraryId, reference, favorite, expectedRevision }) => {
      check(libraryId); await source(reference);
      const index = favorites.findIndex((item) => item.path === reference.path), previous = favorites[index];
      if ((previous?.revision ?? 0) !== expectedRevision) throw new Error("revision conflict");
      const result = { ...reference, favorite, revision: expectedRevision + 1, updated_at_ms: Date.now() };
      if (index >= 0) favorites[index] = result; else favorites.push(result);
      return structuredClone(result);
    },
    documentCollectionPut: async (input) => {
      check(input.libraryId); const index = collections.findIndex((item) => item.id === input.id), previous = collections[index];
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Error("revision conflict");
      if (input.status === "active") await Promise.all(input.references.map(source));
      const { libraryId: _library, expectedRevision, ...fields } = input, result = { ...fields, revision: expectedRevision + 1, updated_at_ms: Date.now() };
      if (index >= 0) collections[index] = structuredClone(result); else collections.push(structuredClone(result));
      return structuredClone(result);
    },
    documentBundleExport: async ({ libraryId, references, title, missing }) => {
      check(libraryId);
      const selected = await Promise.all(references.map(source));
      const manifest = { title, missing, references: references.map((reference, index) => ({ ...reference, member: `${index + 1}.document${selected[index].file.name.endsWith(".pdf") ? ".pdf" : ".txt"}` })) };
      const entries = [...selected.map((item, index) => ({ name: manifest.references[index].member, bytes: item.bytes })), { name: "manifest.json", bytes: textBytes(JSON.stringify(manifest, null, 2)) }];
      const chunks: Uint8Array[] = [];
      for (const { name, bytes } of entries) {
        const header = new Uint8Array(512), put = (start: number, value: string) => header.set(textBytes(value), start);
        put(0, name); put(100, "0000600\0"); put(108, "0000000\0"); put(116, "0000000\0"); put(124, bytes.length.toString(8).padStart(11, "0") + "\0"); put(136, "00000000000\0"); header.fill(32, 148, 156); put(156, "0"); put(257, "ustar\0"); put(263, "00");
        put(148, header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ");
        chunks.push(header, bytes, new Uint8Array((512 - bytes.length % 512) % 512));
      }
      chunks.push(new Uint8Array(1024));
      const compressed = new Uint8Array(await new Response(new Blob(chunks).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      return { data_base64: base64(compressed), mime: "application/gzip", size: compressed.length, sha256: await hash(compressed) };
    },
    fileLibraryImport: async (input) => {
      check(input.libraryId); const files = await ready, existing = files.find((file) => file.file_id === input.operationId);
      if (existing) return { file: existing, summary: summary(files), status: "indexed" };
      const bytes = Uint8Array.from(atob(input.dataBase64), (char) => char.charCodeAt(0)), path = `示例资料/${input.operationId}/${input.name}`;
      const file: api.FileIndexRecord = { file_id: input.operationId, name: input.name, path, original_path: input.name, sha256: await hash(bytes), category: "documents", detected_by: "extension", size: bytes.length, modified_ms: Date.now(), indexed_at_ms: Date.now() };
      content[path] = bytes; files.push(file);
      return { file, summary: summary(files), status: "indexed" };
    },
  };
}
