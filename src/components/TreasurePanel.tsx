import { ArrowLeft, ArrowRight, Check, CircleNotch, FilmStrip, ImageSquare, Images, Sparkle, Pause, Play, Stack, Tag, Tray, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { missingStoryAges, photoKey, photoTagsFromText, storyDraft, storyFrames, tagValue, type TreasureScene } from "../lib/treasure";
import "./treasure.css";
import FileImportButton from "./FileImportButton";
import { FILE_LIBRARY_CHANGED } from "../lib/fileLibrary";
import { captureDebugError } from "../lib/debugCapture";
import { AiContentCard, useAiContentAgent } from "./AiContentAgent";
import PhotoClassificationPanel from "./PhotoClassificationPanel";

export type PhotoServices = Pick<typeof api, "photoLibraryQuery" | "photoPreview" | "photoTagsSet" | "fileIndexRefresh" | "vaultWriteFile"> & Partial<Pick<typeof api, "photoClassificationQuery" | "fileLibraryImport" | "contentAnnotationGet" | "contentAnalyze" | "contentAnnotationUpdate" | "settingsGet">>;
type Props = {
  scene: TreasureScene; query: string; services?: PhotoServices;
  navigation?: ReactNode;
  onScene: (scene: TreasureScene) => void; onProgress: (lines: string[]) => void;
  onOpenHome: () => void; onQuery: (query: string) => void;
  chatMessage?: { id: number; text: string };
  hidden?: boolean;
};
const PAGE = 12;
const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const errorText = (error: unknown) => {
  const text = String(error);
  if (text.includes("E32006")) return "空间已锁定，请先登录。";
  if (text.includes("E32003")) return "照片超过 12 MiB 预览上限，请在原件中查看。";
  if (/changed|not indexed/.test(text)) return "照片或索引已变化，请刷新后重试。";
  return "暂时无法完成，请重试；原件未改动。";
};

function PhotoImage({ item, services, small = false }: { item: api.PhotoLibraryItem; services: PhotoServices; small?: boolean }) {
  const [url, setUrl] = useState(""), [error, setError] = useState("");
  const holder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let disposed = false, objectUrl = "", started = false;
    setUrl(""); setError("");
    const load = async () => {
      if (started) return; started = true;
      try {
        const result = await services.photoPreview(item.file.path, item.file.sha256);
        if (disposed) return;
        if (result.sha256 !== item.file.sha256 || !/^image\/(jpeg|png|webp|gif|avif)$/.test(result.mime)) throw new Error("changed");
        const bytes = Uint8Array.from(atob(result.data_base64), (char) => char.charCodeAt(0));
        const blob = new Blob([bytes], { type: result.mime });
        // Keep only a display-sized raster in memory when the browser supports it.
        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(blob);
          if (disposed) { bitmap.close(); return; }
          if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error("dimensions"); }
          const canvas = document.createElement("canvas"), ratio = Math.min(1, (small ? 400 : 1600) / Math.max(bitmap.width, bitmap.height));
          canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
          const thumbnail = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .88));
          if (disposed) return;
          objectUrl = URL.createObjectURL(thumbnail ?? blob);
        } else objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (failure) { if (!disposed) setError(String(failure).includes("supports") ? "此格式暂不支持预览" : errorText(failure)); }
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); void load(); } }, { rootMargin: "120px" });
    if (observer && holder.current) observer.observe(holder.current); else void load();
    return () => { disposed = true; observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.file.path, item.file.sha256, services, small]);
  return <span ref={holder} className={`treasure-photo${error ? " has-error" : ""}`}>
    {url ? <img src={url} alt={item.file.name} draggable={false} /> : error ? <span><ImageSquare size={25} /><small>{small ? "暂不可预览" : error}</small></span> : <span><CircleNotch size={20} className="room-spin" />{!small && <small>正在打开照片…</small>}</span>}
  </span>;
}

