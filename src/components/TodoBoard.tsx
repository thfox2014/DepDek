import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarBlank,
  Check,
  CircleNotch,
  EnvelopeSimple,
  Funnel,
  Plus,
  Queue,
  SquaresFour,
  UserCircle,
} from "@phosphor-icons/react";
import { enqueueTodo, listTodos, subscribeTodoChanges, updateTodo } from "../todoStore";
import type { TodoEnqueueInput, TodoItem, TodoLane, TodoPriority } from "../todoTypes";
import { TODO_LANES, TODO_PRIORITIES, todoPriorityLabel } from "../todoTypes";
import "./todo-board.css";

function sourceIcon(type: TodoItem["source"]["type"]) {
  if (type === "mail") return EnvelopeSimple;
  if (type === "calendar") return CalendarBlank;
  if (type === "agent") return SquaresFour;
  return type === "manual" ? UserCircle : Queue;
}

function sourceLabel(item: TodoItem): string {
  const typeLabel = item.source.type === "mail" ? "邮件" : item.source.type === "calendar" ? "日历" : item.source.type === "manual" ? "手动" : item.source.type === "agent" ? "Agent" : "外部消息";
  return `${typeLabel}${item.source.label ? ` · ${item.source.label}` : ""}`;
}

interface Props {
  notify: (message: string) => void;
}

export default function TodoBoard({ notify }: Props) {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | "all">("all");
  const [draft, setDraft] = useState("");
  const [draftPriority, setDraftPriority] = useState<TodoPriority>("other");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await listTodos());
    } catch (error) {
      notify(`读取待办队列失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void reload();
    return subscribeTodoChanges(() => void reload());
  }, [reload]);

  const filteredItems = useMemo(() => priorityFilter === "all" ? items : items.filter((item) => item.priority === priorityFilter), [items, priorityFilter]);
  const doneCount = items.filter((item) => item.lane === "done").length;
  const activeCount = items.filter((item) => item.lane !== "done").length;

  const moveItem = async (id: string, lane: TodoLane) => {
    const current = items.find((item) => item.id === id);
    if (!current || current.lane === lane) return;
    setSavingId(id);
    try {
      const next = await updateTodo({ id, lane });
      setItems((previous) => previous.map((item) => item.id === id ? next : item));
    } catch (error) {
      notify(`移动待办失败：${String(error)}`);
    } finally {
      setSavingId(null);
    }
  };

  const addManualTodo = async () => {
    const title = draft.trim();
    if (!title) return;
    const input: TodoEnqueueInput = {
      title,
      lane: "backlog",
      priority: draftPriority,
      source: { type: "manual", label: "待办面板" },
    };
    try {
      const item = await enqueueTodo(input);
      setItems((previous) => previous.some((candidate) => candidate.id === item.id) ? previous : [item, ...previous]);
      setDraft("");
      notify(`已加入待办队列：「${title.length > 24 ? `${title.slice(0, 24)}…` : title}」`);
    } catch (error) {
      notify(`创建待办失败：${String(error)}`);
    }
  };

  return <>
    <div className="dd-view-head dd-todo-head"><div><div className="dd-eyebrow">TASKS / 统一处理队列</div><h1>待办</h1></div><span>邮件、日历和外部消息都先进入队列，再由你安排处理</span></div>
    <section className="dd-todo-summary">
      <div><span className="dd-todo-summary-icon"><Queue size={18} /></span><span><b>{activeCount} 项待闭环</b><small>所有来源都归一到同一条工作队列</small></span></div>
      <div className="dd-todo-summary-metric"><strong>{doneCount}</strong><span>已办完</span></div>
      <label className="dd-todo-filter"><Funnel size={14} /><span>优先级</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as TodoPriority | "all")}><option value="all">全部</option>{TODO_PRIORITIES.map((priority) => <option key={priority.id} value={priority.id}>{priority.label}</option>)}</select></label>
    </section>
    <section className="dd-todo-add-bar"><Plus size={16} /><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void addManualTodo()} placeholder="把一个承诺放进队列…" /><select value={draftPriority} onChange={(event) => setDraftPriority(event.target.value as TodoPriority)} aria-label="新待办优先级">{TODO_PRIORITIES.map((priority) => <option key={priority.id} value={priority.id}>{priority.label}</option>)}</select><button onClick={() => void addManualTodo()}>加入待办</button></section>
    <section className="dd-todo-board" aria-label="待办敏捷面板">
      {TODO_LANES.map((lane) => {
        const laneItems = filteredItems.filter((item) => item.lane === lane.id);
        return <article className={`dd-todo-lane dd-todo-lane--${lane.id}`} key={lane.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) void moveItem(draggedId, lane.id); setDraggedId(null); }}>
          <header><div><b>{lane.label}</b><small>{lane.hint}</small></div><em>{laneItems.length}</em></header>
          <div className="dd-todo-lane-body">
            {loading ? <div className="dd-todo-loading"><CircleNotch className="dd-todo-spin" size={17} />读取队列…</div> : laneItems.length ? laneItems.map((item) => {
              const Icon = sourceIcon(item.source.type);
              return <div className={`dd-todo-card dd-todo-card--${item.priority}`} key={item.id} draggable onDragStart={() => setDraggedId(item.id)} onDragEnd={() => setDraggedId(null)}>
                <div className="dd-todo-card-top"><span className="dd-todo-priority">{todoPriorityLabel(item.priority)}</span><select value={item.lane} onChange={(event) => void moveItem(item.id, event.target.value as TodoLane)} disabled={savingId === item.id} aria-label={`移动待办：${item.title}`}>{TODO_LANES.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></div>
                <b className={item.lane === "done" ? "dd-todo-card-title--done" : ""}>{item.lane === "done" && <Check size={14} weight="bold" />}{item.title}</b>
                {item.description && <p>{item.description}</p>}
                <footer><span><Icon size={13} />{sourceLabel(item)}</span>{item.dueAt && <time>{new Date(item.dueAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time>}</footer>
                {item.lane !== "done" && <button className="dd-todo-next" onClick={() => void moveItem(item.id, item.lane === "backlog" ? "now" : item.lane === "now" ? "done" : "now")} aria-label={`推进待办：${item.title}`}><ArrowRight size={13} />{item.lane === "backlog" ? "马上办" : item.lane === "now" ? "完成" : "继续处理"}</button>}
              </div>;
            }) : <div className="dd-todo-lane-empty">拖动待办到这里</div>}
          </div>
        </article>;
      })}
    </section>
    <p className="dd-todo-footnote"><Queue size={13} />队列来源统一记录在本地 `todo/queue.json` · 邮件和日历事件可从原文一键加入</p>
  </>;
}
