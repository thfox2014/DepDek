import { ArrowLeft, ArrowRight, Check, CircleNotch, Images, Sparkle, Stack, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as api from "../api";
import type { PhotoServices } from "./TreasurePanel";
import { useAiContentAgent, AiContentCard } from "./AiContentAgent";
import { useAiOsConnectionMode } from "./AiOsConnectionContext";
import { isLocalProvider, providerAllowedForMode, providerEndpoint } from "../lib/aiOsSetup";
import { contentAgentError } from "../lib/contentEvidence";
import { classifyPhotoBatch, dimensionTitle, PHOTO_BATCH_LIMIT, PHOTO_DIMENSIONS, photoLabelCorrections, resolvedPhotoLabels, type PhotoBatchProgress } from "../lib/photoClassification";
import { FILE_LIBRARY_CHANGED } from "../lib/fileLibrary";
import "./photo-classification.css";

type Props = { services: PhotoServices; navigation?: ReactNode; hidden?: boolean; onReturn: () => void; onClose: () => void; onProgress: (lines: string[]) => void; renderPhoto: (photo: api.PhotoLibraryItem, small?: boolean) => ReactNode };
const initialFields = { people: "", event: "", place: "", subject: "" };
const queryError = (failure: unknown) => /E32006|Home changed|changed|not indexed/.test(String(failure)) ? contentAgentError(failure) : "暂时无法读取本机分类。请重试，或确认已使用新版原生应用。";

export default function PhotoClassificationPanel({ services, navigation, hidden = false, onReturn, onClose, onProgress, renderPhoto }: Props) {
  const mode = useAiOsConnectionMode();
  const [dimension, setDimension] = useState<api.PhotoDimension | undefined>();
  const [label, setLabel] = useState<string>(), [status, setStatus] = useState<"all" | "review" | "unclassified">("all");
  const [view, setView] = useState<"decks" | "photos">("decks"), [offset, setOffset] = useState(0), [groupOffset, setGroupOffset] = useState(0);
  const [result, setResult] = useState<api.PhotoClassificationResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<api.ClassifiedPhoto | null>(null), [revision, setRevision] = useState(0);
  const [batchBusy, setBatchBusy] = useState(false), [progress, setProgress] = useState<PhotoBatchProgress | null>(null), [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState(false), [fields, setFields] = useState(initialFields);
  const mounted = useRef(true), stopped = useRef(false), sequence = useRef(0), scope = useRef(""), hiddenRef = useRef(hidden), working = useRef(false);
  hiddenRef.current = hidden;
  const agent = useAiContentAgent(selected?.file, result?.summary.library_id ?? "", services, onProgress);
  const local = Boolean(agent.provider && isLocalProvider(agent.provider));
  const providerIdentity = agent.provider ? `${mode}:${agent.providerName}:${agent.provider.model}:${providerEndpoint(agent.provider)}` : "";
  const configuration = useRef(providerIdentity); configuration.current = providerIdentity;
  const modelAllowed = Boolean(agent.provider && providerAllowedForMode(agent.provider, mode));
  const rows = result?.items ?? [], libraryId = result?.summary.library_id ?? "";
  if (libraryId) scope.current = libraryId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; }; }, []);
  useEffect(() => { if (hidden) stopped.current = true; }, [hidden]);
  useEffect(() => { setConsent(false); }, [providerIdentity, dimension, label, status, offset, revision]);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener(FILE_LIBRARY_CHANGED, changed);
    return () => window.removeEventListener(FILE_LIBRARY_CHANGED, changed);
  }, []);
  useEffect(() => {
    const id = ++sequence.current;
    if (!services.photoClassificationQuery) { setError("分类服务尚未就绪，请使用新版原生应用。"); return; }
    setBusy(true); setError("");
    void services.photoClassificationQuery({ libraryId: scope.current || undefined, dimension, label, status, offset, limit: PHOTO_BATCH_LIMIT, groupOffset })
      .then((value) => { if (!value.summary.library_id) throw new Error("Home changed"); if (id === sequence.current) { setResult(value); scope.current = value.summary.library_id; } })
      .catch((failure) => { if (id === sequence.current) { setResult(null); setError(queryError(failure)); } })
      .finally(() => { if (id === sequence.current) setBusy(false); });
    return () => { sequence.current++; };
  }, [services, dimension, label, status, offset, groupOffset, revision]);

  const browse = (nextDimension?: api.PhotoDimension, nextStatus: typeof status = "all") => {
    setDimension(nextDimension); setStatus(nextStatus); setLabel(undefined); setOffset(0); setGroupOffset(0); setSelected(null); setEditing(false);
    setView(nextStatus === "all" ? "decks" : "photos");
  };
  const report = (value: PhotoBatchProgress) => {
    setProgress(value);
    onProgress(["悟空 · 照片分类", `本批 ${value.total} 张：新保存 ${value.completed}，已标注跳过 ${value.skipped}`, `失败 ${value.failed} 张${value.stopped ? " · 已停止后续请求" : ""}`, "只保存本机分类标签，照片原件未改动"]);
  };
  const run = async () => {
    if (working.current || !result || !agent.provider || busy || agent.busy) return;
    const jobScope = result.summary.library_id;
    if (!jobScope) { setError("当前照片空间尚未就绪，请重新打开相册。"); return; }
    stopped.current = false; working.current = true; setBatchBusy(true); setError("");
    const jobProvider = providerIdentity;
    const active = () => mounted.current && !stopped.current && !hiddenRef.current && scope.current === jobScope && configuration.current === jobProvider;
    try {
      const completed = await classifyPhotoBatch({ photos: [...rows], libraryId: jobScope, provider: agent.provider, providerName: agent.providerName, mode, allowRemote: consent, services, active, onProgress: report });
      if (mounted.current && scope.current === jobScope) { report(completed); setRevision((value) => value + 1); }
    } catch (failure) { if (mounted.current) setError(contentAgentError(failure)); }
    finally { working.current = false; if (mounted.current) setBatchBusy(false); }
  };
  const edit = () => {
    if (!selected || !agent.annotation) return;
    const values = resolvedPhotoLabels(selected, agent.annotation);
    setFields(Object.fromEntries(PHOTO_DIMENSIONS.map(({ id }) => [id, values.filter((item) => item.dimension === id).map((item) => item.label).join("，")])) as typeof fields);
    setEditing(true);
  };
  const save = async () => {
    if (!agent.annotation || !selected) return;
    let labels: api.PhotoLabel[];
    try { labels = photoLabelCorrections(selected, fields); }
    catch { setError("最多保存 12 个分类，每个名称不超过 60 字，不能包含控制字符。"); return; }
    const item = agent.annotation;
    const saved = await agent.correct(item.title, item.description, item.tags, labels);
    if (saved) { setEditing(false); setOffset(0); setRevision((value) => value + 1); onProgress(["已校验照片原件与修订版本", "你的分类修正已保存到本机 KV", "之后的 AI 分析不会覆盖这次确认"]); }
  };
  const shownLabels = selected ? resolvedPhotoLabels(selected, agent.annotation) : [];
  const disabled = batchBusy || agent.busy;
  const pending = rows.filter((photo) => !photo.analyzed).length;
  const hasPhotoView = view === "photos" || selected;
  const headline = selected ? "记住这一张。" : label ? `看看「${label}」的照片。` : status === "review" ? "留一点，给你确认。" : status === "unclassified" ? "还有照片等待归类。" : "照片分类，各归其位。";
  const back = () => { if (selected) { setSelected(null); setEditing(false); } else if (hasPhotoView) browse(dimension); else onReturn(); };

  return <aside className="treasure-panel photo-classification" aria-label="照片分类" hidden={hidden}>
    <header className="treasure-panel__header photo-classification__header"><button className="photo-classification__back" aria-label={selected ? "返回分类照片" : hasPhotoView ? "返回分类牌堆" : "返回相册"} disabled={disabled} onClick={back}><ArrowLeft size={17} /></button><h2 className="treasure-panel__headline">{headline}</h2><span className="treasure-panel__meta">{result ? `${result.counts.photos} 张` : "本机 KV"}</span><button type="button" className="treasure-panel__close" aria-label="收起相册，返回聊天" onClick={onClose}><X size={19} /></button></header>
    {navigation}
    <div className="treasure-panel__scroll">
      {!selected && <><nav className="photo-classification__dimensions" aria-label="照片分类维度"><button aria-pressed={!dimension && status === "all"} disabled={disabled} onClick={() => browse()}>全部</button>{PHOTO_DIMENSIONS.map((item) => <button key={item.id} title={item.hint} aria-pressed={dimension === item.id && status === "all"} disabled={disabled} onClick={() => browse(item.id)}>{item.title}</button>)}</nav><div className="photo-classification__status-nav"><button aria-pressed={status === "unclassified"} disabled={disabled} onClick={() => browse(undefined, "unclassified")}>待分析 {result?.counts.unclassified ?? "—"}</button><button aria-pressed={status === "review"} disabled={disabled} onClick={() => browse(undefined, "review")}>待确认 {result?.counts.review ?? "—"}</button></div></>}
      {error && <div className="treasure-panel__notice is-error" role="alert"><WarningCircle size={16} /><span>{error}{!selected && <button disabled={busy || disabled} onClick={() => setRevision((value) => value + 1)}>重新读取分类</button>}</span></div>}
      {busy && <p className="photo-classification__loading" role="status"><CircleNotch className="room-spin" size={18} />正在读取本机分类…</p>}
      {!busy && result && !result.counts.photos ? <div className="treasure-panel__empty"><Images size={34} /><h3>先放进一些照片。</h3><p>回到相册添加照片，再让悟空帮你整理。</p><button onClick={onReturn}>添加照片<ArrowRight size={16} /></button></div> : selected ? <>
        <div className="photo-classification__hero">{renderPhoto(selected, false)}</div><p className="photo-classification__filename">{selected.file.name}</p>
        <fieldset disabled={disabled} className="photo-classification__detail"><legend>分类与依据</legend>
          {editing ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>{PHOTO_DIMENSIONS.map(({ id, title }) => {
            const manual = selected.tags.some((tag) => tag.kind === ({ people: "person", event: "event", place: "place", subject: "" })[id]);
            return <label key={id}>{title}<input value={fields[id]} maxLength={240} readOnly={manual} onChange={(event) => setFields((old) => ({ ...old, [id]: event.target.value }))} placeholder="多个名称用逗号分隔" />{manual && <small>保留原有人工标注，可在相册的手动标注中修改。</small>}</label>;
          })}<small>清空某维度可撤回 AI 分类；原有人工标注不受影响。</small><div className="photo-classification__edit-actions"><button type="submit"><Check size={15} />保存确认</button><button type="button" onClick={() => setEditing(false)}>取消</button></div></form> : <>
            {shownLabels.length ? <ul>{shownLabels.map((item) => <li key={`${item.dimension}:${item.label}`}><span>{dimensionTitle(item.dimension)} / {item.label}<small>{item.source === "user" ? "用户确认" : item.confidence < 80 ? "AI 待确认" : "AI 建议"}</small></span><p>{item.evidence}</p></li>)}</ul> : <p>还没有可用分类；不会根据文件名猜内容。</p>}
            {agent.annotation && <button disabled={agent.loading} onClick={edit}>确认或修正分类<ArrowRight size={15} /></button>}
          </>}
        </fieldset>
        <AiContentCard agent={agent} />
      </> : !busy && result && view === "decks" ? <>
        <div className="photo-classification__decks" aria-label="分类牌堆">{result.groups.map((group) => <button className="photo-deck" key={`${group.dimension}:${group.label}`} disabled={disabled} aria-label={`打开${dimensionTitle(group.dimension)}分类：${group.label}，${group.total} 张照片`} onClick={() => { setDimension(group.dimension); setLabel(group.label); setStatus("all"); setOffset(0); setView("photos"); }}>
          <span className="photo-deck__stack"><i aria-hidden="true" /><i aria-hidden="true" />{group.covers.slice(0, 3).reverse().map((photo, index, covers) => <span key={photo.file.path} className={`photo-deck__card photo-deck__card--${covers.length - index - 1}`}>{renderPhoto(photo)}</span>)}<span className="photo-deck__count">{group.total}</span></span>
          <span className="photo-deck__label">{group.label}<ArrowRight size={14} /></span><small>{dimensionTitle(group.dimension)} · {group.confirmed === group.total ? "用户确认" : group.confirmed ? `${group.confirmed} 张已确认` : "AI 建议"}</small>
        </button>)}</div>
        {!result.groups.length && <div className="photo-classification__blank"><Stack size={30} /><h3>牌堆还在等一个名字。</h3><p>点击下方自动分类，或先在相册补充人物、地点和事件。低置信结果会留在“待确认”。</p></div>}
        {result.group_total > 24 && <div className="photo-classification__paging"><button disabled={!groupOffset || disabled} onClick={() => setGroupOffset(Math.max(0, groupOffset - 24))}>上一页</button><span>{groupOffset + 1}—{Math.min(groupOffset + 24, result.group_total)} / {result.group_total} 类</span><button disabled={groupOffset + 24 >= result.group_total || disabled} onClick={() => setGroupOffset(groupOffset + 24)}>下一页</button></div>}
      </> : !busy && result ? <>
        <div className="photo-classification__grid" aria-label="分类中的照片">{rows.map((photo) => <button key={photo.file.path} disabled={disabled} aria-label={`查看照片 ${photo.file.name}`} onClick={() => { setSelected(photo); setEditing(false); }}><span>{renderPhoto(photo)}</span><b>{photo.file.name}</b><small>{photo.needs_review ? "有分类待确认" : photo.labels.some((item) => item.source === "user") ? "含用户确认" : photo.analyzed ? "AI 建议" : "等待分析"}</small></button>)}</div>
        {!rows.length && <p className="photo-classification__blank">这一类暂时没有照片。</p>}
        <div className="photo-classification__paging"><button disabled={!offset || disabled} onClick={() => setOffset(Math.max(0, offset - PHOTO_BATCH_LIMIT))}><ArrowLeft size={14} />上一批</button><span>{result.total ? offset + 1 : 0}—{Math.min(offset + PHOTO_BATCH_LIMIT, result.total)} / {result.total}</span><button disabled={offset + PHOTO_BATCH_LIMIT >= result.total || disabled} onClick={() => setOffset(offset + PHOTO_BATCH_LIMIT)}>下一批<ArrowRight size={14} /></button></div>
      </> : null}
      {progress && <section className="photo-classification__progress" aria-label="批次结果" aria-live="polite"><b>{batchBusy ? "悟空正在整理" : progress.stopped ? "已停止后续处理" : progress.failed ? "本批部分完成" : "本批处理完成"}</b><p>新保存 {progress.completed} · 已有标注 {progress.skipped} · 失败 {progress.failed} / 本批 {progress.total} 张</p>{progress.failures.length > 0 && <details><summary>查看失败项</summary>{progress.failures.map((item) => <p key={item.path}>{item.path}：{item.message}</p>)}</details>}<small>停止不会撤回已保存结果；进行中的单张请求可能继续完成。</small></section>}
    </div>
    {!selected && <footer className="treasure-panel__footer photo-classification__footer">
      <details className="photo-classification__provider" open={!agent.provider}><summary>{agent.providerName || "选择视觉模型"} · {local ? "本机" : "联网"}</summary><label>分析模型<select aria-label="照片分类模型" value={agent.providers.some(([name]) => name === agent.providerName) ? agent.providerName : ""} disabled={disabled} onChange={(event) => agent.chooseProvider(event.target.value)}><option value="" disabled>选择视觉模型</option>{agent.providers.map(([name, provider]) => <option key={name} value={name}>{name} · {provider.model}</option>)}</select></label></details>
      <p>{local ? "本机分析 · 不外发照片" : `联网分析 · 目标：${agent.providerName || "尚未选择"}`}。每次最多 {PHOTO_BATCH_LIMIT} 张，结果存入本机 KV。</p>
      {!local && <label className="photo-classification__consent"><input type="checkbox" checked={consent} disabled={disabled || !agent.provider} onChange={(event) => setConsent(event.target.checked)} />允许将本批照片的缩略图发送给以上模型。</label>}
      <div className="treasure-panel__actions"><button className="is-primary" disabled={busy || disabled || !rows.length || !pending || !modelAllowed || !local && !consent} onClick={() => void run()}>{batchBusy ? <CircleNotch className="room-spin" size={16} /> : <Sparkle size={16} />}{batchBusy ? "正在分类…" : `自动分类 · 本批 ${rows.length} 张`}</button>{batchBusy ? <button onClick={() => { stopped.current = true; }}>停止后续</button> : <button disabled={busy} onClick={() => browse(undefined, "unclassified")}>整理待分析照片</button>}</div>
    </footer>}
  </aside>;
}
