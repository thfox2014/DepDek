import { Check, CircleNotch, PencilSimple, Sparkle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { contentAgentError, prepareContentEvidence, type ContentAgentServices, type ContentTarget } from "../lib/contentEvidence";
import { isLocalProvider, providerAllowedForMode } from "../lib/aiOsSetup";
import { captureDebugError } from "../lib/debugCapture";
import { ROOM_AGENT_ID } from "../lib/aiOsRoom";
import { useAiOsConnectionMode } from "./AiOsConnectionContext";
import "./ai-content-agent.css";

export function useAiContentAgent(file: ContentTarget | undefined, libraryId: string, service: Partial<ContentAgentServices>, onProgress: (lines: string[]) => void) {
  const mode = useAiOsConnectionMode();
  const [annotation, setAnnotation] = useState<api.ContentAnnotation | null>(null), [settings, setSettings] = useState<api.Settings | null>(null);
  const [providerName, setProviderName] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [phase, setPhase] = useState(""), [error, setError] = useState("");
  const generation = useRef(0), working = useRef(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (service.settingsGet) void service.settingsGet().then((value) => {
      if (!alive) return;
      setSettings(value);
      const configured = value.agents?.find((agent) => agent.id === ROOM_AGENT_ID)?.provider_name;
      let preferred = "";
      try { preferred = window.localStorage.getItem("jiaho.content-agent.provider") ?? ""; } catch { /* preference only */ }
      setProviderName((old) => old && value.providers[old] ? old : (value.providers[preferred] ? preferred : configured && value.providers[configured] ? configured : Object.keys(value.providers)[0] ?? ""));
    }).catch(() => { /* analysis action will show a useful configuration error */ }); };
    refresh(); window.addEventListener(api.SETTINGS_CHANGED, refresh);
    return () => { alive = false; window.removeEventListener(api.SETTINGS_CHANGED, refresh); };
  }, [service.settingsGet]);
  useEffect(() => {
    const current = ++generation.current;
    setAnnotation(null); setError(""); setPhase(""); setBusy(false); setLoading(false); working.current = false;
    if (file && libraryId && service.contentAnnotationGet) {
      setLoading(true);
      void service.contentAnnotationGet({ libraryId, reference: { path: file.path, sha256: file.sha256 } }).then((saved) => { if (current === generation.current) setAnnotation(saved); })
        .catch((failure) => { if (current === generation.current) { setError(contentAgentError(failure)); captureDebugError("content_annotation_get", failure); } })
        .finally(() => { if (current === generation.current) setLoading(false); });
    }
    return () => { ++generation.current; };
  }, [file?.path, file?.sha256, libraryId, service.contentAnnotationGet]);
  const providers = Object.entries(settings?.providers ?? {}).filter(([, provider]) => providerAllowedForMode(provider, mode));
  const provider = settings?.providers[providerName];
  const chooseProvider = (value: string) => { setProviderName(value); try { window.localStorage.setItem("jiaho.content-agent.provider", value); } catch { /* preference only */ } };
  const run = async () => {
    if (!file || working.current || loading) return;
    if (!libraryId) { setError("当前文件来源尚未就绪，请更新列表后重试。"); return; }
    if (!provider || !service.contentAnalyze) { setError(contentAgentError(new Error("CONTENT_PROVIDER_REQUIRED"))); return; }
    if (!providerAllowedForMode(provider, mode)) { setError("本地模式只能使用本机模型，请选择本地服务。"); return; }
    const current = generation.current;
    const valid = () => current === generation.current;
    const progress = (value: string) => { if (valid()) { setPhase(value); onProgress(["AI Content Agent", value]); } };
    working.current = true; setBusy(true); setError("");
    try {
      const evidence = await prepareContentEvidence(file, libraryId, service, progress);
      if (!valid()) return;
      progress("正在分析内容，生成描述与标签…");
      const saved = await service.contentAnalyze({ libraryId, reference: { path: file.path, sha256: file.sha256 }, providerName, evidence, expectedRevision: annotation?.revision ?? 0 });
      if (valid()) { setAnnotation(saved); setPhase("AI 标注已保存，可以直接按内容搜索。"); onProgress(["AI Content Agent 已完成", "描述与标签已保存到本机文件索引", saved.coverage]); }
    } catch (failure) { captureDebugError("content_analyze", failure); if (valid()) { setError(contentAgentError(failure)); setPhase(""); } }
    finally { if (valid()) { working.current = false; setBusy(false); } }
  };
  const correct = async (title: string, description: string, tags: string[], photoLabels?: api.PhotoLabel[]) => {
    if (!annotation || !file || !service.contentAnnotationUpdate || working.current) return;
    const current = generation.current; working.current = true; setBusy(true); setError("");
    try {
      const saved = await service.contentAnnotationUpdate({ libraryId, reference: { path: file.path, sha256: file.sha256 }, expectedRevision: annotation.revision, title, description, tags, ...(photoLabels !== undefined ? { photoLabels } : {}) });
      if (current === generation.current) { setAnnotation(saved); setPhase("已保存你的修正。"); }
      return saved;
    } catch (failure) { if (current === generation.current) setError(contentAgentError(failure)); }
    finally { if (current === generation.current) { working.current = false; setBusy(false); } }
  };
  return { annotation, busy, loading, phase, error, providerName, provider, providers, chooseProvider, run, correct };
}
export type AiContentController = ReturnType<typeof useAiContentAgent>;

