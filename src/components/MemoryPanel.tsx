import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Brain, Check, Clock, FloppyDisk, ShieldCheck, Trash, X } from "@phosphor-icons/react";
import * as api from "../api";
import "./memory.css";

type MemoryTab = "team" | "pending" | "all";

const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const PREVIEW_ITEMS: api.MemoryRecord[] = [
  {
    id: "preview-team-1",
    scope: "team",
    kind: "procedure",
    text: "涉及外部写操作时，先给出预览并等待用户确认。",
    status: "confirmed",
    sensitivity: "private",
    confidence: 0.98,
    source_refs: ["settings/policy.json", "session:agent-team"],
    created_by: { type: "user", session_id: "user" },
    created_at: "0",
    updated_at: "0",
  },
  {
    id: "preview-candidate-1",
    scope: "team",
    kind: "fact",
    text: "用户通常在工作日晚上处理需要回复的邮件。",
    status: "candidate",
    sensitivity: "private",
    confidence: 0.78,
    source_refs: ["mail/QQ邮箱/1739.md", "calendar/events.json"],
    created_by: { type: "agent", engine: "pi", session_id: "agent-tanvis" },
    created_at: "0",
    updated_at: "0",
  },
];

const dateLabel = (value: string) => {
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  return Number.isNaN(date.getTime()) || value === "0" ? "刚刚" : date.toLocaleString("zh-CN", { hour12: false });
};

const statusLabel: Record<api.MemoryStatus, string> = {
  candidate: "待确认",
  confirmed: "已确认",
  rejected: "已拒绝",
  expired: "已过期",
  tombstoned: "已撤销",
};

