// Film-only fixture: actual UI components, entirely synthetic in-memory service.
// Does not read Home, authenticate a user, call models, or persist imports.
import React from "react";
import { createRoot } from "react-dom/client";
import DataFilesPanel from "../../src/components/DataFilesPanel";
import "../../src/styles.css";
import "../../src/components/depdek-home.css";

const libraryId = "f".repeat(64);
const examples = [
  { name: "洗碗机使用说明.md", category: "documents", content: "# 使用说明（虚构演示）\n\n滤网清洗请按对应设备原厂说明操作。\n文件仍在这里，随时可以核对出处。" },
  { name: "第一次看海.png", category: "photos", content: "Synthetic photo placeholder" },
  { name: "周末露营.mp4", category: "videos", content: "Synthetic media placeholder" },
  { name: "营地预订确认.eml", category: "mail", content: "From: example@example.invalid\nSubject: 虚构预订\n\n仅用于品牌影片界面素材。" },
  { name: "家庭资料备份.zip", category: "other", content: "Synthetic archive placeholder" },
];
async function start() {
  const rows = await Promise.all(examples.map(async (item, index) => {
    const data = new TextEncoder().encode(item.content);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");
    return { ...item, file_id: String(index + 1).repeat(32), path: `我的资料/${String(index + 1).repeat(32)}/${item.name}`, original_path: item.name, sha256, size: data.length, detected_by: "extension", modified_ms: Date.parse("2026-10-19T10:00:00+08:00"), indexed_at_ms: Date.parse("2026-10-19T10:00:00+08:00") };
  }));
  const summary = { library_id: libraryId, coverage: "imports", indexed_at_ms: Date.now(), total: rows.length, total_bytes: rows.reduce((sum, item) => sum + item.size, 0), skipped: 0, categories: Object.fromEntries(["photos", "documents", "videos", "mail", "other"].map((category) => [category, 1])) };
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async (command: string, args: any = {}) => {
    if (command === "file_index_query") {
      const filter = args.filter ?? {}, query = (filter.query ?? "").toLowerCase();
      const items = rows.filter((item) => (!filter.category || item.category === filter.category) && (!query || item.path.toLowerCase().includes(query) || item.sha256.startsWith(query)));
      return { items: items.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100)), total: items.length, summary };
    }
    if (command === "vault_list_dir") return { entries: [] };
    if (command === "vault_read_file") {
      const item = rows.find((row) => row.path === args.path); if (!item) throw new Error("Synthetic file not found");
      return { content: item.content, size: item.size, sha256: item.sha256 };
    }
    throw new Error("Film-only fixture: this operation is not connected");
  } } });
  createRoot(document.getElementById("root")!).render(<div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fbf8f0" }}><div style={{ padding: "8px 20px", fontSize: 12, color: "#77867a", borderBottom: "1px solid #e2e4d9" }}>品牌片素材 · 真实组件 / 虚构资料 · 无真实文件、模型或账号连接</div><DataFilesPanel variant="page" /></div>);
}
void start();
