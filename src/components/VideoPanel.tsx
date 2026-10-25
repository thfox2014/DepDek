import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CircleNotch, FilmStrip, Play, Stack, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { FILE_LIBRARY_CHANGED } from "../lib/fileLibrary";
import { photoTagsFromText } from "../lib/treasure";
import { MAX_STORY_BYTES, MAX_VIDEO_BYTES, moveVideo, videoError, videoKey, videoRef, type VideoScene, type VideoServices } from "../lib/videoLibrary";
import FileImportButton from "./FileImportButton";
import { AiContentButton, AiContentCard, useAiContentAgent } from "./AiContentAgent";
import "./treasure.css";
import "./video-panel.css";

const PAGE = 12;
const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const value = (item: api.VideoLibraryItem | undefined, kind: api.PhotoTagKind) => item?.tags.find((tag) => tag.kind === kind)?.value ?? "";
const name = (reference: api.VideoReference) => reference.path.split("/").pop() || reference.path;
const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** One explicit, bounded local read. No thumbnails, speculative prefetch or remote URLs. */
export function LocalVideo({ reference, libraryId, services, hidden }: { reference: api.VideoReference; libraryId: string; services: VideoServices; hidden: boolean }) {
  const [attempt, setAttempt] = useState(0), [url, setUrl] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const media = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (hidden) media.current?.pause(); }, [hidden]);
  useEffect(() => {
    if (!attempt) return;
    let disposed = false, objectUrl = "";
    setBusy(true); setError(""); setUrl("");
    void services.videoPreview({ libraryId, reference }).then((result) => {
      if (disposed) return;
      if (result.sha256.toLowerCase() !== reference.sha256.toLowerCase() || result.size > MAX_VIDEO_BYTES || result.data_base64.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4 || !["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo"].includes(result.mime)) throw new Error("changed video response");
      const raw = atob(result.data_base64);
      if (raw.length !== result.size) throw new Error("changed video size");
      objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(raw, (char) => char.charCodeAt(0))], { type: result.mime }));
      setUrl(objectUrl);
    }).catch((failure) => { if (!disposed) setError(videoError(failure)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attempt, libraryId, reference.path, reference.sha256, services]);
  return <div className="video-player">
    {url ? <video ref={media} controls playsInline preload="metadata" src={url} aria-label={`播放 ${name(reference)}`} onError={() => setError("当前播放器不支持这段视频的编码，或文件已损坏。原片保留，暂不自动转码。")} /> : <div className="video-player__placeholder"><FilmStrip size={37} /><b>{name(reference)}</b><p>视频只在本机加载，不上传模型。</p><button disabled={busy} onClick={() => setAttempt((value) => value + 1)}>{busy ? <CircleNotch size={17} className="room-spin" /> : <Play size={17} />}{busy ? "正在校验原片…" : error ? "重新加载原片" : "加载原片播放"}</button></div>}
    {error && <p className="video-player__error" role="alert">{error}</p>}
  </div>;
}

