import { useEffect, useState } from "react";
import { CalendarBlank, Check, EnvelopeSimple, Plugs, ShieldCheck, X } from "@phosphor-icons/react";
import * as api from "../api";
import type { ApprovalCard, McpConnector, Routine, SavedAgent, TeamPolicy } from "../api";

const browserPreview = () => typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const PREVIEW_CARDS: ApprovalCard[] = [
  {
    id: "apr_previewmail1",
    session_id: "tanvis",
    kind: "email",
    tool: "draft_email",
    title: "发送邮件",
    summary: "发给 ada@example.com：周报草稿",
    preview: { account: "工作邮箱", to: "ada@example.com", subject: "周报草稿", text: "本周三件事都已完成，下周一同步风险。" },
    status: "pending",
    created_at: "2026-10-14T10:05:00.000Z",
  },
  {
    id: "apr_previewwrite",
    session_id: "doc-manager",
    kind: "write",
    tool: "write_file",
    title: "写入文件",
    summary: "写入 notes/weekly.md",
    preview: { path: "notes/weekly.md", content: "# 周报\n\n三件已完成事项。" },
    status: "pending",
    created_at: "2026-10-14T10:04:00.000Z",
  },
];

const PREVIEW_ROUTINES: Routine[] = [
  {
    id: "rtn_previewcron1",
    label: "工作日早报",
    agent_id: "tanvis",
    prompt: "查看今天的待办，用三句话告诉我最重要的事。",
    enabled: true,
    trigger: { type: "cron", expr: "0 8 * * 1-5" },
    created_at: "2026-10-14T08:00:00.000Z",
    updated_at: "2026-10-14T08:00:00.000Z",
    last_status: "ran",
  },
];

const PREVIEW_POLICY: TeamPolicy = {
  version: 1,
  mode: "allow",
  rules: [{ from: "tanvis", to: "*", allow: true }],
};

const PREVIEW_CONNECTORS: McpConnector[] = [
  { id: "notes", label: "笔记连接器", url: "https://mcp.example/notes", auth: "oauth" },
];

function upsertCard(current: ApprovalCard[], card: ApprovalCard): ApprovalCard[] {
  const index = current.findIndex((item) => item.id === card.id);
  if (index < 0) return [card, ...current];
  return current.map((item) => item.id === card.id ? card : item);
}

function previewText(card: ApprovalCard): string {
  const text = card.preview.text ?? card.preview.content ?? card.preview.arguments;
  if (typeof text === "string") return text;
  try { return JSON.stringify(card.preview); } catch { return ""; }
}

