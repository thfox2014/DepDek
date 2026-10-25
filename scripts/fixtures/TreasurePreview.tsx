// Explicitly synthetic UI fixture. No native APIs, models, or real family files.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Room from "../../src/components/DepDekAiOsShell";
import type { ChatBlock } from "../../src/App";
import type { PhotoLibraryItem, PhotoLibraryResult } from "../../src/api";
import type { PhotoServices } from "../../src/components/TreasurePanel";
import { ensureAiOsRoom, ROOM_AGENT_ID } from "../../src/lib/aiOsRoom";
import { BUILTIN_PROVIDER } from "../../src/lib/aiOsSetup";
import { suggestTreasureScene, TREASURE_SCENES } from "../../src/lib/treasure";
import { photoClassificationExamples } from "./photoClassification";
import { DOCUMENT_SCENES, suggestDocumentScene, type DocumentScene } from "../../src/lib/documentScenes";
import { documentExamples } from "./documentExamples";
import { nativeDocumentExamples } from "./nativeDocuments";
import { contentAgentExamples } from "./contentAgent";
import { videoExamples } from "./nativeVideos";
import { suggestVideoScene, VIDEO_SCENES } from "../../src/lib/videoLibrary";
import { suggestRoomWorkspace, type RoomWorkspace } from "../../src/lib/roomWorkspaces";
import { workspaceExamples } from "./roomWorkspaces";
import demoVideo from "./treasure-assets/demo-video.mp4";
import seaside from "./treasure-assets/sea-child.png";
import teenager from "./treasure-assets/growing-teen.png";
import newborn from "./treasure-assets/newborn.png";
import "../../src/styles.css";
import "./collection-preview.css";

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
const extraWorkspace = ["chat", "applications", "family", "entertainment"].includes(parameters.get("workspace") ?? "") ? parameters.get("workspace") as RoomWorkspace : undefined;
const workspaceServices = workspaceExamples();
const documentsFirst = parameters.get("workspace") === "documents" || (!parameters.has("workspace") && document.body.dataset.defaultWorkspace === "documents");
const videosFirst = parameters.get("workspace") === "videos" || (!parameters.has("workspace") && document.body.dataset.defaultWorkspace === "videos");
const initialVideoScene = VIDEO_SCENES.find((scene) => scene.id === parameters.get("scene"))?.id ?? "memory";
const initialPhotoScene = TREASURE_SCENES.find((scene) => scene.id === parameters.get("scene"))?.id ?? "memory";
const initialScene: DocumentScene = DOCUMENT_SCENES.find((scene) => scene.id === parameters.get("scene"))?.id ?? "find";
const previewState = parameters.has("error") ? "error" : parameters.has("empty") ? "empty" : "ready";
const workflow = !parameters.has("concept");
const documentServices = nativeDocumentExamples(previewState);
const videoServices = videoExamples(demoVideo.split(",")[1], previewState);
function documentConversation(scene: DocumentScene): ChatBlock[] {
  const question = workflow && scene === "find" ? "悟空，找资料：滤网" : DOCUMENT_SCENES.find((item) => item.id === scene)!.prompt;
  const answer = workflow ? scene === "find" ? "关键词已经填好，点一下右侧的‘查找’就能体验原文检索。\n\n这里使用虚构资料，不会读取你的家庭文件。也可以试着查‘露营’，或打开 PDF 阅读示例。" : scene === "organize" ? "示例资料中有报价的初版、修订版和同内容副本。\n\n你可以修改分组名称，勾选两份比较原文，再保存或撤销分组。浏览器里的记录只留在当前页；原生应用才会写入本机 KV。" : "先写下要办的事，再选需要的资料、记下缺项。\n\n保存清单后可以导出一份含示例原件和来源清单的压缩包。不会自动选择文件，也不会发给任何人。"
    : scene === "find" ? "在这份示例说明书里，滤网清洁有三个步骤。\n\n我把相关段落放在右边。你可以直接看答案，也可以展开原文核对，不必再翻一遍目录。"
    : scene === "organize" ? "这摞示例资料，可以分成三组。\n\n报价里有两个版本，还有一份相同副本。修订版适合放在前面，旧版和原件都留下。先看看方案，觉得合适再应用。"
      : "这次出发用得上的三份示例资料，已经放在一起了。\n\n还缺一份营地入场说明，我给它留了位置。你可以调整带哪些资料；这里只预览，不会自动发给任何人。";
  return [{ id: Date.now(), kind: "user", text: question }, { id: Date.now() + 1, kind: "assistant", text: answer }];
}
const summary = { library_id: "synthetic-photo-library", indexed_at_ms: 1792324800000, total: library.length, total_bytes: 6000000, skipped: 0, categories: { photos: library.length, documents: 0, videos: 0, mail: 0, other: 0 } };
const services: PhotoServices = {
  photoLibraryQuery: async (filter = {}) => {
    if (parameters.has("error")) throw new Error("synthetic query failure");
    const matched = parameters.has("empty") ? [] : library.filter((photo) => (!filter.sha256 || photo.file.sha256 === filter.sha256) && (!filter.query || `${photo.file.path} ${photo.tags.map((tag) => tag.value).join(" ")}`.toLowerCase().includes(filter.query.toLowerCase())));
    return { items: structuredClone(matched.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 12))), total: matched.length, summary } as PhotoLibraryResult;
  },
  photoPreview: async (path, expected) => { const index = library.findIndex((photo) => photo.file.path === path); if (index < 0) throw new Error("not indexed"); const data = images[index].split(",")[1]; return { data_base64: data, size: atob(data).length, sha256: expected, mime: "image/png" }; },
  photoTagsSet: async (path, expected, tags) => { library = library.map((photo) => photo.file.path === path ? { ...photo, tags } : photo); return { path, sha256: expected, tags, updated_at_ms: Date.now() }; },
  fileIndexRefresh: async () => summary,
  vaultWriteFile: async (_path, content) => ({ size: content.length, sha256: "0".repeat(64) }),
};
const photoContent = contentAgentExamples((path) => [
  { dimension: "subject", label: "人像", confidence: 93, evidence: "合成示例画面：有人物入镜；不是实际模型判断" },
  { dimension: "subject", label: "风景", confidence: path.includes("看海") ? 95 : 55, evidence: "合成示例：低分结果仅留作待确认演示" },
]);
Object.assign(services, photoContent, { photoClassificationQuery: async (input: Parameters<NonNullable<PhotoServices["photoClassificationQuery"]>>[0] = {}) => {
  if (parameters.has("error")) throw new Error("synthetic query failure");
  return photoClassificationExamples(() => parameters.has("empty") ? [] : library, summary, photoContent.contentAnnotationGet)(input);
} });
function Preview() {
  const [settings, setSettings] = useState(ensureAiOsRoom({ providers: { "本地助手": BUILTIN_PROVIDER } }));
  const [active, setActive] = useState(ROOM_AGENT_ID), [agentChats, setAgentChats] = useState<Record<string, ChatBlock[]>>({});
  const [blocks, setBlocks] = useState<ChatBlock[]>(() => extraWorkspace ? [] : videosFirst ? [
    { id: 1, kind: "user", text: "悟空，把家人在海边的视频找出来。" },
    { id: 2, kind: "assistant", text: "让那些声音和笑脸，有个可以回来的地方。\n\n右侧可以加载示例片段、标注、挑选，或把原片排成故事清单。这里的三秒影像来自 AI 示例照片，不是真实家庭录像；也没有调用模型或自动剪辑。" },
  ] : documentsFirst ? documentConversation(initialScene) : [
    { id: 1, kind: "user", text: "悟空，把小满第一次去海边的照片找出来。" },
    { id: 2, kind: "assistant", text: "那天留下的，不只是照片。\n\n右侧是小满的示例回忆。你可以挑选喜欢的瞬间，或给它一个自己的名字。" },
  ]);
  const onSend = async (id: string, text: string) => {
    const workspace = suggestRoomWorkspace(text);
    const workspaceResponse = id !== ROOM_AGENT_ID ? `${settings.agents?.find((agent) => agent.id === id)?.label ?? "伙伴"}在。\n\n安装与切换会话的界面已经接好。这里是内存交互示例，没有调用模型，也没有读取家庭资料。` : workspace?.workspace === "family" ? "家庭面板已切到相关场景。你可以记录家里的信息，再把选中记录填入聊天草稿。\n\n这是隔离示例，设备尚未接入，记录仅留当前页面内存。" : workspace?.workspace === "applications" ? "内置 Agent Store 已打开。安装后，盒子里的头像和数量会一起更新。\n\n示例只留当前页面；原生应用保存真实配置。" : workspace?.workspace === "entertainment" ? "音乐入口已打开。示例乐库是两份一秒钟的合成音，不是真实歌曲。点选后才加载，按播放器按钮才发声。" : "";
    const videoScene = suggestVideoScene(text);
    const scene = suggestTreasureScene(text);
    const documentScene = suggestDocumentScene(text);
    const response = videoScene ? "视频的三个场景已经放在下面了。\n\n先看原片，再记下你喜欢的片段。故事保存的是选片与顺序，不会自动合并，也不会删掉原件。这里使用内存示例，刷新后清空。" : documentScene && !scene ? `听起来，你想「${DOCUMENT_SCENES.find((item) => item.id === documentScene)!.title}」。\n\n选一下下方场景，就能体验对应的示例流程。这版是规则式交互原型，没有调用模型，也没有检索你的真实资料。`
      : scene === "story" ? "十八年，慢慢长大。\n\n我们先挑出每个阶段值得留下的瞬间。你可以选择下方的成长影片场景，再调整选片与生日。缺少的照片，我们留着位置。" : scene === "review" ? "我们一起挑。\n\n可以先比较照片，记下你想保留的那张。查看相同副本会按内容指纹匹配，标记保留不会删除原件。" : scene ? "好，继续告诉我你想找回的那一刻。\n\n下方可以选择照片场景；也可以输入“找照片：海边”，按名字与已标注的内容查找。" : "这版是交互原型，没有调用大模型。\n\n可以试试‘帮我整理装修资料’或‘准备露营资料包’，再选择下方场景查看示例。任意资料问答尚未接入。";
    const added: ChatBlock[] = [{ id: Date.now(), kind: "user", text }, { id: Date.now() + 1, kind: "assistant", text: workspaceResponse || response }];
    if (id === ROOM_AGENT_ID) setBlocks((old) => [...old, ...added]); else setAgentChats((old) => ({ ...old, [id]: [...(old[id] ?? []), ...added] }));
  };
  return <div className="treasure-preview-root" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div className="collection-preview-bar"><span>{workflow ? "可用流程演示" : "概念交互原型"} · 内存示例资料，刷新清空 · 原生应用才连接真实 Vault</span><details><summary>Tweaks</summary><div><label>演示入口<select value={videosFirst ? `video-${initialVideoScene}` : documentsFirst ? initialScene : "album"} onChange={(event) => { const query = new URLSearchParams(window.location.search); const video = event.target.value.startsWith("video-"); query.set("workspace", video ? "videos" : event.target.value === "album" ? "album" : "documents"); query.set("scene", video ? event.target.value.slice(6) : event.target.value); window.location.search = query.toString(); }}><option value="album">相册</option>{VIDEO_SCENES.map((scene) => <option key={scene.id} value={`video-${scene.id}`}>视频 · {scene.title}</option>)}{DOCUMENT_SCENES.map((scene) => <option key={scene.id} value={scene.id}>资料 · {scene.title}</option>)}</select></label><label>呈现方式<select value={workflow ? "workflow" : "concept"} onChange={(event) => { const query = new URLSearchParams(window.location.search); if (event.target.value === "concept") query.set("concept", "1"); else query.delete("concept"); window.location.search = query.toString(); }}><option value="workflow">本机可用流程（内存示例）</option><option value="concept">原概念场景</option></select></label><label>资料状态<select value={previewState} onChange={(event) => { const query = new URLSearchParams(window.location.search); query.delete("error"); query.delete("empty"); if (event.target.value !== "ready") query.set(event.target.value, "1"); window.location.search = query.toString(); }}><option value="ready">已载入示例</option><option value="empty">空资料</option><option value="error">连接失败</option></select></label></div></details></div>
    <div style={{ flex: 1, minHeight: 0 }}><Room preview initialWorkspace={extraWorkspace} familyServices={workspaceServices.family} musicServices={workspaceServices.music} initialTreasureScene={documentsFirst || videosFirst || extraWorkspace ? undefined : initialPhotoScene} initialVideoScene={videosFirst ? initialVideoScene : undefined} videoServices={videoServices} initialDocumentScene={documentsFirst ? initialScene : undefined} documentExamples={workflow ? undefined : documentExamples} documentServices={workflow ? documentServices : undefined} documentPreviewState={previewState} onDocumentSceneChange={(scene) => setBlocks(documentConversation(scene))} photoServices={services} root="/demo/collections" settings={settings} sessions={[{ id: ROOM_AGENT_ID, label: "悟空", providerName: "本地助手" }]} activeAgentId={active} onSelectAgent={setActive} running={{}} chats={{ ...agentChats, [ROOM_AGENT_ID]: blocks }} onSend={onSend} onAbort={async () => {}} onCreateAgent={async () => {}} onSaveSettings={async (next) => setSettings(next)} onOpenHome={() => window.alert("这是家合场景的独立原型，未连接工作台。请在原生家合中管理真实资料。")} /></div>
  </div>;
}
if (parameters.has("content-agent")) {
  Object.assign(videoServices, contentAgentExamples());
  Object.assign(documentServices, contentAgentExamples());
}
createRoot(document.getElementById("root")!).render(<Preview />);