export default function VideoPanel({ scene, query, services: injected, navigation, onScene, onQuery, onProgress, onOpenHome, onClose, chatMessage, hidden = false }: {
  scene: VideoScene; query: string; services?: VideoServices; navigation?: ReactNode;
  onScene: (scene: VideoScene) => void; onQuery: (query: string) => void;
  onProgress: (lines: string[]) => void; onOpenHome: () => void; onClose: () => void;
  chatMessage?: { id: number; text: string }; hidden?: boolean;
}) {
  const services = injected ?? api, available = Boolean(injected) || native();
  const [result, setResult] = useState<api.VideoLibraryResult | null>(null), [offset, setOffset] = useState(0), [sha, setSha] = useState("");
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [acting, setActing] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [find, setFind] = useState(query), [current, setCurrent] = useState(0);
  const [editor, setEditor] = useState(false), [fields, setFields] = useState({ person: "", place: "", event: "", captured_date: "", note: "" });
  const [references, setReferences] = useState<api.VideoReference[]>([]), [storyId, setStoryId] = useState(""), [storyRevision, setStoryRevision] = useState(0), [title, setTitle] = useState("");
  const [playing, setPlaying] = useState<api.VideoReference | null>(null);
  const request = useRef(0), alive = useRef(true), working = useRef(false), annotated = useRef<number>();
  const videos = result?.items ?? [], selected = videos[current] ?? videos[0], libraryId = result?.summary.library_id ?? "";
  const contentAgent = useAiContentAgent(selected?.file, libraryId, services, onProgress);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setOffset(0); setSha(""); setFind(query); }, [query]);
  useEffect(() => { setEditor(false); setPlaying(null); setNotice(""); }, [scene]);
  useEffect(() => {
    const changed = () => { setOffset(0); setRevision((n) => n + 1); };
    window.addEventListener(FILE_LIBRARY_CHANGED, changed);
    return () => window.removeEventListener(FILE_LIBRARY_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!available) return;
    const ticket = ++request.current;
    setBusy(true); setResult(null); setError(""); setPlaying(null); setEditor(false);
    void services.videoLibraryQuery({ query: query || undefined, sha256: sha || undefined, offset, limit: PAGE }).then((next) => {
      if (ticket !== request.current) return;
      setResult(next); setCurrent(0);
      onProgress([next.summary.indexed_at_ms ? "已读取本机视频索引" : "视频索引尚未建立", `找到 ${next.total} 段原片 · 搜索名称、路径与已有内容标注`, "原片未修改，未发送到云端"]);
    }).catch((failure) => { if (ticket === request.current) { setError(videoError(failure)); onProgress(["视频查询未完成，请重试"]); } }).finally(() => { if (ticket === request.current) setBusy(false); });
    return () => { request.current++; };
  }, [services, available, query, sha, offset, revision, onProgress]);
  const edit = () => {
    if (!selected) return;
    setFields({ person: value(selected, "person"), place: value(selected, "place"), event: value(selected, "event"), captured_date: value(selected, "captured_date"), note: value(selected, "note") }); setEditor(true); setNotice("");
  };
  useEffect(() => {
    if (!selected || !chatMessage || annotated.current === chatMessage.id) return;
    annotated.current = chatMessage.id;
    const proposed = photoTagsFromText(chatMessage.text);
    if (!proposed) return;
    setFields({ person: value(selected, "person"), place: value(selected, "place"), event: value(selected, "event"), captured_date: value(selected, "captured_date"), note: value(selected, "note"), ...proposed });
    setEditor(true); setNotice("已填入你说的标注。核对当前原片后再保存。");
  }, [selected?.file.path, chatMessage?.id]);
  const run = async (action: () => Promise<void>) => {
    if (working.current || !available || !libraryId) return;
    working.current = true; setActing(true); setError(""); setNotice("");
    try { await action(); } catch (failure) { if (alive.current) setError(videoError(failure)); }
    finally { working.current = false; if (alive.current) setActing(false); }
  };
  const tags = (next: api.PhotoTag[]) => selected && void run(async () => {
    const saved = await services.videoTagsSet({ libraryId, reference: videoRef(selected), tags: next, expectedRevision: selected.revision });
    if (!alive.current) return;
    setResult((old) => old && ({ ...old, items: old.items.map((item) => videoKey(item.file) === videoKey(selected.file) ? { ...item, tags: saved.tags, revision: saved.revision } : item) }));
    setEditor(false); setNotice("视频标注已保存在本机，原片未修改。");
    onProgress(["已校验原片 SHA", "人工标注已保存到视频 KV", "未识别人物身份，未上传视频"]);
  });
  const saveTags = () => {
    const next: api.PhotoTag[] = (selected?.tags ?? []).filter((tag) => tag.kind === "selection");
    for (const [kind, text] of Object.entries(fields)) if (text.trim()) next.push({ kind: kind as api.PhotoTagKind, value: text.trim() });
    tags(next);
  };
  const add = (item: api.VideoLibraryItem) => {
    if (references.some((reference) => reference.path === item.file.path)) { setNotice("这段已经在故事清单里。"); return; }
    if (references.length >= 20 || item.file.size > MAX_VIDEO_BYTES) { setError("故事最多 20 段，每段不超过 64 MiB。"); return; }
    setReferences((old) => [...old, videoRef(item)]); setNotice("已加入选片，保存故事后下次可继续。");
  };
  const saveStory = () => void run(async () => {
    const id = storyId || crypto.randomUUID();
    // Retain operation identity after an uncertain response; never append another story on retry.
    setStoryId(id);
    const saved = await services.videoStoryPut({ libraryId, id, title: title.trim() || "我们的故事", references, expectedRevision: storyRevision });
    if (!alive.current) return;
    setStoryId(saved.id); setStoryRevision(saved.revision); setTitle(saved.title);
    setResult((old) => old && ({ ...old, stories: [saved, ...old.stories.filter((item) => item.id !== saved.id)] }));
    setNotice("故事清单已保存。它引用原片，还没有合并或导出成片。");
    onProgress([`已复验 ${saved.references.length} 段原片`, "故事选片和顺序已保存到本机 KV", "尚未剪辑、合并或导出视频"]);
  });
  const openStory = (story: api.VideoStory) => { setStoryId(story.id); setStoryRevision(story.revision); setTitle(story.title); setReferences(story.references); setPlaying(null); setNotice("已打开保存的清单，播放和保存时会重新校验原片。"); };
  const refresh = () => {
    if (working.current || busy || !available) return;
    working.current = true; setActing(true); setError("");
    void services.fileIndexRefresh().then(() => { if (alive.current) { setOffset(0); setRevision((n) => n + 1); } }).catch((failure) => { if (alive.current) setError(videoError(failure)); }).finally(() => { working.current = false; if (alive.current) setActing(false); });
  };
  if (!available) return <aside className="treasure-panel video-panel" hidden={hidden} aria-label="视频">{navigation}<div className="treasure-panel__empty"><FilmStrip size={37} /><h2>让回忆，有声有色。</h2><p>在家合原生应用中打开视频，查看本机原片与故事清单。</p><button onClick={onOpenHome}>打开工作台<ArrowRight size={16} /></button></div></aside>;
  return <aside className="treasure-panel video-panel" hidden={hidden} aria-label="视频" data-scene={scene}>
    <header className="treasure-panel__header"><h2 className="treasure-panel__headline">{scene === "memory" ? "有些声音，值得再听一次。" : scene === "review" ? "精彩的，慢慢留下。" : "把散落的片段，串成故事。"}</h2><span className="treasure-panel__meta">{busy ? "正在找视频…" : `${result?.total ?? 0} 段原片`}</span><button aria-label="收起视频，返回聊天" onClick={onClose}><X size={17} /></button></header>
    {navigation}
    <div className="treasure-panel__scroll">
      <FileImportButton service={services.fileLibraryImport} resolveLibrary={async () => (await services.videoLibraryQuery({ limit: 1 })).summary.library_id ?? ""} onProgress={onProgress} label="添加视频" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" />
      <form className="treasure-find" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSha(""); onQuery(find.trim()); }}><input aria-label="查找视频" value={find} maxLength={120} onChange={(event) => setFind(event.target.value)} placeholder="文件名、路径、SHA、人物或事件" /><button aria-label="搜索视频" disabled={busy || acting}><ArrowRight size={17} /></button></form>
      {error && <p className="treasure-panel__notice is-error" role="alert">{error}</p>}{notice && <p className="treasure-panel__notice" role="status">{notice}</p>}
      {busy ? <div className="video-panel__loading" role="status"><CircleNotch size={22} className="room-spin" />正在打开视频索引…</div> : !result ? <button onClick={() => setRevision((n) => n + 1)}>重新打开视频</button> : <>
        {scene === "story" && <section className="video-story" aria-label="视频故事清单">
          <label>故事名称<input value={title} maxLength={120} disabled={acting} onChange={(event) => setTitle(event.target.value)} placeholder="例如：今年，我们一起走过" /></label>
          {result.stories.length > 0 && <label>继续一个故事<select value={storyId} disabled={acting} onChange={(event) => { const story = result.stories.find((item) => item.id === event.target.value); if (story) openStory(story); else { setStoryId(""); setStoryRevision(0); setReferences([]); setTitle(""); setPlaying(null); } }}><option value="">新的故事</option>{result.stories.map((story) => <option key={story.id} value={story.id}>{story.title} · {story.references.length} 段</option>)}</select></label>}
          {playing && <LocalVideo key={`${libraryId}:${videoKey(playing)}`} reference={playing} libraryId={libraryId} services={services} hidden={hidden} />}
          {references.length ? <ol className="video-story__list">{references.map((reference, index) => <li key={videoKey(reference)}><button className="video-story__clip" disabled={acting} onClick={() => setPlaying(reference)}><span>{String(index + 1).padStart(2, "0")}</span><b>{name(reference)}</b><Play size={15} /></button><div><button aria-label={`上移 ${name(reference)}`} disabled={acting || index === 0} onClick={() => { setReferences((old) => moveVideo(old, index, -1)); }}><ArrowUp size={15} /></button><button aria-label={`下移 ${name(reference)}`} disabled={acting || index === references.length - 1} onClick={() => setReferences((old) => moveVideo(old, index, 1))}><ArrowDown size={15} /></button><button aria-label={`移出故事 ${name(reference)}`} disabled={acting} onClick={() => { setReferences((old) => old.filter((item) => videoKey(item) !== videoKey(reference))); if (playing && videoKey(playing) === videoKey(reference)) setPlaying(null); }}><X size={15} /></button></div></li>)}</ol> : <p className="video-panel__note">从下方原片加入第一段，顺序由你安排。</p>}
          <p className="video-panel__note">{references.length} / 20 段 · 故事上限 {size(MAX_STORY_BYTES)}。清单引用原片，不是合并成片。</p>
        </section>}
        {!videos.length ? <div className="video-panel__empty"><FilmStrip size={30} /><h3>{query || sha ? "这次还没找到。" : "把家人的声音，也留在这里。"}</h3><p>{query || sha ? "可以搜索文件信息及已有 AI 标注。打开原片后，点击 AI 自动标注来分析画面。" : "添加视频后，会自动保存副本并建立索引。单文件最多 64 MiB。"}</p>{query || sha ? <button onClick={() => { setSha(""); onQuery(""); }}>查看全部视频</button> : <details><summary>已有 Home 视频</summary><p>仅索引当前 Home，原件不移动。不会自动扫描。</p><button disabled={acting} onClick={refresh}>{acting ? "正在建立索引…" : "整理现有 Home"}</button></details>}</div> : <>
          {scene !== "story" && selected && <>
            <LocalVideo key={`${libraryId}:${videoKey(selected.file)}`} reference={videoRef(selected)} libraryId={libraryId} services={services} hidden={hidden || editor} />
            <div className="video-panel__caption"><b>{selected.file.name}</b><span>{size(selected.file.size)}{value(selected, "selection") ? " · 已标记保留" : ""}</span></div>
            <p className="video-panel__note">{[value(selected, "person"), value(selected, "place"), value(selected, "captured_date"), value(selected, "event"), value(selected, "note")].filter(Boolean).join(" · ") || "拍摄信息还没有标注。日期和人物由你确认。"}</p>
            <AiContentCard agent={contentAgent} onManual={edit} />
            {editor && <form className="treasure-tags" onSubmit={(event) => { event.preventDefault(); saveTags(); }}>{([{ kind: "person", label: "人物" }, { kind: "place", label: "地点" }, { kind: "event", label: "事件" }, { kind: "captured_date", label: "拍摄日期" }, { kind: "note", label: "想记住的话" }] as const).map(({ kind, label }) => <label key={kind}>{label}<input type={kind === "captured_date" ? "date" : "text"} maxLength={120} value={fields[kind]} disabled={acting} onChange={(event) => setFields((old) => ({ ...old, [kind]: event.target.value }))} /></label>)}</form>}
          </>}
          <div className="video-panel__list" aria-label="视频原片">{videos.map((item, index) => <div key={videoKey(item.file)}><button className={scene !== "story" && selected?.file.path === item.file.path ? "is-selected" : ""} aria-pressed={scene !== "story" && selected?.file.path === item.file.path} disabled={acting} onClick={() => { setCurrent(index); setEditor(false); if (scene === "story") setPlaying(videoRef(item)); }}><FilmStrip size={21} /><span><b>{item.file.name}</b><small>{value(item, "event") || value(item, "place") || item.file.path}</small></span><small>{size(item.file.size)}</small></button>{scene === "story" && <button aria-label={`加入故事 ${item.file.name}`} disabled={acting || references.some((reference) => reference.path === item.file.path) || references.length >= 20 || item.file.size > MAX_VIDEO_BYTES} onClick={() => add(item)}>{references.some((reference) => reference.path === item.file.path) ? <Check size={16} /> : "+"}</button>}</div>)}</div>
          <div className="treasure-selection__paging"><button disabled={offset === 0 || acting} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ArrowLeft size={15} />上一页</button><span>{offset + 1}—{offset + videos.length} / {result.total}</span><button disabled={offset + PAGE >= result.total || acting} onClick={() => setOffset(offset + PAGE)}>下一页<ArrowRight size={15} /></button></div>
        </>}
      </>}
    </div>
    <footer className="treasure-panel__footer"><div className="treasure-panel__actions">
      {scene === "story" ? <><button className="is-primary" disabled={!references.length || acting || busy || !libraryId} onClick={saveStory}>{acting ? <CircleNotch className="room-spin" size={16} /> : <Check size={16} />}保存故事清单</button><button disabled={acting} onClick={() => { setStoryId(""); setStoryRevision(0); setTitle(""); setReferences([]); setPlaying(null); setNotice(""); }}>新故事</button></> : editor ? <><button className="is-primary" disabled={acting || busy} onClick={saveTags}>保存标注</button><button disabled={acting} onClick={() => setEditor(false)}>返回原片</button></> : scene === "review" ? <><button className="is-primary" disabled={!selected || acting || busy || selected.file.size > MAX_VIDEO_BYTES} onClick={() => selected && tags(value(selected, "selection") ? selected.tags.filter((tag) => tag.kind !== "selection") : [...selected.tags, { kind: "selection", value: "keep" }])}><Check size={16} />{value(selected, "selection") ? "取消保留标记" : "标记保留"}</button><button disabled={!selected || acting || busy} onClick={() => { setSha(sha ? "" : selected.file.sha256); setOffset(0); }}>{sha ? "返回全部" : <><Stack size={16} />相同副本</>}</button><AiContentButton agent={contentAgent} disabled={!selected || acting || busy} /></> : <><button className="is-primary" disabled={!selected || acting || busy || selected.file.size > MAX_VIDEO_BYTES} onClick={() => { if (selected) add(selected); onScene("story"); }}><FilmStrip size={16} />放进故事</button><AiContentButton agent={contentAgent} disabled={!selected || acting || busy || selected.file.size > MAX_VIDEO_BYTES} /></>}
    </div><small>标注保存在本机 · AI 按所选模型分析取样画面 · 原片保持原位</small></footer>
  </aside>;
}