export default function MemoryPanel() {
  const [tab, setTab] = useState<MemoryTab>("team");
  const [items, setItems] = useState<api.MemoryRecord[]>(browserPreview ? PREVIEW_ITEMS.filter((item) => item.status === "confirmed") : []);
  const [stats, setStats] = useState<api.MemoryStats | null>(browserPreview ? { total: 2, by_status: { confirmed: 1, candidate: 1 }, by_scope: { team: 2 }, malformed_events: 0, index_version: "preview" } : null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [sourceRefs, setSourceRefs] = useState("manual:user");
  const [loading, setLoading] = useState(!browserPreview);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(browserPreview ? "浏览器预览使用示例数据；桌面版会读取本地共享记忆。" : null);

  const load = useCallback(async () => {
    if (browserPreview) return;
    setLoading(true);
    setError(null);
    try {
      const statuses = tab === "pending" ? ["candidate" as api.MemoryStatus] : tab === "team" ? ["confirmed" as api.MemoryStatus] : undefined;
      const [result, currentStats] = await Promise.all([
        api.memoryQuery({ query: query || undefined, scopes: ["user", "team"], statuses, limit: 100, maxChars: 18_000 }),
        api.memoryStats(),
      ]);
      setItems(result.items);
      setStats(currentStats);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [query, tab]);

  useEffect(() => { void load(); }, [load]);

  const pendingCount = stats?.by_status.candidate ?? items.filter((item) => item.status === "candidate").length;
  const confirmedCount = stats?.by_status.confirmed ?? items.filter((item) => item.status === "confirmed").length;

  const updateItem = async (action: "confirm" | "reject" | "tombstone", item: api.MemoryRecord) => {
    if (browserPreview) {
      setItems((current) => action === "tombstone" || action === "reject" ? current.filter((entry) => entry.id !== item.id) : current.map((entry) => entry.id === item.id ? { ...entry, status: "confirmed" } : entry));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (action === "confirm") await api.memoryConfirm(item.id);
      if (action === "reject") await api.memoryReject(item.id);
      if (action === "tombstone") await api.memoryTombstone(item.id);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const propose = async () => {
    const text = draft.trim();
    if (!text) return;
    const refs = sourceRefs.split(",").map((value) => value.trim()).filter(Boolean);
    setSaving(true);
    setError(null);
    try {
      if (browserPreview) {
        setItems((current) => [{ id: `preview-${Date.now()}`, scope: "team", kind: "fact", text, status: "candidate", sensitivity: "private", confidence: 0.5, source_refs: refs, created_at: "0", updated_at: "0" }, ...current]);
      } else {
        await api.memoryPropose({ text, kind: "fact", scope: "team", sourceRefs: refs.length ? refs : ["manual:user"], sensitivity: "private", confidence: 0.5 });
        await load();
      }
      setDraft("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const tabs = useMemo(() => [
    { key: "team" as const, label: "共享记忆", count: confirmedCount },
    { key: "pending" as const, label: "待确认", count: pendingCount },
    { key: "all" as const, label: "全部记录", count: stats?.total ?? items.length },
  ], [confirmedCount, items.length, pendingCount, stats?.total]);

  return (
    <div className="dd-memory-page">
      <div className="dd-view-head">
        <div><div className="dd-eyebrow">MEMORY / AGENT TEAM</div><h1>共享记忆</h1></div>
        <span>Pi 和 DeepSeek Harness 使用同一套可审查、可撤销的长期记忆。</span>
      </div>
      <section className="dd-memory-shell">
        <header className="dd-memory-header">
          <div className="dd-memory-title"><Brain size={25} /><div><b>Agent Team 长期记忆</b><small>JSONL 事实源 · Rust Vault 审计 · 本地优先</small></div></div>
          <button className="dd-memory-refresh" onClick={() => void load()} disabled={loading}><ArrowClockwise size={15} className={loading ? "dd-memory-spin" : ""} />刷新</button>
        </header>
        <div className="dd-memory-trust"><ShieldCheck size={15} />Agent 只能提议候选记忆；确认、拒绝和撤销由你控制。当前索引：{stats?.index_version ?? "读取中"}</div>
        <div className="dd-memory-stats">
          <div><span>共享已确认</span><b>{confirmedCount}</b><small>user + team</small></div>
          <div><span>待确认候选</span><b>{pendingCount}</b><small>不会自动进入上下文</small></div>
          <div><span>记录总数</span><b>{stats?.total ?? items.length}</b><small>含历史状态</small></div>
          <div><span>异常事件</span><b>{stats?.malformed_events ?? 0}</b><small>{(stats?.malformed_events ?? 0) > 0 ? "建议重建" : "事件流正常"}</small></div>
        </div>
        {error && <div className="dd-memory-message"><WarningIcon />{error}</div>}
        <div className="dd-memory-toolbar">
          <div className="dd-memory-tabs">{tabs.map((entry) => <button key={entry.key} className={tab === entry.key ? "is-active" : ""} onClick={() => setTab(entry.key)}>{entry.label}<em>{entry.count}</em></button>)}</div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆内容或来源…" aria-label="搜索记忆" />
        </div>
        <div className="dd-memory-list">
          {loading ? <div className="dd-memory-empty">读取共享记忆…</div> : items.length ? items.map((item) => <article className={`dd-memory-card dd-memory-card--${item.status}`} key={item.id}>
            <div className="dd-memory-card-head"><span className="dd-memory-kind">{item.scope} · {item.kind}</span><span className={`dd-memory-status dd-memory-status--${item.status}`}>{statusLabel[item.status] ?? item.status}</span></div>
            <p>{item.text}</p>
            <div className="dd-memory-meta"><span>置信度 {Math.round(item.confidence * 100)}%</span><span>更新于 {dateLabel(item.updated_at)}</span></div>
            <div className="dd-memory-sources">来源：{item.source_refs.length ? item.source_refs.join(" · ") : "无来源"}</div>
            <div className="dd-memory-actions">
              {item.status === "candidate" && <><button className="dd-memory-primary" disabled={saving} onClick={() => void updateItem("confirm", item)}><Check size={14} />确认共享</button><button disabled={saving} onClick={() => void updateItem("reject", item)}><X size={14} />拒绝</button></>}
              {item.status === "confirmed" && <button disabled={saving} onClick={() => void updateItem("tombstone", item)}><Trash size={14} />撤销记忆</button>}
            </div>
          </article>) : <div className="dd-memory-empty"><Clock size={25} /><b>暂无符合条件的记忆</b><span>Agent 的候选会显示在“待确认”，确认后才会进入共享上下文。</span></div>}
        </div>
        <section className="dd-memory-propose">
          <div><b><FloppyDisk size={16} />手动提议一条共享记忆</b><small>保存后状态为“待确认”，不会立即影响 Agent。</small></div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：处理外部服务前先展示执行计划…" />
          <div className="dd-memory-propose-row"><input value={sourceRefs} onChange={(event) => setSourceRefs(event.target.value)} placeholder="来源引用，逗号分隔" /><button className="dd-memory-primary" disabled={saving || !draft.trim()} onClick={() => void propose()}>加入待确认</button></div>
        </section>
      </section>
    </div>
  );
}

function WarningIcon() {
  return <span className="dd-memory-warning" aria-hidden="true">!</span>;
}