export function AiContentButton({ agent, disabled = false }: { agent: AiContentController; disabled?: boolean }) {
  return <button disabled={disabled || agent.busy || agent.loading} onClick={() => void agent.run()}>{agent.busy ? <CircleNotch className="room-spin" size={16} /> : <Sparkle size={16} />} {agent.busy ? "AI 正在标注…" : "AI 自动标注"}</button>;
}

export function AiContentCard({ agent, onManual }: { agent: AiContentController; onManual?: () => void }) {
  const { annotation: item } = agent;
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(""), [description, setDescription] = useState(""), [tags, setTags] = useState("");
  useEffect(() => { setEditing(false); }, [item?.path, item?.sha256, item?.revision]);
  return <section className={`ai-content-card ${agent.busy ? "is-working" : ""}`} aria-label="AI 内容标注">
    <header><span><Sparkle size={15} />AI Content Agent</span><small>{item ? item.source === "user_corrected" ? "已由你修正" : "AI 生成 · 已保存" : "内容分析"}</small></header>
    {agent.busy ? <p className="ai-content-card__phase" role="status"><CircleNotch className="room-spin" size={15} />{agent.phase}</p> : editing && item ? <form onSubmit={(event) => { event.preventDefault(); void agent.correct(title.trim(), description.trim(), [...new Set(tags.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean))]); }}>
      <label>标题<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label>内容描述<textarea value={description} maxLength={1600} rows={3} onChange={(event) => setDescription(event.target.value)} required /></label>
      <label>标签 · 逗号分隔<input value={tags} maxLength={730} onChange={(event) => setTags(event.target.value)} /></label>
      <div><button type="button" onClick={() => setEditing(false)}>取消</button><button type="submit"><Check size={14} />保存修正</button></div>
    </form> : item ? <>
      <h3>{item.title}</h3><p>{item.description}</p><div className="ai-content-card__tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      {item.observations.length > 0 && <dl>{item.observations.map((observation, index) => <div key={index}><dt>{observation.label}</dt><dd>{observation.value}</dd></div>)}</dl>}
      {item.uncertainties.length > 0 && <details><summary>还有这些无法确认</summary>{item.uncertainties.map((value, index) => <p key={index}>{value}</p>)}</details>}
      <footer><small>{item.coverage}</small><button onClick={() => { setTitle(item.title); setDescription(item.description); setTags(item.tags.join("，")); setEditing(true); }}><PencilSimple size={13} />修正</button></footer>
    </> : <p>让 AI 看懂内容，留下准确的描述和搜索标签。</p>}
    {agent.error && <p className="ai-content-card__error" role="alert">{agent.error}</p>}
    <details className="ai-content-card__model"><summary>{agent.provider ? `${agent.provider.model} · ${isLocalProvider(agent.provider) ? "本机分析" : "联网分析"}` : "选择内容分析模型"}{item && item.total_tokens > 0 ? ` · ${item.total_tokens.toLocaleString()} Token` : ""}</summary>
      <label>分析模型<select aria-label="AI 内容分析模型" value={agent.providers.some(([name]) => name === agent.providerName) ? agent.providerName : ""} disabled={agent.busy} onChange={(event) => agent.chooseProvider(event.target.value)}><option value="" disabled>请选择模型</option>{agent.providers.map(([name, provider]) => <option key={name} value={name}>{name} · {provider.model}</option>)}</select></label>
      <p>{agent.provider && !isLocalProvider(agent.provider) ? "点击自动标注后，当前文件的正文或取样画面将发送给这个模型；标注结果保存在本机。" : "点击自动标注后，当前内容由本机模型分析。"}图片、视频与扫描件需要视觉模型。</p>
      {item && <small>上次分析：{item.provider_name} · {item.model}</small>}{onManual && <button onClick={onManual}>补充人物、地点或日期</button>}
    </details>
  </section>;
}
