import { ArrowLeft, ArrowRight, Check, CircleNotch, DownloadSimple, MagnifyingGlass, ShieldCheck, Storefront, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "../api";
import { roomMembers } from "../lib/aiOsRoom";
import { providerAllowedForMode } from "../lib/aiOsSetup";
import { BUILTIN_AGENT_STORE, installBuiltinAgent, SKILL_NAMES } from "../lib/roomWorkspaces";
import { useAiOsConnectionMode } from "./AiOsConnectionContext";
import RoomAgentAvatar from "./RoomAgentAvatar";
import "./workspace-panels.css";

export default function ApplicationsPanel({ settings, selectedId, running, tab, onTab, onSelect, onSave, onClose, hidden = false }: {
  settings: Settings; selectedId: string; running: Record<string, boolean>; tab: "residents" | "store";
  onTab: (tab: "residents" | "store") => void; onSelect: (id: string) => void; onSave: (settings: Settings) => Promise<void>; onClose: () => void; hidden?: boolean;
}) {
  const mode = useAiOsConnectionMode(), members = roomMembers(settings);
  const [query, setQuery] = useState(""), [focused, setFocused] = useState(BUILTIN_AGENT_STORE[0].id);
  const [detailOpen, setDetailOpen] = useState(false);
  const [choice, setChoice] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const working = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (tab === "store") setDetailOpen(false); }, [tab]);
  const providers = Object.entries(settings.providers).filter(([, config]) => providerAllowedForMode(config, mode));
  const currentProvider = settings.agents?.find((agent) => agent.id === selectedId)?.provider_name;
  const providerName = providers.some(([name]) => name === choice) ? choice : providers.find(([name]) => name === currentProvider)?.[0] ?? providers[0]?.[0] ?? "";
  const resident = members.find((member) => member.id === selectedId) ?? members[0];
  const saved = settings.agents?.find((agent) => agent.id === resident.id), item = BUILTIN_AGENT_STORE.find((entry) => entry.id === focused)!;
  const installed = Boolean(settings.agents?.some((agent) => agent.id === item.id));
  const store = BUILTIN_AGENT_STORE.filter((entry) => `${entry.name} ${entry.role} ${entry.description}`.includes(query.trim()));
  const install = async () => {
    if (working.current || !providerName) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await onSave(installBuiltinAgent(settings, item.id, providerName));
      if (alive.current) { setNotice(`${item.name}已住进盒子，选择后就能聊天。`); onSelect(item.id); onTab("residents"); }
    } catch { if (alive.current) setError("安装没有保存成功，请检查当前空间后重试。"); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  return <aside className="treasure-panel workspace-panel applications-panel" hidden={hidden} aria-label="智能体与 Agent Store">
    <header className="workspace-panel__header"><div><h2>挑一位伙伴，住进盒子。</h2></div><button aria-label="收起智能体，返回聊天" onClick={onClose}><X size={19} /></button></header>
    <div className="workspace-panel__tabs" role="group" aria-label="应用视图"><button aria-pressed={tab === "residents"} onClick={() => onTab("residents")}>我的 Agent</button><button aria-pressed={tab === "store"} onClick={() => onTab("store")}><Storefront size={16} />Agent Store</button></div>
    <div className="workspace-panel__scroll">
      {notice && <p className="workspace-panel__notice" role="status"><Check size={16} />{notice}</p>}
      {error && <p className="workspace-panel__error" role="alert">{error}</p>}
      {tab === "residents" ? <>
        <div className="resident-grid" aria-label="已安装 Agent">{members.map((member) => <button key={member.id} className={member.id === selectedId ? "is-selected" : ""} aria-pressed={member.id === selectedId} onClick={() => onSelect(member.id)}><RoomAgentAvatar id={member.id} name={member.name} busy={running[member.id]} /><b>{member.name}</b><small>{running[member.id] ? "正在处理" : settings.agents?.some((agent) => agent.id === member.id) ? "已安装" : "待配置"}</small></button>)}</div>
        <section className="agent-profile"><RoomAgentAvatar id={resident.id} name={resident.name} /><h3>{resident.name}</h3><p>{resident.hint}</p><dl><div><dt>模型</dt><dd>{saved ? settings.providers[saved.provider_name]?.model ?? "待配置" : "待配置"}</dd></div><div><dt>可用技能</dt><dd>{saved?.enabled_skills === undefined ? "沿用工作台技能配置" : saved.enabled_skills.length ? saved.enabled_skills.map((skill) => SKILL_NAMES[skill]).join("、") : "对话 · 未启用文件工具"}</dd></div></dl><p className="workspace-panel__hint">当前聊天属于{resident.name}，切换伙伴会保留各自的对话。</p></section>
        <button className="workspace-panel__primary" onClick={() => onTab("store")}><Storefront size={17} />去 Agent Store 看看<ArrowRight size={17} /></button>
      </> : <>
        {!detailOpen && <>
        <label className="workspace-panel__search"><MagnifyingGlass size={17} /><input aria-label="搜索内置 Agent" placeholder="找一个伙伴…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="agent-store-grid">{store.map((entry) => <button key={entry.id} onClick={() => { setFocused(entry.id); setDetailOpen(true); setError(""); }}><RoomAgentAvatar id={entry.id} name={entry.name} /><b>{entry.name}</b>{settings.agents?.some((agent) => agent.id === entry.id) && <em><Check size={12} />已安装</em>}</button>)}</div>
        {!store.length && <p className="workspace-panel__hint">没有匹配的伙伴，换一个关键词试试。</p>}</>}
        {detailOpen && <><button className="agent-store-back" disabled={busy} onClick={() => setDetailOpen(false)}><ArrowLeft size={16} />所有伙伴</button><section className="agent-store-detail is-detail-view"><RoomAgentAvatar id={item.id} name={item.name} /><h3>{item.name}</h3><p>{item.description}</p><small><ShieldCheck size={14} />{item.skills.length ? `启用：${item.skills.map((skill) => SKILL_NAMES[skill]).join("、")} · 操作仍经过 Vault` : "对话角色 · 不启用文件工具"}</small><label>使用模型<select aria-label="安装 Agent 使用的模型" value={providerName} disabled={busy} onChange={(event) => setChoice(event.target.value)}>{!providerName && <option value="">请先在设置中配置模型</option>}{providers.map(([name, config]) => <option key={name} value={name}>{name} · {config.model}</option>)}</select></label><button className="workspace-panel__primary" disabled={busy || !installed && !providerName} onClick={() => installed ? (onSelect(item.id), onTab("residents")) : void install()}>{busy ? <CircleNotch className="room-spin" size={17} /> : installed ? <Check size={17} /> : <DownloadSimple size={17} />}{busy ? "正在安装…" : installed ? "打开会话" : "安装到盒子"}</button></section></>}
        <p className="workspace-panel__hint">内置伙伴 · 本机安装 · 远程商店尚未接入</p>
      </>}
    </div>
  </aside>;
}
