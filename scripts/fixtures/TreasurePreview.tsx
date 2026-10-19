// Explicitly synthetic UI fixture. No native APIs, models, or real family files.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Room from "../../src/components/DepDekAiOsShell";
import type { ChatBlock } from "../../src/App";
import type { PhotoLibraryItem, PhotoLibraryResult } from "../../src/api";
import type { PhotoServices } from "../../src/components/TreasurePanel";
import { ensureAiOsRoom, ROOM_AGENT_ID } from "../../src/lib/aiOsRoom";
import { BUILTIN_PROVIDER } from "../../src/lib/aiOsSetup";
import { suggestTreasureScene } from "../../src/lib/treasure";
import seaside from "./treasure-assets/sea-child.png";
import teenager from "./treasure-assets/growing-teen.png";
import newborn from "./treasure-assets/newborn.png";
import "../../src/styles.css";

const images = [seaside, seaside, newborn, teenager];
let library: PhotoLibraryItem[] = [
  ["2012-07-16-第一次看海.png", "2012-07-16", "第一次看海", "三亚", "1"],
  ["2012-07-16-看海副本.png", "2012-07-16", "第一次看海", "三亚", "1"],
  ["2008-02-12-来到这个家.png", "2008-02-12", "来到这个家", "家里", "2"],
  ["2026-08-20-要出发了.png", "2026-08-20", "要出发了", "杭州", "3"],
].map(([name, date, event, place, hash]) => ({
  file: { path: `photos/${name}`, original_path: `/demo/photos/${name}`, name, sha256: hash.repeat(64), category: "photos", detected_by: "signature", size: 1500000, modified_ms: Date.parse(date), indexed_at_ms: Date.parse("2026-10-18T12:00:00Z") },
  tags: [{ kind: "person", value: "小满" }, { kind: "event", value: event }, { kind: "place", value: place }, { kind: "captured_date", value: date }],
}));
const parameters = new URLSearchParams(window.location.search);
const summary = { indexed_at_ms: 1792324800000, total: library.length, total_bytes: 6000000, skipped: 0, categories: { photos: library.length, documents: 0, videos: 0, mail: 0, other: 0 } };
const services: PhotoServices = {
  photoLibraryQuery: async (filter = {}) => {
    if (parameters.has("error")) throw new Error("synthetic query failure");
    const matched = parameters.has("empty") ? [] : library.filter((photo) => (!filter.sha256 || photo.file.sha256 === filter.sha256) && (!filter.query || `${photo.file.path} ${photo.tags.map((tag) => tag.value).join(" ")}`.toLowerCase().includes(filter.query.toLowerCase())));
    return { items: structuredClone(matched.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 12))), total: matched.length, summary } as PhotoLibraryResult;
  },
  photoPreview: async (path, expected) => { const index = library.findIndex((photo) => photo.file.path === path); if (index < 0) throw new Error("not indexed"); return { data_base64: images[index].split(",")[1], size: 1500000, sha256: expected, mime: "image/png" }; },
  photoTagsSet: async (path, expected, tags) => { library = library.map((photo) => photo.file.path === path ? { ...photo, tags } : photo); return { path, sha256: expected, tags, updated_at_ms: Date.now() }; },
  fileIndexRefresh: async () => summary,
  vaultWriteFile: async (_path, content) => ({ size: content.length, sha256: "0".repeat(64) }),
};
function Preview() {
  const [settings, setSettings] = useState(ensureAiOsRoom({ providers: { "本地助手": BUILTIN_PROVIDER } }));
  const [blocks, setBlocks] = useState<ChatBlock[]>([
    { id: 1, kind: "user", text: "悟空，把小满第一次去海边的照片找出来。" },
    { id: 2, kind: "assistant", text: "那天留下的，不只是照片。\n\n右侧是小满的示例回忆。你可以挑选喜欢的瞬间，或给它一个自己的名字。" },
  ]);
  const onSend = async (_id: string, text: string) => {
    const scene = suggestTreasureScene(text);
    const response = scene === "story" ? "十八年，慢慢长大。\n\n我们先挑出每个阶段值得留下的瞬间。你可以选择下方的成长影片场景，再调整选片与生日。缺少的照片，我们留着位置。" : scene === "review" ? "我们一起挑。\n\n可以先比较照片，记下你想保留的那张。查看相同副本会按内容指纹匹配，标记保留不会删除原件。" : "好，继续告诉我你想找回的那一刻。\n\n下方可以选择照片场景；也可以输入“找照片：海边”，按名字与已标注的内容查找。";
    setBlocks((old) => [...old, { id: Date.now(), kind: "user", text }, { id: Date.now() + 1, kind: "assistant", text: response }]);
  };
  return <div className="treasure-preview-root" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ font: '11px "PingFang SC",sans-serif', color: "#77867a", background: "#f5f2ea", padding: "7px 18px", borderBottom: "1px solid #e2e4d9", flexShrink: 0 }}>概念验收预览 · AI 生成的示例照片 · 不连接模型、家庭数据或真实写入</div>
    <div style={{ flex: 1, minHeight: 0 }}><Room preview initialTreasureScene="memory" photoServices={services} root="/demo/treasure" settings={settings} sessions={[{ id: ROOM_AGENT_ID, label: "悟空", providerName: "本地助手" }]} activeAgentId={ROOM_AGENT_ID} onSelectAgent={() => {}} running={{}} chats={{ [ROOM_AGENT_ID]: blocks }} onSend={onSend} onAbort={async () => {}} onCreateAgent={async () => {}} onSaveSettings={async (next) => setSettings(next)} onOpenHome={() => window.alert("这是宝箱的独立预览，未连接工作台。请在原生家合中管理照片来源。")} /></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