export default function AgentAssistPanel({ agents }: { agents: SavedAgent[] }) {
  const preview = browserPreview();
  const [cards, setCards] = useState<ApprovalCard[]>(preview ? PREVIEW_CARDS : []);
  const [routines, setRoutines] = useState<Routine[]>(preview ? PREVIEW_ROUTINES : []);
  const [policy, setPolicy] = useState<TeamPolicy>(preview ? PREVIEW_POLICY : { version: 1, mode: "allow", rules: [] });
  const [connectors, setConnectors] = useState<McpConnector[]>(preview ? PREVIEW_CONNECTORS : []);
  const [message, setMessage] = useState<string | null>(preview ? "浏览器预览只更新本页状态，不会真正发信或调用外部服务。" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [routineLabel, setRoutineLabel] = useState("");
  const [routineAgent, setRoutineAgent] = useState(agents[0]?.id ?? "");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [routineKind, setRoutineKind] = useState<"cron" | "mail" | "todo">("cron");
  const [routineExpr, setRoutineExpr] = useState("0 8 * * 1-5");
  const [routineMatch, setRoutineMatch] = useState("");
  const [ruleFrom, setRuleFrom] = useState("*");
  const [ruleTo, setRuleTo] = useState("*");
  const [ruleAllow, setRuleAllow] = useState(true);
  const [connectorId, setConnectorId] = useState("");
  const [connectorLabel, setConnectorLabel] = useState("");
  const [connectorUrl, setConnectorUrl] = useState("");
  const [connectorAuth, setConnectorAuth] = useState<McpConnector["auth"]>("none");
  const [secret, setSecret] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [clientId, setClientId] = useState("");

  useEffect(() => {
    if (preview) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void api.approvalList().then((result) => { if (!disposed) setCards(result.cards ?? []); }).catch(() => undefined);
    void api.scheduleList().then((result) => { if (!disposed) setRoutines(result.routines ?? []); }).catch(() => undefined);
    void api.teamPolicyGet().then((result) => { if (!disposed && result.policy) setPolicy(result.policy); }).catch(() => undefined);
    void api.mcpConnectorsGet().then((result) => { if (!disposed) setConnectors(result.connectors ?? []); }).catch(() => undefined);
    void api.onApprovalEvent((event) => {
      if (event.card) setCards((current) => upsertCard(current, event.card));
    }).then((unlisten) => { if (disposed) unlisten(); else unlisteners.push(unlisten); });
    void api.onScheduleEvent((event) => {
      if (!event.routine) return;
      setRoutines((current) => {
        const index = current.findIndex((item) => item.id === event.routine.id);
        if (index < 0) return [event.routine, ...current];
        return current.map((item) => item.id === event.routine.id ? event.routine : item);
      });
    }).then((unlisten) => { if (disposed) unlisten(); else unlisteners.push(unlisten); });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [preview]);

  const decide = async (card: ApprovalCard, decision: "approve" | "deny") => {
    setBusy(card.id);
    setMessage(null);
    try {
      if (preview) {
        setCards((current) => current.map((item) => item.id === card.id ? {
          ...item,
          status: decision === "approve" ? "approved" : "denied",
          decided_at: new Date().toISOString(),
          summary: decision === "approve" && card.kind === "email" ? `${item.summary}（预览未真正发送）` : item.summary,
        } : item));
        return;
      }
      const result = await api.approvalDecide(card.id, decision);
      if (result.card) setCards((current) => upsertCard(current, result.card));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  };

  const saveRoutine = async () => {
    if (!routineLabel.trim() || !routinePrompt.trim() || !routineAgent) return;
    const trigger = routineKind === "cron"
      ? { type: "cron" as const, expr: routineExpr.trim() }
      : { type: "event" as const, source: routineKind, ...(routineMatch.trim() ? { match: routineMatch.trim() } : {}) };
    const draft = { label: routineLabel.trim(), agent_id: routineAgent, prompt: routinePrompt.trim(), enabled: true, trigger };
    setMessage(null);
    try {
      if (preview) {
        const routine: Routine = {
          ...draft,
          id: `rtn_${Date.now().toString(16)}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setRoutines((current) => [routine, ...current]);
      } else {
        const result = await api.schedulePut(draft);
        setRoutines((current) => [result.routine, ...current.filter((item) => item.id !== result.routine.id)]);
      }
      setRoutineLabel("");
      setRoutinePrompt("");
    } catch (error) {
      setMessage(String(error));
    }
  };

  const toggleRoutine = async (routine: Routine) => {
    const next = { ...routine, enabled: !routine.enabled };
    if (preview) {
      setRoutines((current) => current.map((item) => item.id === routine.id ? next : item));
      return;
    }
    try {
      const result = await api.schedulePut(next);
      setRoutines((current) => current.map((item) => item.id === result.routine.id ? result.routine : item));
    } catch (error) {
      setMessage(String(error));
    }
  };

  const removeRoutine = async (id: string) => {
    if (preview) {
      setRoutines((current) => current.filter((item) => item.id !== id));
      return;
    }
    try {
      await api.scheduleDelete(id);
      setRoutines((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      setMessage(String(error));
    }
  };

  const savePolicy = async (next: TeamPolicy) => {
    setPolicy(next);
    if (preview) return;
    try {
      const result = await api.teamPolicySet(next);
      setPolicy(result.policy);
    } catch (error) {
      setMessage(String(error));
    }
  };

  const saveConnector = async () => {
    const connector: McpConnector = {
      id: connectorId.trim(),
      label: connectorLabel.trim() || connectorId.trim(),
      url: connectorUrl.trim(),
      auth: connectorAuth,
    };
    if (!connector.id || !connector.url) return;
    setMessage(null);
    try {
      if (preview) {
        setConnectors((current) => [connector, ...current.filter((item) => item.id !== connector.id)]);
        setSecret("");
        return;
      }
      const saved = await api.mcpConnectorPut(connector);
      if (secret.trim() || tokenUrl.trim() || clientId.trim()) {
        await api.mcpOauthStore({
          connector_id: connector.id,
          ...(connector.auth === "bearer" && secret.trim() ? { token: secret } : {}),
          ...(connector.auth === "oauth" && secret.trim() ? { access_token: secret } : {}),
          ...(tokenUrl.trim() ? { token_url: tokenUrl.trim() } : {}),
          ...(clientId.trim() ? { client_id: clientId.trim() } : {}),
        });
      }
      setConnectors((current) => [saved.connector, ...current.filter((item) => item.id !== saved.connector.id)]);
      setSecret("");
      setMessage("连接器已保存。令牌只写入加密凭据，不会回显。");
    } catch (error) {
      setMessage(String(error));
    }
  };

  const pending = cards.filter((card) => card.status === "pending");

  return (
    <div className="agent-assist">
      {message && <p className="agent-assist-note">{message}</p>}

      <section className="agent-assist-block" aria-label="待审批操作">
        <header><ShieldCheck size={18} /><div><b>待你确认</b><span>写入、外部调用和发出邮件都会停在这里，批准后才继续。</span></div></header>
        {pending.length === 0 ? <p className="agent-assist-empty">当前没有等待批准的操作。</p> : (
          <ul className="agent-assist-cards">
            {pending.map((card) => (
              <li key={card.id}>
                <div className="agent-assist-card-kind">{card.kind === "email" ? "邮件草稿" : card.kind === "write" ? "写入" : "外部调用"}</div>
                <div>
                  <b>{card.title}</b>
                  <small>{card.summary}</small>
                  <pre>{previewText(card)}</pre>
                </div>
                <div className="agent-assist-card-actions">
                  <button type="button" disabled={busy === card.id} onClick={() => void decide(card, "approve")}><Check size={14} />{card.kind === "email" ? "批准并发送" : "批准"}</button>
                  <button type="button" disabled={busy === card.id} onClick={() => void decide(card, "deny")}><X size={14} />拒绝</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent-assist-block" aria-label="例行调度">
        <header><CalendarBlank size={18} /><div><b>例行与触发</b><span>用五段 cron，或在新邮件、新待办到达时跑一段已有 Agent 的例程。Agent 没启动就不会自动拉起。</span></div></header>
        <ul className="agent-assist-list">
          {routines.map((routine) => (
            <li key={routine.id}>
              <div>
                <b>{routine.label}</b>
                <small>{routine.trigger.type === "cron" ? `cron ${routine.trigger.expr}` : `${routine.trigger.source === "mail" ? "新邮件" : "新待办"}${routine.trigger.match ? ` · ${routine.trigger.match}` : ""}`} · {routine.agent_id}{routine.last_status ? ` · 上次${routine.last_status}` : ""}</small>
              </div>
              <button type="button" onClick={() => void toggleRoutine(routine)}>{routine.enabled ? "暂停" : "启用"}</button>
              <button type="button" onClick={() => void removeRoutine(routine.id)}>删除</button>
            </li>
          ))}
        </ul>
        <div className="agent-assist-form">
          <input value={routineLabel} onChange={(event) => setRoutineLabel(event.target.value)} placeholder="例程名称" />
          <select value={routineAgent} onChange={(event) => setRoutineAgent(event.target.value)}>
            {agents.length === 0 && <option value="">还没有 Agent</option>}
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
          </select>
          <select value={routineKind} onChange={(event) => setRoutineKind(event.target.value as "cron" | "mail" | "todo")}>
            <option value="cron">定时</option>
            <option value="mail">新邮件</option>
            <option value="todo">新待办</option>
          </select>
          {routineKind === "cron"
            ? <input value={routineExpr} onChange={(event) => setRoutineExpr(event.target.value)} placeholder="0 8 * * 1-5" />
            : <input value={routineMatch} onChange={(event) => setRoutineMatch(event.target.value)} placeholder="可选：账号或标题包含" />}
          <textarea value={routinePrompt} onChange={(event) => setRoutinePrompt(event.target.value)} placeholder="要 Agent 做的事" />
          <button type="button" onClick={() => void saveRoutine()} disabled={!routineLabel.trim() || !routinePrompt.trim() || !routineAgent}>保存例程</button>
        </div>
      </section>

      <section className="agent-assist-block" aria-label="委托策略">
        <header><ShieldCheck size={18} /><div><b>谁可以委托给谁</b><span>默认允许。规则按更具体的 from/to 优先；星号匹配所有人。改完会立刻作用到新的委托和消息。</span></div></header>
        <label className="agent-assist-inline">模式
          <select value={policy.mode} onChange={(event) => void savePolicy({ ...policy, mode: event.target.value as TeamPolicy["mode"] })}>
            <option value="allow">默认允许</option>
            <option value="deny">默认拒绝</option>
          </select>
        </label>
        <ul className="agent-assist-list">
          {policy.rules.map((rule, index) => (
            <li key={`${rule.from}-${rule.to}-${index}`}>
              <div><b>{rule.from} → {rule.to}</b><small>{rule.allow ? "允许" : "拒绝"}</small></div>
              <button type="button" onClick={() => void savePolicy({ ...policy, rules: policy.rules.filter((_, item) => item !== index) })}>移除</button>
            </li>
          ))}
        </ul>
        <div className="agent-assist-form">
          <input value={ruleFrom} onChange={(event) => setRuleFrom(event.target.value)} placeholder="from，* 或 session id" />
          <input value={ruleTo} onChange={(event) => setRuleTo(event.target.value)} placeholder="to，* 或 session id" />
          <select value={ruleAllow ? "yes" : "no"} onChange={(event) => setRuleAllow(event.target.value === "yes")}>
            <option value="yes">允许</option>
            <option value="no">拒绝</option>
          </select>
          <button type="button" onClick={() => void savePolicy({ ...policy, rules: [...policy.rules, { from: ruleFrom.trim() || "*", to: ruleTo.trim() || "*", allow: ruleAllow }] })}>添加规则</button>
        </div>
      </section>

      <section className="agent-assist-block" aria-label="MCP 连接器">
        <header><Plugs size={18} /><div><b>MCP 连接器</b><span>只连接你填写的 HTTP 地址，不启动本地命令。工具授权写在 Agent 的 mcp.md 里，一行一个 <code>连接器/工具</code>。改完后重新启动该 Agent，或在会话里重新读取授权。</span></div></header>
        <ul className="agent-assist-list">
          {connectors.map((connector) => (
            <li key={connector.id}>
              <div><b>{connector.label}</b><small>{connector.id} · {connector.auth} · {connector.url}</small></div>
              {!preview && <button type="button" onClick={() => void api.mcpListTools(connector.id).then((result) => setMessage(result.tools.map((tool) => `${connector.id}/${tool.name}`).join("\n") || "这个连接器没有列出工具")).catch((error) => setMessage(String(error)))}>列出工具</button>}
              <button type="button" onClick={() => {
                if (preview) setConnectors((current) => current.filter((item) => item.id !== connector.id));
                else void api.mcpConnectorDelete(connector.id).then(() => setConnectors((current) => current.filter((item) => item.id !== connector.id))).catch((error) => setMessage(String(error)));
              }}>删除</button>
            </li>
          ))}
        </ul>
        <div className="agent-assist-form">
          <input value={connectorId} onChange={(event) => setConnectorId(event.target.value)} placeholder="id，例如 notes" />
          <input value={connectorLabel} onChange={(event) => setConnectorLabel(event.target.value)} placeholder="显示名" />
          <input value={connectorUrl} onChange={(event) => setConnectorUrl(event.target.value)} placeholder="https://mcp.example/mcp" />
          <select value={connectorAuth} onChange={(event) => setConnectorAuth(event.target.value as McpConnector["auth"])}>
            <option value="none">无认证</option>
            <option value="bearer">Bearer</option>
            <option value="oauth">OAuth</option>
          </select>
          {connectorAuth !== "none" && <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={connectorAuth === "bearer" ? "访问令牌（只写入加密存储）" : "access token（只写入加密存储）"} autoComplete="off" />}
          {connectorAuth === "oauth" && <input value={tokenUrl} onChange={(event) => setTokenUrl(event.target.value)} placeholder="token URL，用于刷新" />}
          {connectorAuth === "oauth" && <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="client id" />}
          <button type="button" onClick={() => void saveConnector()} disabled={!connectorId.trim() || !connectorUrl.trim()}><EnvelopeSimple size={14} />保存连接器</button>
        </div>
        {!preview && agents.length > 0 && (
          <div className="agent-assist-form">
            <span>重新读取 mcp.md 授权</span>
            {agents.map((agent) => (
              <button key={agent.id} type="button" onClick={() => void api.mcpReload(agent.id).then((result) => setMessage(`${agent.label} 当前授权：${result.grants.join(", ") || "（无）"}`)).catch((error) => setMessage(String(error)))}>{agent.label}</button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
