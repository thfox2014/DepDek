import { useEffect, useState } from "react";
import { CircleNotch, Lightbulb, ShieldCheck, Sparkle } from "@phosphor-icons/react";
import { analyzeLocally, configuredAnalysisAgents, localAnalysisAgents, type AnalysisAgentOption, type AnalysisContext, type AnalysisResult, type MailSuggestionAction } from "../aiAdvisor";
import * as api from "../api";
import "./ai-analysis.css";

interface Props {
  context: AnalysisContext;
  compact?: boolean;
  preferredAgentId?: string;
}

export default function AIAnalysisPanel({ context, compact = false, preferredAgentId }: Props) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [agents, setAgents] = useState<AnalysisAgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remoteAllowed, setRemoteAllowed] = useState(false);
  const [remoteConsentKey, setRemoteConsentKey] = useState("");
  const preview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const [agentsReady, setAgentsReady] = useState(preview);
  const contextKey = `${context.title}|${context.sources.map((source) => source.path ?? source.label).join("|")}`;

  useEffect(() => {
    if (preview) return;
    void api.settingsGet().then((settings) => {
      // Mail/Tanvis may be explicitly configured with a cloud provider. Keep
      // that option visible so the user can opt in per analysis, while other
      // surfaces remain local-only by default.
      const next = preferredAgentId ? configuredAnalysisAgents(settings) : localAnalysisAgents(settings);
      setAgents(next);
      const preferred = preferredAgentId ? next.find((agent) => agent.id.toLowerCase() === preferredAgentId.toLowerCase() || agent.label.toLowerCase() === preferredAgentId.toLowerCase()) : undefined;
      setSelectedAgentId((current) => current && next.some((agent) => agent.id === current) ? current : preferred?.id ?? (preferredAgentId ? "" : next[0]?.id ?? ""));
    }).catch(() => undefined).finally(() => setAgentsReady(true));
  }, [preferredAgentId, preview]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId && (!preferredAgentId || agent.id.toLowerCase() === preferredAgentId.toLowerCase() || agent.label.toLowerCase() === preferredAgentId.toLowerCase()));
  const selectableAgents = preferredAgentId ? agents.filter((agent) => agent.id.toLowerCase() === preferredAgentId.toLowerCase() || agent.label.toLowerCase() === preferredAgentId.toLowerCase()) : agents;

  useEffect(() => {
    // Consent is scoped to the current mail/context. Selecting another agent
    // or another message must never silently reuse a previous cloud consent.
    setRemoteAllowed(false);
    setRemoteConsentKey("");
  }, [contextKey, selectedAgentId]);

  useEffect(() => {
    if (!agentsReady) return;
    let active = true;
    setLoading(true);
    setError(null);
    void analyzeLocally(context, selectedAgent, { requireAgent: Boolean(preferredAgentId), allowRemote: remoteAllowed && remoteConsentKey === contextKey }).then((next) => {
      if (active) setResult(next);
    }).catch((reason) => {
      if (active) setError(String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [agentsReady, context, contextKey, preferredAgentId, remoteAllowed, remoteConsentKey, selectedAgent]);

  const actionLabels: Record<MailSuggestionAction, string> = { delete: "建议删除", reply: "建议回复", todo: "建议加入待办", archive: "建议归档" };

  return (
    <section className={`dd-ai-analysis ${compact ? "dd-ai-analysis--compact" : ""}`} aria-label={`${context.title} AI 分析`}>
      <header className="dd-ai-analysis-head">
        <div><span className="dd-ai-analysis-label"><Sparkle size={14} />AI 分析 · 只给建议</span><b>{context.title}</b></div>
        <span className="dd-ai-analysis-boundary"><ShieldCheck size={12} />不自动处理</span>
      </header>
      <div className="dd-ai-analysis-agent-row"><div className="dd-ai-analysis-agent"><span>分析 Agent</span>{selectableAgents.length > 0 ? <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)} aria-label="选择分析 Agent">{selectableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label} · {agent.providerName} · {agent.isLocal ? "本地" : "云端（需确认）"}</option>)}</select> : <small>{preferredAgentId ? "未配置 Tanvis，将使用本地规则建议" : "未配置本地 Agent，将使用本地规则建议"}</small>}</div>{selectedAgent && !selectedAgent.isLocal && <label className="dd-ai-analysis-remote-consent"><input type="checkbox" checked={remoteAllowed && remoteConsentKey === contextKey} onChange={(event) => { setRemoteAllowed(event.target.checked); setRemoteConsentKey(event.target.checked ? contextKey : ""); }} />我确认将当前邮件内容发送到「{selectedAgent.providerName}」进行本次分析</label>}</div>
      {loading && <div className="dd-ai-analysis-loading"><CircleNotch size={16} className="dd-ai-analysis-spin" />{selectedAgent && !selectedAgent.isLocal ? "云端分析中…" : "本地分析中…"}</div>}
      {error && <div className="dd-ai-analysis-error">分析失败：{error}</div>}
      {!loading && result && <>
        {result.notice && <p className="dd-ai-analysis-notice">{result.notice}</p>}
        <div className="dd-ai-analysis-meta"><span>{result.model}</span><span>{result.sourceCount} 个来源</span></div>
        <div className="dd-ai-analysis-columns"><div className="dd-ai-analysis-column dd-ai-analysis-column--facts">{result.facts.length > 0 && <div className="dd-ai-analysis-section"><h4>事实</h4>{result.facts.map((fact, index) => <p key={`fact-${index}`}>{fact}</p>)}</div>}{result.inferences.length > 0 && <div className="dd-ai-analysis-section dd-ai-analysis-section--inference"><h4>推断</h4>{result.inferences.map((inference, index) => <p key={`inference-${index}`}>{inference}</p>)}</div>}</div><div className="dd-ai-analysis-column dd-ai-analysis-column--suggestions"><div className="dd-ai-analysis-section dd-ai-analysis-section--suggestions"><h4><Lightbulb size={14} />建议（需你确认）</h4>{result.suggestions.length ? result.suggestions.map((suggestion, index) => <article key={`${suggestion.title}-${index}`}><div><b>{suggestion.action ? <span className={`dd-ai-analysis-action dd-ai-analysis-action--${suggestion.action}`}>{actionLabels[suggestion.action]}</span> : null}{suggestion.title}</b><span>{suggestion.reason}</span></div><em>{suggestion.confidence !== undefined ? `${Math.round(suggestion.confidence * 100)}%` : "参考"}</em></article>) : <p>当前没有足够依据形成建议。</p>}</div></div></div>
      </>}
    </section>
  );
}