export default function TreasurePanel({ scene, query, services: injected, navigation, onScene, onProgress, onOpenHome, onQuery, chatMessage, hidden = false }: Props) {
  const services = injected ?? api, available = Boolean(injected) || native();
  const importer = services.fileLibraryImport;
  const [result, setResult] = useState<api.PhotoLibraryResult | null>(null), [offset, setOffset] = useState(0), [sha, setSha] = useState("");
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0), [current, setCurrent] = useState(0), [editor, setEditor] = useState<"tags" | "selection" | null>(null);
  const [tagFields, setTagFields] = useState({ person: "", place: "", event: "", captured_date: "", note: "" });
  const [chosen, setChosen] = useState<Record<string, api.PhotoLibraryItem>>({}), [birthday, setBirthday] = useState(""), [title, setTitle] = useState("");
  const [playing, setPlaying] = useState(false), [previewing, setPreviewing] = useState(false), [frame, setFrame] = useState(0), [find, setFind] = useState(query);
  const request = useRef(0), initialized = useRef(false);
  const annotatedMessage = useRef<number>();
  const photos = result?.items ?? [], selected = photos[current] ?? photos[0];
  const contentAgent = useAiContentAgent(scene === "classify" ? undefined : selected?.file, result?.summary.library_id ?? "", services, onProgress);
  const selections = Object.values(chosen), frames = storyFrames(selections, birthday), missing = missingStoryAges(selections, birthday);
  useEffect(() => { setOffset(0); setSha(""); setFind(query); }, [query]);
  useEffect(() => { setEditor(null); setPreviewing(false); setPlaying(false); setNotice(""); }, [scene]);
  useEffect(() => {
    const changed = () => { setOffset(0); setRevision((value) => value + 1); };
    window.addEventListener(FILE_LIBRARY_CHANGED, changed);
    return () => window.removeEventListener(FILE_LIBRARY_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!selected || !chatMessage || annotatedMessage.current === chatMessage.id) return;
    annotatedMessage.current = chatMessage.id;
    const proposed = photoTagsFromText(chatMessage.text);
    if (!proposed) return;
    setTagFields({ person: tagValue(selected, "person"), place: tagValue(selected, "place"), event: tagValue(selected, "event"), captured_date: tagValue(selected, "captured_date"), note: tagValue(selected, "note"), ...proposed });
    setEditor("tags"); setNotice("已把你说的标注填在这里，确认后保存到这张照片。");
  }, [chatMessage?.id, selected?.file.path]);
  useEffect(() => {
    if (!available || scene === "classify") return;
    const id = ++request.current; setBusy(true); setResult(null); setError("");
    void services.photoLibraryQuery({ query: query || undefined, sha256: sha || undefined, offset, limit: PAGE }).then((next) => {
      if (request.current !== id) return;
      setResult(next); setCurrent(0);
      if (!initialized.current && next.items.length) {
        initialized.current = true;
        const seen = new Set<string>();
        const unique = next.items.filter((photo) => { if (seen.has(photo.file.sha256)) return false; seen.add(photo.file.sha256); return true; });
        setChosen(Object.fromEntries(unique.slice(0, 12).map((photo) => [photoKey(photo), photo])));
      }
      onProgress([next.summary.indexed_at_ms ? "已读取本机照片索引" : "照片索引尚未建立", query ? `按文件名与已确认标签检索：${query}` : `当前结果共 ${next.total} 张照片`, `已载入第 ${next.total ? offset + 1 : 0}—${offset + next.items.length} 张`, "照片只在本机预览，原件未修改"]);
    }).catch((failure) => { captureDebugError("photo_library_query", failure); if (request.current === id) { setError(errorText(failure)); onProgress(["照片查询未完成，请重试"]); } }).finally(() => { if (request.current === id) setBusy(false); });
    return () => { request.current++; };
  }, [available, services, query, offset, sha, revision, onProgress, scene === "classify"]);
  useEffect(() => {
    if (!playing || !frames.length) return;
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % frames.length), 3500);
    return () => window.clearInterval(timer);
  }, [playing, frames.length]);

  const refresh = async () => {
    if (acting || busy) return; setActing(true); setError("");
    onProgress(["正在建立 Home 文件索引，原件保持原位"]);
    try { const summary = await services.fileIndexRefresh(); setOffset(0); setRevision((value) => value + 1); setNotice(`已更新索引，包含 ${summary.categories.photos} 张照片。`); }
    catch (failure) { captureDebugError("photo_index_refresh", failure); setError(errorText(failure)); onProgress(["索引未能更新，保留上次成功结果"]); } finally { setActing(false); }
  };
  const changeSelection = (photo: api.PhotoLibraryItem) => setChosen((items) => { const next = { ...items }; if (next[photoKey(photo)]) delete next[photoKey(photo)]; else if (Object.keys(next).length < 100) next[photoKey(photo)] = photo; return next; });
  const applyTags = async (tags: api.PhotoTag[]) => {
    if (!selected || acting) return; setActing(true); setError("");
    try {
      const saved = await services.photoTagsSet(selected.file.path, selected.file.sha256, tags);
      const updated = { ...selected, tags: saved.tags };
      setResult((old) => old && ({ ...old, items: old.items.map((photo) => photoKey(photo) === photoKey(selected) ? updated : photo) }));
      setChosen((old) => old[photoKey(selected)] ? { ...old, [photoKey(selected)]: updated } : old);
      setNotice("这张照片的标注已保存，下次可以直接按标签找到它。"); setEditor(null);
      onProgress(["已校验照片内容与索引一致", "用户标注已保存到本机 KV", "照片原件未修改"]);
    } catch (failure) { setError(errorText(failure)); } finally { setActing(false); }
  };
  const editTags = () => { if (!selected) return; setTagFields({ person: tagValue(selected, "person"), place: tagValue(selected, "place"), event: tagValue(selected, "event"), captured_date: tagValue(selected, "captured_date"), note: tagValue(selected, "note") }); setEditor("tags"); setNotice(""); };
  const saveTags = () => {
    const kinds = new Set(Object.keys(tagFields));
    const tags: api.PhotoTag[] = (selected?.tags ?? []).filter((tag) => !kinds.has(tag.kind));
    for (const [kind, value] of Object.entries(tagFields)) if (value.trim()) tags.push({ kind: kind as api.PhotoTagKind, value: value.trim() });
    void applyTags(tags);
  };
  const keep = () => selected && void applyTags([...selected.tags.filter((tag) => tag.kind !== "selection"), { kind: "selection", value: "keep" }]);
  const nextPhoto = () => {
    setNotice("");
    if (current + 1 < photos.length) setCurrent(current + 1);
    else if (offset + PAGE < (result?.total ?? 0)) setOffset(offset + PAGE);
    else setCurrent(0);
  };
  const saveStory = async () => {
    if (!selections.length || acting) return; setActing(true); setError("");
    try {
      const path = `treasure/stories/${crypto.randomUUID()}.json`;
      await services.vaultWriteFile(path, JSON.stringify(storyDraft(selections, title, birthday), null, 2));
      setNotice(`故事草稿已保存到 ${path}。这是选片清单，尚未导出视频。`);
      onProgress([`已整理 ${selections.length} 张选片引用`, "故事草稿已保存到 Home", "照片原件未修改；视频尚未导出"]);
    } catch (failure) { setError(errorText(failure)); } finally { setActing(false); }
  };
  const date = tagValue(selected, "captured_date"), place = tagValue(selected, "place");
  const heading = editor === "tags" ? "记住这一刻。" : editor === "selection" ? "挑选想留下的瞬间。" : scene === "review" ? "有些瞬间，一张就够。" : scene === "story" ? "把成长的片段，串成故事。" : "想重温，哪一刻？";
  let actions: { label: string; icon?: typeof Check; run: () => void; disabled?: boolean }[];
  if (editor === "tags") actions = [{ label: "保存标注", icon: Check, run: saveTags, disabled: acting }, { label: "返回照片", run: () => setEditor(null) }];
  else if (editor === "selection") actions = [{ label: `选好了 · ${selections.length} 张`, icon: Check, run: () => setEditor(null), disabled: !selections.length }, { label: "选中本页", run: () => setChosen((old) => Object.fromEntries([...Object.entries(old), ...photos.map((photo) => [photoKey(photo), photo] as const)].slice(0, 100))) }, { label: "返回", run: () => setEditor(null) }];
  else if (previewing) actions = [{ label: playing ? "暂停播放" : "继续播放", icon: playing ? Pause : Play, run: () => setPlaying(!playing) }, { label: "返回选片", run: () => { setPreviewing(false); setPlaying(false); } }, { label: "保存草稿", run: () => void saveStory(), disabled: acting }];
  else if (scene === "review") actions = [{ label: tagValue(selected, "selection") ? "已标记保留" : "标记保留", icon: Check, run: keep, disabled: acting || !selected || Boolean(tagValue(selected, "selection")) }, { label: sha ? "返回全部照片" : "查看相同副本", icon: Stack, run: () => { setSha(sha ? "" : selected?.file.sha256 ?? ""); setOffset(0); }, disabled: !selected }, { label: "下一张", icon: ArrowRight, run: nextPhoto, disabled: photos.length < 2 && (result?.total ?? 0) <= PAGE }];
  else if (scene === "story") actions = [{ label: "预览故事", icon: Play, run: () => { setFrame(0); setPreviewing(true); setPlaying(true); }, disabled: !frames.length }, { label: "调整选片", icon: Images, run: () => setEditor("selection") }, { label: "保存草稿", run: () => void saveStory(), disabled: !frames.length || acting }];
  else actions = [{ label: "做成一段回忆", icon: FilmStrip, run: () => onScene("story"), disabled: !photos.length }, { label: contentAgent.busy ? "AI 正在标注…" : "AI 自动标注", icon: contentAgent.busy ? CircleNotch : Sparkle, run: () => void contentAgent.run(), disabled: !selected || contentAgent.busy || contentAgent.loading }, { label: "换一刻", icon: ArrowRight, run: nextPhoto, disabled: photos.length < 2 && (result?.total ?? 0) <= PAGE }];

  if (available && scene === "classify") return <PhotoClassificationPanel services={services} navigation={navigation} hidden={hidden} onProgress={onProgress} onReturn={() => onScene("memory")} renderPhoto={(photo, small = true) => <PhotoImage item={photo} services={services} small={small} />} />;

  if (!available) return <aside className="treasure-panel" hidden={hidden} aria-label="相册">{navigation}<div className="treasure-panel__empty"><Tray size={35} /><h2>照片，留在你的空间里。</h2><p>请在家合原生应用中打开相册，查看授权空间里的照片。</p><button onClick={onOpenHome}>打开工作台<ArrowRight size={16} /></button></div></aside>;
  return <aside className="treasure-panel" hidden={hidden} aria-label="相册" data-scene={scene}>
    <header className="treasure-panel__header"><h2 className="treasure-panel__headline">{heading}</h2><span className="treasure-panel__meta">{busy ? "正在找照片…" : result ? `${result.total} 张${sha ? "相同内容照片" : "相关照片"}` : "本机照片"}</span></header>
    {navigation}
    <div className="treasure-panel__scroll">
      <FileImportButton service={available ? importer : undefined} resolveLibrary={available ? async () => (await services.photoLibraryQuery({ limit: 1 })).summary.library_id ?? "" : undefined} onProgress={onProgress} label="添加照片" accept="image/*,.heic,.heif,.dng,.cr2,.nef,.arw" />
      {error && <p className="treasure-panel__notice is-error" role="alert"><WarningCircle size={16} />{error}</p>}
      {notice && <p className="treasure-panel__notice" role="status"><Check size={16} />{notice}</p>}
      {!result && busy ? <div className="treasure-panel__empty"><CircleNotch className="room-spin" size={27} /><p>正在打开本机照片索引…</p></div> : !photos.length && editor !== "selection" && (scene !== "story" || !selections.length) ? <div className="treasure-panel__empty"><Images size={38} /><h3>{error ? "暂时没能打开相册。" : query ? "这次还没找到。" : "把照片放进来，回忆就有了地方。"}</h3><p>{error ? "请重新打开照片索引，或到工作台检查照片来源。" : query ? `文件名与已确认标签中没有“${query}”。` : "添加照片后会自动保存副本、分类，之后就能在这里找到。"}</p><div>{error ? <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>重新打开相册</button> : query ? <button onClick={() => onQuery("")}>查看全部照片</button> : <details className="treasure-existing"><summary>已有 Home 资料</summary><p>在本机整理当前 Home 文件，照片会出现在这里。</p><button disabled={acting || busy} onClick={() => void refresh()}>{acting ? <CircleNotch className="room-spin" size={16} /> : <Tray size={16} />}整理现有 Home</button></details>}<button onClick={onOpenHome}>管理照片来源<ArrowRight size={16} /></button></div></div> : editor === "tags" && selected ? <form className="treasure-tags" onSubmit={(event) => { event.preventDefault(); saveTags(); }}><div className="treasure-tags__photo"><PhotoImage item={selected} services={services} small /><span>{selected.file.name}</span></div>{([{ kind: "person", label: "人物", placeholder: "例如：小满" }, { kind: "place", label: "地点", placeholder: "例如：三亚" }, { kind: "event", label: "事件", placeholder: "例如：第一次看海" }, { kind: "captured_date", label: "拍摄日期", placeholder: "" }, { kind: "note", label: "想记住的话", placeholder: "这一刻有什么特别的？" }] as const).map(({ kind, label, placeholder }) => <label key={kind}>{label}<input type={kind === "captured_date" ? "date" : "text"} value={tagFields[kind]} maxLength={120} placeholder={placeholder} disabled={acting} onChange={(event) => setTagFields((old) => ({ ...old, [kind]: event.target.value }))} onInput={(event) => { if (kind === "captured_date") { const value = event.currentTarget.value; setTagFields((old) => ({ ...old, [kind]: value })); } }} onBlur={(event) => { const value = event.currentTarget.value; setTagFields((old) => ({ ...old, [kind]: value })); }} /></label>)}<p>标注由你确认，保存在本机；下次可以说“找照片：小满”。</p></form> : editor === "selection" ? <div className="treasure-selection">
        <div className="treasure-story-fields">
          <label>故事名称<input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder="例如：小满的十八年" /></label>
          <label>生日 · 用于计算年龄<input type="date" value={birthday} onChange={(event) => setBirthday(event.currentTarget.value)} onInput={(event) => setBirthday(event.currentTarget.value)} onBlur={(event) => setBirthday(event.currentTarget.value)} /></label>
        </div>
        <form className="treasure-find" onSubmit={(event) => { event.preventDefault(); onQuery(find.trim()); }}><input aria-label="按照片名字或标签查找" value={find} maxLength={120} onChange={(event) => setFind(event.target.value)} placeholder="按文件名、人物、地点或事件查找" /><button aria-label="查找照片"><ArrowRight size={17} /></button></form>
        <div className="treasure-selection__grid">{photos.map((photo) => <button aria-pressed={Boolean(chosen[photoKey(photo)])} aria-label={`选择 ${photo.file.name}`} key={photoKey(photo)} onClick={() => changeSelection(photo)}><PhotoImage item={photo} services={services} small /><span className="treasure-selection__check">{chosen[photoKey(photo)] && <Check size={15} />}</span><small>{photo.file.name}</small></button>)}</div>
        <div className="treasure-selection__paging"><button disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ArrowLeft size={15} />上一页</button><span>已选 {selections.length} 张 · 最多 100 张</span><button disabled={offset + PAGE >= (result?.total ?? 0) || busy} onClick={() => setOffset(offset + PAGE)}>下一页<ArrowRight size={15} /></button></div>
      </div> : scene === "story" ? <div className="treasure-story">
        {frames.length > 0 && <><div className="treasure-story__hero"><PhotoImage key={photoKey(frames[previewing ? frame % frames.length : frames.length - 1].photo)} item={frames[previewing ? frame % frames.length : frames.length - 1].photo} services={services} /><span>{previewing ? `${frame + 1} / ${frames.length}` : "选片草稿"}</span></div><div className="treasure-story__timeline">{frames.slice(0, 8).map(({ photo, captured, age }, index) => <button key={photoKey(photo)} onClick={() => { setFrame(index); setPreviewing(true); setPlaying(false); }} aria-label={`预览 ${photo.file.name}`}><PhotoImage item={photo} services={services} small /><span>{age !== null ? `${age} 岁` : captured || "日期待核对"}</span></button>)}</div></>}
        <p className="treasure-story__note">{birthday ? (missing.length ? `0—18 岁中有 ${missing.length} 个年龄段尚未选片，留给你慢慢补充。` : "0—18 岁的选片已经齐了。") : "在“调整选片”中填写生日与拍摄日期，即可按年龄串联。"}</p><p className="treasure-story__note">当前为照片故事预览，视频渲染尚未接入。</p>
      </div> : selected ? <div className="treasure-gallery">
        <div className="treasure-gallery__hero"><PhotoImage item={selected} services={services} />{tagValue(selected, "selection") && <span className="treasure-gallery__kept"><Check size={13} />已保留</span>}</div>
        <div className="treasure-gallery__caption"><span>{selected.file.name}</span><span>{[tagValue(selected, "person"), date, place].filter(Boolean).join(" · ") || "拍摄信息待标注"}</span></div>
        <AiContentCard agent={contentAgent} onManual={editTags} />
        <div className="treasure-gallery__strip">{photos.slice(Math.max(0, Math.min(current - 1, photos.length - 5)), Math.max(0, Math.min(current - 1, photos.length - 5)) + 5).map((photo) => <button className={photoKey(photo) === photoKey(selected) ? "is-selected" : ""} aria-pressed={photoKey(photo) === photoKey(selected)} aria-label={`查看 ${photo.file.name}`} key={photoKey(photo)} onClick={() => setCurrent(photos.findIndex((item) => photoKey(item) === photoKey(photo)))}><PhotoImage item={photo} services={services} small /></button>)}</div>
        {scene === "review" && <p className="treasure-story__note">{sha ? `${result?.total ?? 0} 张照片具有相同内容指纹。来源各自保留，标记不会删除原件。` : "先记下你想保留的照片，或检查这张照片是否有完全相同的副本。相似度与自动质量判断尚未接入。"}</p>}
        {scene === "memory" && <p className="treasure-gallery__note"><Tag size={13} />{tagValue(selected, "note") || "告诉悟空“人物是小满，事件是第一次看海”，让回忆有自己的名字。"}</p>}
      </div> : null}
    </div>
    {(photos.length > 0 || scene === "story" && selections.length > 0 || editor === "selection") && <footer className="treasure-panel__footer"><div className="treasure-panel__actions">{actions.map(({ label, icon: Icon, run, disabled }, index) => <button key={label} className={index === 0 ? "is-primary" : ""} disabled={disabled || busy} onClick={run}>{acting && index === 0 ? <CircleNotch size={16} className="room-spin" /> : Icon && <Icon size={16} />}{label}</button>)}</div><small>{scene === "story" ? "先留下故事，确认后再创作。" : "照片留在原处，每个决定都由你。"}</small></footer>}
  </aside>;
}
