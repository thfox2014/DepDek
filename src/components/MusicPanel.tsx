import { ArrowRight, CircleNotch, FilmStrip, MagnifyingGlass, MusicNotes, Play, Sparkle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { queryMusic, checkedAudio, MAX_AUDIO_BYTES, type MusicServices } from "../lib/roomMusic";
import FileImportButton from "./FileImportButton";
import "./workspace-panels.css";

export default function MusicPanel({ tab, navigation, onOpenVideos, services: injected, hidden = false, onProgress, onAsk, onClose }: {
  tab: "music" | "films"; navigation?: ReactNode; onOpenVideos: () => void;
  services?: MusicServices; hidden?: boolean; onProgress: (lines: string[]) => void; onAsk: (text: string) => void; onClose: () => void;
}) {
  const service = injected ?? api, available = Boolean(injected) || typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [query, setQuery] = useState(""), [items, setItems] = useState<api.FileIndexRecord[]>([]), [loaded, setLoaded] = useState(false), [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false), [playing, setPlaying] = useState<api.FileIndexRecord | null>(null), [url, setUrl] = useState(""), [error, setError] = useState("");
  const generation = useRef(0), audio = useRef<HTMLAudioElement>(null), objectUrl = useRef("");
  useEffect(() => () => { ++generation.current; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  useEffect(() => { if (hidden) { ++generation.current; audio.current?.pause(); setLoading(false); } }, [hidden]);
  useEffect(() => { if (tab !== "music") audio.current?.pause(); }, [tab]);
  const search = async () => {
    if (!available || loading || hidden) return;
    const ticket = ++generation.current; setLoading(true); setError("");
    try { const result = await queryMusic(service, query); if (generation.current === ticket) { setItems(result.items); setPartial(result.partial); setLoaded(true); onProgress([`找到 ${result.items.length} 首本机音频${result.partial ? "（部分结果）" : ""}`, "仅查询已有索引，未扫描 Home 或读取音轨", "选择一首后在本机加载播放"]); } }
    catch { if (generation.current === ticket) setError("音乐索引没有读取成功，请检查当前空间后重试。"); }
    finally { if (generation.current === ticket) setLoading(false); }
  };
  const play = async (file: api.FileIndexRecord) => {
    if (loading || hidden) return;
    const ticket = ++generation.current; setLoading(true); setError(""); audio.current?.pause();
    try {
      const result = await service.vaultReadBinary(file.path), blob = checkedAudio(result, file);
      if (generation.current !== ticket) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob); setUrl(objectUrl.current); setPlaying(file);
      onProgress([`已在本机加载：${file.name}`, "音频经过 Vault 读取，未发送给模型", "点击播放器的播放键开始收听"]);
    } catch { if (generation.current === ticket) setError("音频未能加载：文件可能已变化、超出 64 MiB 或格式暂不支持。请刷新列表后重试。"); }
    finally { if (generation.current === ticket) setLoading(false); }
  };
  return <aside className="treasure-panel workspace-panel music-panel" hidden={hidden} aria-label="娱乐面板">
    <header className="workspace-panel__header"><div><h2>{tab === "music" ? "给此刻，配点音乐。" : "把想看的故事，留在这里。"}</h2></div><button aria-label="收起娱乐，返回聊天" onClick={onClose}><X size={19} /></button></header>
    {navigation}
    {tab === "films" ? <div className="workspace-panel__scroll films-scene">
      <button className="workspace-panel__primary" onClick={onOpenVideos}><FilmStrip size={17} />浏览本机视频<ArrowRight size={17} /></button>
      <button className="workspace-panel__text-action" onClick={() => onAsk("我想找一部适合现在看的电影，先问问我喜欢什么，再给我几个选择。")}>和悟空聊聊想看的内容 <Sparkle size={15} /></button>
    </div> : <div className="workspace-panel__scroll">
      <form className="workspace-panel__search" onSubmit={(event) => { event.preventDefault(); void search(); }}><MagnifyingGlass size={17} /><input aria-label="搜索本机音乐" placeholder="歌曲或文件名…" maxLength={120} value={query} onChange={(event) => setQuery(event.target.value)} /><button disabled={loading || !available}>查找</button></form>
      {!loaded && <button className="workspace-panel__primary" disabled={!available || loading} onClick={() => void search()}>{loading ? <CircleNotch className="room-spin" size={17} /> : <MusicNotes size={17} />}打开本机乐库<ArrowRight size={17} /></button>}
      {error && <p className="workspace-panel__error" role="alert">{error}</p>}
      {playing && url && <section className="music-now"><small>当前选择 · 未自动播放</small><h3>{playing.name}</h3><audio ref={audio} controls preload="metadata" src={url} aria-label={`播放 ${playing.name}`} onError={() => setError("系统播放器暂不支持这份音频的编码，原件保留。请换一首试试。")} /><p>{playing.path}</p></section>}
      {loaded && <section className="music-library"><header><h3>{items.length ? `${items.length} 首音乐` : "还没找到音乐"}</h3><button disabled={loading} onClick={() => void search()}>刷新</button></header>{items.map((file) => <button key={file.path} disabled={loading || file.size > MAX_AUDIO_BYTES} className={playing?.path === file.path ? "is-selected" : ""} onClick={() => void play(file)}><MusicNotes size={20} /><span><b>{file.name}</b><small>{file.path}</small></span><small>{(file.size / 1024 / 1024).toFixed(1)} MiB</small><Play size={17} /></button>)}<p className="workspace-panel__hint">{partial ? "当前是部分结果，可输入更具体的文件名查找。" : items.length ? "MP3 / WAV / OGG / FLAC · 单首最多 64 MiB" : "可以添加音频副本后刷新；已有 Home 音乐可在工作台显式更新索引。"}</p></section>}
      <FileImportButton service={injected?.fileLibraryImport} label="添加音乐" accept=".mp3,.wav,.ogg,.flac" onProgress={onProgress} resolveLibrary={available ? async () => (await service.fileIndexQuery({ limit: 1 })).summary.library_id ?? "" : undefined} />
      <button className="workspace-panel__text-action" onClick={() => onAsk("我想给家里的休息时光整理一份歌单。先和我聊聊喜欢的音乐。")}>让悟空陪我选音乐 ↗</button>
    </div>}
    <footer className="workspace-panel__footer">{tab === "films" ? "影视来源尚未接入；本机视频可在资料中浏览。" : "仅播放本机音频，尚未连接音乐平台。"}</footer>
  </aside>;
}
