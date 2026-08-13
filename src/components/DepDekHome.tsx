import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Books,
  Brain,
  CaretLeft,
  CaretRight,
  CalendarBlank,
  Check,
  CheckCircle,
  CheckSquare,
  ClipboardText,
  CirclesThreePlus,
  EnvelopeSimple,
  FileText,
  Folder,
  GearSix,
  HardDrives,
  LinkSimple,
  ListChecks,
  MagnifyingGlass,
  Minus,
  PaperPlaneTilt,
  Plus,
  Robot,
  ShieldCheck,
  Sparkle,
  SquaresFour,
  SidebarSimple,
  Tray,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import * as api from "../api";
import type { ChatBlock, SessionInfo } from "../App";
import type { TaskRecord, TaskReporter, TaskStartInput, TaskUpdate } from "../taskTypes";
import { enqueueTodo, listTodos, subscribeTodoChanges, updateTodo } from "../todoStore";
import type { TodoItem } from "../todoTypes";
import logo from "../assets/depdek-logo.png";
import CalendarView, { makePreviewEvents } from "./CalendarView";
import DataFilesPanel from "./DataFilesPanel";
import InboxView from "./InboxView";
import ObsidianPanel from "./ObsidianPanel";
import TodoBoard from "./TodoBoard";
import "./depdek-home.css";

type ViewName =
  | "today"
  | "calendar"
  | "todo"
  | "inbox"
  | "knowledge"
  | "files"
  | "automation"
  | "connections"
  | "memory"
  | "privacy";

interface Props {
  root: string;
  providerCount: number;
  sessionCount: number;
  onOpenAgentTeam: () => void;
  onOpenSettings: () => void;
  onPickRoot: () => void;
  sessions: SessionInfo[];
  activeAgentId: string | null;
  chats: Record<string, ChatBlock[]>;
  running: Record<string, boolean>;
  onSelectAgent: (id: string) => void;
  onSendAgent: (id: string, text: string) => Promise<void>;
  onAbortAgent: (id: string) => Promise<void>;
}

interface NavItem {
  key: ViewName;
  label: string;
  icon: Icon;
  badge?: string;
  badgeTone?: "warn";
}

const WORK_NAV: NavItem[] = [
  { key: "today", label: "今天", icon: SquaresFour },
  { key: "calendar", label: "日历", icon: CalendarBlank },
  { key: "todo", label: "待办", icon: CheckSquare },
  { key: "inbox", label: "收件箱", icon: Tray },
];

const DATA_NAV: NavItem[] = [
  { key: "knowledge", label: "知识", icon: Books },
  { key: "files", label: "文件", icon: Folder },
  { key: "automation", label: "自动化", icon: Robot },
  { key: "connections", label: "连接", icon: LinkSimple, badge: "1", badgeTone: "warn" },
];

const TRUST_NAV: NavItem[] = [
  { key: "memory", label: "记忆", icon: Brain, badge: "2", badgeTone: "warn" },
  { key: "privacy", label: "数据与隐私", icon: ShieldCheck },
];

const VIEW_TITLES: Record<ViewName, string> = {
  today: "今天",
  calendar: "日历",
  todo: "待办",
  inbox: "收件箱",
  knowledge: "知识",
  files: "文件",
  automation: "自动化",
  connections: "连接",
  memory: "记忆",
  privacy: "数据与隐私",
};

const pad = (n: number) => String(n).padStart(2, "0");
const TASK_HISTORY_PATH = "tasks/history.json";
const CALENDAR_EVENTS_PATH = "calendar/events.json";

type TimelineTone = "muted" | "now" | "accent";

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function parseEventDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimelineTime(event: api.CalendarEvent): string {
  if (event.all_day) return "全天";
  const start = parseEventDate(event.start);
  return start ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(start) : "--:--";
}

function formatUpcomingTime(event: api.CalendarEvent): string {
  if (event.all_day) {
    const start = parseEventDate(event.start);
    return start ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(start) + " 全天" : "日期待定";
  }
  const start = parseEventDate(event.start);
  return start ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(start) : "日期待定";
}

function timelineStatus(event: api.CalendarEvent, now: Date): { label: string; tone: TimelineTone } {
  if (event.all_day) return { label: "全天", tone: "accent" };
  const start = parseEventDate(event.start);
  const end = parseEventDate(event.end);
  if (!start || !end || end <= now) return { label: "已结束", tone: "muted" };
  if (start <= now) return { label: "进行中", tone: "now" };
  return { label: "即将开始", tone: "accent" };
}

function timelineMeta(event: api.CalendarEvent): string {
  return [event.location, event.source_name ? `来源：${event.source_name}` : "来源：本地日历"].filter(Boolean).join(" · ");
}

function ToolButtons() {
  return (
    <div className="dd-card-tools" aria-label="卡片工具">
      <button title="收起"><Minus size={13} /></button>
      <button title="调整布局"><SidebarSimple size={13} /></button>
    </div>
  );
}

function CardHeader({ tag, title }: { tag: string; title: string }) {
  return (
    <div className="dd-card-head">
      <div>
        <div className="dd-card-tag">{tag}</div>
        <div className="dd-card-title">{title}</div>
      </div>
      <ToolButtons />
    </div>
  );
}

function SourceNote({ children }: { children: React.ReactNode }) {
  return <div className="dd-card-source"><ShieldCheck size={12} />{children}</div>;
}

function StatusPill({ children, tone = "accent" }: { children: React.ReactNode; tone?: "accent" | "ok" | "warn" | "risk" | "muted" }) {
  return <span className={`dd-pill dd-pill--${tone}`}>{children}</span>;
}

function Timeline({ events, loading }: { events: api.CalendarEvent[]; loading: boolean }) {
  const now = new Date();
  const todayKey = dayKey(now);
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sortedEvents = [...events].filter((event) => parseEventDate(event.start)).sort((a, b) => a.start.localeCompare(b.start));
  const todayEvents = sortedEvents.filter((event) => {
    const start = parseEventDate(event.start);
    return start ? dayKey(start) === todayKey : false;
  });
  const upcomingEvents = sortedEvents.filter((event) => {
    const start = parseEventDate(event.start);
    return start ? start >= tomorrow : false;
  }).slice(0, 5);

  return (
    <div className="dd-timeline">
      {loading ? <div className="dd-timeline-empty"><b>正在读取日历…</b></div> : todayEvents.length ? todayEvents.map((event) => {
        const status = timelineStatus(event, now);
        return (
          <div className="dd-timeline-item" key={event.id}>
            <time>{formatTimelineTime(event)}</time>
            <span className={`dd-timeline-dot dd-timeline-dot--${status.tone}`} />
            <div className={`dd-timeline-body ${status.tone === "now" ? "dd-timeline-body--hot" : ""}`}>
              <div className="dd-timeline-title">
                {event.title}
                <StatusPill tone={status.tone === "now" ? "warn" : status.tone === "muted" ? "muted" : "accent"}>{status.label}</StatusPill>
              </div>
              <div className="dd-timeline-meta">{timelineMeta(event)}</div>
            </div>
          </div>
        );
      }) : <div className="dd-timeline-empty"><b>今日暂无安排</b><span>可以利用这段时间处理待办或安排新的日程</span></div>}

      {!!upcomingEvents.length && <div className="dd-timeline-upcoming">
        <div className="dd-timeline-section-label">接下来 5 项</div>
        {upcomingEvents.map((event) => <div className="dd-timeline-upcoming-item" key={event.id}>
          <time>{formatUpcomingTime(event)}</time>
          <span><b>{event.title}</b><small>{event.location || event.source_name || "日历安排"}</small></span>
        </div>)}
      </div>}
    </div>
  );
}

function TodayView({ notify, openAction }: { notify: (message: string) => void; openAction: () => void }) {
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<api.CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const loadTasks = useCallback(async () => {
    try {
      setTasks((await listTodos()).slice(0, 6));
    } catch (error) {
      notify(`读取今日待办失败：${String(error)}`);
    }
  }, [notify]);
  useEffect(() => {
    void loadTasks();
    return subscribeTodoChanges(() => void loadTasks());
  }, [loadTasks]);

  const loadCalendar = useCallback(async () => {
    setCalendarLoading(true);
    try {
      if (browserPreview) {
        setCalendarEvents(makePreviewEvents());
        return;
      }
      const result = await api.vaultReadFile(CALENDAR_EVENTS_PATH).catch(() => ({ content: "{\"version\":1,\"events\":[]}" }));
      const data = JSON.parse(result.content) as { events?: api.CalendarEvent[] };
      setCalendarEvents(data.events ?? []);
    } catch (error) {
      setCalendarEvents([]);
      notify(`读取今日日历失败：${String(error)}`);
    } finally {
      setCalendarLoading(false);
    }
  }, [browserPreview, notify]);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);
  const doneCount = tasks.filter((task) => task.lane === "done").length;

  const toggleTask = async (id: string) => {
    const current = tasks.find((task) => task.id === id);
    if (!current) return;
    try {
      const item = await updateTodo({ id, lane: current.lane === "done" ? "backlog" : "done" });
      setTasks((previous) => previous.map((task) => task.id === id ? item : task));
      notify("承诺状态已更新 · 已写入统一待办队列");
    } catch (error) {
      notify(`更新待办失败：${String(error)}`);
    }
  };

  const addTask = async () => {
    const title = draft.trim();
    if (!title) return;
    try {
      const item = await enqueueTodo({ title, source: { type: "manual", label: "今日概览" }, priority: "other", lane: "backlog" });
      setTasks((current) => [item, ...current].slice(0, 6));
      setDraft("");
      notify(`已在统一队列创建：「${title.length > 18 ? `${title.slice(0, 18)}…` : title}」`);
    } catch (error) {
      notify(`创建待办失败：${String(error)}`);
    }
  };

  return (
    <>
      <div className="dd-view-head">
        <div><div className="dd-eyebrow">HOME / 今日概览</div><h1>我的一天</h1></div>
        <span>拖动卡片排序 · 右上角调整尺寸 · 布局保存在本地</span>
      </div>
      <div className="dd-grid">
        <article className="dd-card dd-col-7 dd-card--timeline">
          <CardHeader tag="日程与时间轴 · 日历中枢" title="今日时间轴" />
          <Timeline events={calendarEvents} loading={calendarLoading} />
          <SourceNote>来源：本地日历中枢 · 已读取 {calendarEvents.length} 项日历事件</SourceNote>
        </article>

        <article className="dd-card dd-col-5 dd-card--tasks">
          <CardHeader tag="待办与任务" title="今天要完成的事" />
          <div className="dd-progress-head"><strong>{doneCount}</strong> / {tasks.length} 项 <span>{tasks.length ? `${Math.round(doneCount / tasks.length * 100)}%` : "暂无"}</span></div>
          <div className="dd-progress"><i style={{ width: `${tasks.length ? doneCount / tasks.length * 100 : 0}%` }} /></div>
          <div className="dd-task-list">
            {tasks.map((task) => (
              <button className={`dd-task ${task.lane === "done" ? "dd-task--done" : ""}`} key={task.id} onClick={() => void toggleTask(task.id)}>
                <span className="dd-check">{task.lane === "done" && <Check size={11} weight="bold" />}</span>
                <span><b>{task.title}</b><small>{task.source.type === "mail" ? "来源：邮件" : task.source.type === "calendar" ? "来源：日历" : task.source.label ?? "来源：待办队列"}</small></span>
                {task.lane === "blocked" && <StatusPill tone="warn">等待中</StatusPill>}
                {task.lane === "done" && <StatusPill tone="ok">已完成</StatusPill>}
              </button>
            ))}
          </div>
          <div className="dd-quick-add">
            <Plus size={15} />
            <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void addTask()} placeholder="试试输入「明天下午 3 点提醒我续费」" />
            <button onClick={() => void addTask()}>添加</button>
          </div>
          <SourceNote>统一队列 · 写回外部服务需逐次确认</SourceNote>
        </article>

        <article className="dd-card dd-col-4">
          <CardHeader tag="收件 · 审批 · 冲突" title="需要处理" />
          <button className="dd-attention-row" onClick={openAction}>
            <span className="dd-row-icon dd-row-icon--risk"><PaperPlaneTilt size={18} /></span>
            <span><b>高风险行动待审批</b><small>发送邮件给 Alice · 将写回外部服务</small></span>
            <StatusPill tone="risk">1 项</StatusPill>
          </button>
          <button className="dd-attention-row" onClick={() => notify("已打开收件箱筛选 · 3 封待回复") }>
            <span className="dd-row-icon dd-row-icon--info"><EnvelopeSimple size={18} /></span>
            <span><b>3 封邮件需要回复</b><small>含 2 个已抽取的行动项</small></span>
          </button>
          <button className="dd-attention-row" onClick={() => notify("冲突对比将在 Sync Engine 接通后可用") }>
            <span className="dd-row-icon dd-row-icon--warn"><Warning size={18} /></span>
            <span><b>1 条同步冲突</b><small>「团队周会」在两端均被修改</small></span>
          </button>
          <SourceNote>审批与回执全程可审计 · append-only</SourceNote>
        </article>

        <article className="dd-card dd-col-5">
          <CardHeader tag="项目脉搏 · 跨来源聚合" title="近期项目" />
          <div className="dd-project">
            <span className="dd-project-mark">D</span>
            <div><b>DepDek MVP 重构</b><small>里程碑「连接中心」· 3 个阻塞等待项</small><div className="dd-mini-progress"><i style={{ width: "62%" }} /></div></div>
            <StatusPill tone="accent">62%</StatusPill>
          </div>
          <div className="dd-project">
            <span className="dd-project-mark dd-project-mark--cyan">读</span>
            <div><b>阅读计划 · Local-first</b><small>本周已读 2 / 5 篇 · 下篇已标注 3 条笔记</small></div>
            <StatusPill tone="ok">节奏正常</StatusPill>
          </div>
          <div className="dd-project">
            <span className="dd-project-mark dd-project-mark--rose">财</span>
            <div><b>Q3 个人预算复盘</b><small>等待 Alice 确认数据 · 已等待 4 天</small></div>
            <button className="dd-small-button" onClick={() => notify("已生成跟进草稿 · 等待你确认")}>生成跟进</button>
          </div>
          <SourceNote>聚合自任务、邮件、日历和文档 · 均可回溯来源</SourceNote>
        </article>

        <article className="dd-card dd-col-3">
          <CardHeader tag="个人数据健康" title="系统与连接状态" />
          <div className="dd-health-meters">
            <div><span>CPU</span><i><b style={{ width: "28%" }} /></i><em>28%</em></div>
            <div><span>内存</span><i><b style={{ width: "78%" }} /></i><em>12.5 / 16 GB</em></div>
            <div><span>Home</span><i><b style={{ width: "40%" }} /></i><em>241 GB 可用</em></div>
          </div>
          <div className="dd-health-item"><Robot size={17} /><span><b>本地模型 Qwen3-8B</b><small>运行中 · 38 tok/s</small></span><StatusPill tone="ok">本地</StatusPill></div>
          <div className="dd-health-item"><EnvelopeSimple size={17} /><span><b>邮件连接</b><small>10 分钟前同步</small></span><StatusPill tone="ok">健康</StatusPill></div>
          <div className="dd-health-item"><CalendarBlank size={17} /><span><b>日历中枢</b><small>外部连接 10 分钟前同步</small></span><StatusPill tone="ok">健康</StatusPill></div>
          <SourceNote>断网仍可浏览、搜索与编辑</SourceNote>
        </article>

        <article className="dd-card dd-col-12 dd-suggestion-card">
          <CardHeader tag="DepDek 建议 · 可解释 · 可忽略" title="也许可以…" />
          <div className="dd-suggestions">
            <div><Sparkle size={20} /><span><b>把「预算对齐」前的 30 分钟设为准备时间块？</b><small>依据：你 3 次在类似会议前手动创建准备块 · 置信度 78%</small></span><button onClick={() => notify("已加入今日时间轴")}>采纳</button><button onClick={() => notify("已忽略建议")}>忽略</button></div>
            <div><CirclesThreePlus size={20} /><span><b>12 条「Q3 预算」相关记录，要整理成项目吗？</b><small>跨邮件 / 文档 / 日历共现分析 · 本地模型完成，未外发</small></span><button onClick={() => notify("已创建项目草稿")}>整理成项目</button></div>
          </div>
        </article>
      </div>
    </>
  );
}

const VIEW_COPY: Record<Exclude<ViewName, "today">, { eyebrow: string; title: string; lead: string; cards: Array<[string, string, string]> }> = {
  calendar: { eyebrow: "CALENDAR / 时间主权", title: "日历", lead: "先看见时间，再让模型提出建议；外部写回由你逐次确认。", cards: [["本周时间分配", "深度工作 11h · 会议 8h", "本地聚合"], ["冲突与建议", "周四 15:00 有一处重叠", "等待确认"], ["连接状态", "外部连接 10 分钟前同步", "来源可追溯"]] },
  todo: { eyebrow: "TASKS / 个人承诺", title: "待办", lead: "从邮件、日历和文档发现承诺，先确认，再进入执行系统。", cards: [["今天", "4 项 · 已完成 2 项", "本地记录"], ["待确认抽取", "2 项来自邮件", "模型推断"], ["等待中", "3 项等待他人", "建议跟进"]] },
  inbox: { eyebrow: "INBOX / 从信息到行动", title: "收件箱", lead: "统一处理邮件、行动项、草稿和需要你做决定的内容。", cards: [["需要回复", "3 封邮件", "IMAP 本地副本"], ["行动项", "2 项待你确认", "来源可回溯"], ["待发送草稿", "1 封高风险行动", "逐次审批"]] },
  knowledge: { eyebrow: "KNOWLEDGE / 可追溯的理解", title: "知识", lead: "跨来源检索你的文档、笔记和记录；事实、推断与建议严格分开。", cards: [["本地索引", "12,482 条记录", "SQLite FTS"], ["最近知识", "Q3 预算口径备忘", "来自本地文件"], ["语义检索", "可关闭且不影响全文搜索", "本地模型"]] },
  files: { eyebrow: "FILES / 开放的数据家园", title: "文件", lead: "现有 Vault 继续作为本地文件信任边界，并逐步迁移到 Personal Data Home。", cards: [["当前 Home", "已连接本地目录", "Rust Vault"], ["对象与记录", "Home v2 待实现", "不伪装为已接通"], ["可验证导出", "JSONL / Markdown / ICS", "开放格式"]] },
  automation: { eyebrow: "AUTOMATION / 有边界的代理", title: "自动化", lead: "低风险任务可以自动执行；越接近外部世界，审批越明确。", cards: [["运行中", "3 条本地整理规则", "无需联网"], ["等待审批", "发送邮件给 Alice", "高风险"], ["失败队列", "日历权限即将到期", "需处理"]] },
  connections: { eyebrow: "CONNECTIONS / 数据回到本地", title: "连接", lead: "服务是数据源和行动通道，DepDek 才是你的长期主数据层。", cards: [["邮件", "10 分钟前同步", "凭据将迁移到钥匙串"], ["日历", "本地中枢 · 可选写回", "固定权限范围"], ["本地文件", "索引健康", "Rust 沙箱"]] },
  memory: { eyebrow: "MEMORY / 你定义你自己", title: "记忆", lead: "模型推断先进入待确认；每条记忆都有来源、置信度、有效期和使用记录。", cards: [["待确认", "2 条候选记忆", "模型推断"], ["已确认", "9 条长期记忆", "用户治理"], ["本月删除", "5 条", "删除立即生效"]] },
  privacy: { eyebrow: "PRIVACY / 数据去哪了", title: "数据与隐私", lead: "每次数据访问、模型外发和外部写操作都应该留下可理解的凭证。", cards: [["本地数据", "83.6 GB · 100% 本机", "Personal Data Home"], ["云端外发", "本月 3 次", "均有回执"], ["凭据", "0 条进入数据目录", "OS Keychain 目标"]] },
};

function FilesView({ root }: { root: string }) {
  return (
    <>
      <div className="dd-view-head">
        <div><div className="dd-eyebrow">FILES / PERSONAL DATA HOME</div><h1>文件</h1></div>
        <span>Agent Team 的文件管理已迁移到这里 · 浏览、筛选和预览都在本地完成</span>
      </div>
      <section className="dd-files-shell">
        <header className="dd-files-header">
          <div className="dd-files-title"><HardDrives size={25} /><div><b>我的数据</b><small title={root}>{root}</small></div></div>
          <span className="dd-files-local"><ShieldCheck size={14} />本地 Home · 操作写入审计</span>
        </header>
        <DataFilesPanel variant="page" />
      </section>
    </>
  );
}

function DomainView({ name, root, providerCount, sessionCount, openAgentTeam, notify, onStartTask, onUpdateTask, onInboxCountChange }: { name: Exclude<ViewName, "today">; root: string; providerCount: number; sessionCount: number; openAgentTeam: () => void; notify: (message: string) => void; onInboxCountChange: (previewCount?: number) => void } & TaskReporter) {
  if (name === "inbox") return <InboxView onStartTask={onStartTask} onUpdateTask={onUpdateTask} onInboxCountChange={onInboxCountChange} />;
  if (name === "calendar") return <CalendarView onStartTask={onStartTask} onUpdateTask={onUpdateTask} />;
  if (name === "todo") return <TodoBoard notify={notify} />;
  if (name === "files") return <FilesView root={root} />;
  if (name === "knowledge") return <ObsidianPanel />;
  const view = VIEW_COPY[name];
  return (
    <>
      <div className="dd-view-head"><div><div className="dd-eyebrow">{view.eyebrow}</div><h1>{view.title}</h1></div><span>{view.lead}</span></div>
      <div className="dd-domain-grid">
        {view.cards.map(([title, value, note], index) => (
          <article className="dd-domain-card" key={title}>
            <span className="dd-domain-index">0{index + 1}</span>
            <h2>{title}</h2><strong>{value}</strong><p>{note}</p>
            {name === "connections" && index === 0 && <button onClick={() => notify("邮件连接详情来自当前 Vault 配置")}>查看连接</button>}
          </article>
        ))}
      </div>
      <article className="dd-card dd-domain-note">
        <CardHeader tag="实施边界" title="这部分正在按 PRD 逐步接通" />
        <p>当前版本保留真实 Vault、邮件、Agent、Provider 与审计能力；Home v2、Credential Broker、Connector SDK、Model Gateway 和 Action Engine 会按重构路线分阶段替换这些原型状态。</p>
        <div className="dd-domain-actions"><button onClick={openAgentTeam}>进入 Agent Team</button><button onClick={() => notify(`当前 Provider ${providerCount} 个 · Agent ${sessionCount} 个`)}>查看运行摘要</button></div>
        <SourceNote>当前数据目录：{root}</SourceNote>
      </article>
    </>
  );
}

function TaskCenter({ open, tasks, close }: { open: boolean; tasks: TaskRecord[]; close: () => void }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  if (!open) return null;
  const running = tasks.filter((task) => task.status === "running");
  const recent = tasks.filter((task) => task.status !== "running").slice(0, 6);
  const statusLabel = (status: TaskRecord["status"]) => status === "running" ? "执行中" : status === "success" ? "已完成" : "失败";
  const taskProgress = (task: TaskRecord) => {
    if (!task.progress) return null;
    const total = task.progress.total ?? 0;
    const percent = total > 0 ? Math.min(100, Math.round(task.progress.current / total * 100)) : 0;
    return <div className="dd-task-progress"><div><i style={{ width: `${percent}%` }} /></div><small>{task.progress.label ?? "处理中"} · {total > 0 ? `${task.progress.current}/${total}` : task.progress.current}</small></div>;
  };
  const taskLogs = (task: TaskRecord) => task.logs.length > 0 && <div className="dd-task-logs" aria-label={`${task.title} 日志`}>
    {task.logs.slice(-4).map((log, index) => <div className={`dd-task-log dd-task-log--${log.level}`} key={`${log.ts}-${index}`}><time>{new Date(log.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{log.message}</span></div>)}
  </div>;
  const taskRow = (task: TaskRecord) => <div className={`dd-task-row dd-task-row--${task.status}`} key={task.id} role="button" tabIndex={0} onClick={() => setSelectedTaskId(task.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedTaskId(task.id); } }}><span className="dd-task-status-dot" /><div><b>{task.title}</b><small>{task.detail}{task.message ? ` · ${task.message}` : ""}</small>{taskProgress(task)}{taskLogs(task)}<span className="dd-task-open-log">查看完整日志{task.logs.length > 4 ? ` · ${task.logs.length} 条` : ""}</span></div><em>{statusLabel(task.status)}</em></div>;
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined;
  return <>
    <section className="dd-task-center" role="dialog" aria-modal="false" aria-label="任务中心">
      <header><div><b>任务</b><small>{running.length ? `${running.length} 项正在执行` : "所有任务均已处理"}</small></div><button onClick={close} aria-label="关闭任务中心"><X size={17} /></button></header>
      <div className="dd-task-center-body">
        {running.length > 0 && <div className="dd-task-center-label">正在执行</div>}
        {running.map(taskRow)}
        {recent.length > 0 && <div className="dd-task-center-label">最近任务</div>}
        {recent.map(taskRow)}
        {tasks.length === 0 && <div className="dd-task-center-empty"><ClipboardText size={26} /><b>还没有执行中的任务</b><span>当你收取邮件或运行本地整理时，任务会显示在这里。</span></div>}
      </div>
      <footer><ShieldCheck size={13} />完整日志已备份到本地 `tasks/history.json`</footer>
    </section>
    {selectedTask && <div className="dd-task-log-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedTaskId(null)}><section className="dd-task-log-dialog" role="dialog" aria-modal="true" aria-label={`${selectedTask.title} 完整日志`}><header><div><b>{selectedTask.title}</b><small>{selectedTask.status === "running" ? "后台执行中" : selectedTask.status === "success" ? "执行完成" : "执行失败"} · {selectedTask.logs.length} 条日志</small></div><button onClick={() => setSelectedTaskId(null)} aria-label="关闭完整日志"><X size={17} /></button></header><div className="dd-task-log-summary"><span>{selectedTask.detail}</span>{selectedTask.message && <span>{selectedTask.message}</span>}</div><div className="dd-task-log-full">{selectedTask.logs.length ? selectedTask.logs.map((log, index) => <div className={`dd-task-log dd-task-log--${log.level}`} key={`${log.ts}-${index}`}><time>{new Date(log.ts).toLocaleString("zh-CN", { hour12: false })}</time><span>{log.message}</span></div>) : <span>暂无日志</span>}</div><footer><span>来源：任务中心 · 本地备份</span><button onClick={() => setSelectedTaskId(null)}>返回任务</button><button className="dd-task-log-primary" onClick={close}>关闭任务中心</button></footer></section></div>}
  </>;
}

function CommandPalette({ open, close, go, openAction }: { open: boolean; close: () => void; go: (view: ViewName) => void; openAction: () => void }) {
  if (!open) return null;
  return (
    <div className="dd-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="dd-palette" role="dialog" aria-modal="true" aria-label="全局指令栏">
        <div className="dd-palette-input"><MagnifyingGlass size={20} /><input autoFocus placeholder="搜索、导航、创建、提问、行动… 一句话即可" onKeyDown={(event) => event.key === "Escape" && close()} /><kbd>Esc</kbd></div>
        <span className="dd-palette-section">找到的信息 · 事实命中</span>
        <button onClick={() => { go("inbox"); close(); }}><EnvelopeSimple size={19} /><span><b>Alice · Re: Q3 预算表 v2 已更新</b><small>邮件 · 今天 17:42 · 含 1 个待确认行动项</small></span><StatusPill tone="ok">事实</StatusPill></button>
        <button onClick={() => { go("knowledge"); close(); }}><FileText size={19} /><span><b>Q3 预算口径备忘</b><small>笔记 · 敏感度：个人 · 本地命中</small></span><StatusPill tone="ok">事实</StatusPill></button>
        <span className="dd-palette-section">准备执行的行动 · 需确认</span>
        <button onClick={() => { close(); openAction(); }}><PaperPlaneTilt size={19} /><span><b>发送邮件给 Alice（草稿已就绪）</b><small>高风险 · 打开 Action Sheet 审批</small></span><StatusPill tone="risk">行动</StatusPill></button>
      </div>
    </div>
  );
}

function ActionSheet({ open, close, notify }: { open: boolean; close: () => void; notify: (message: string) => void }) {
  if (!open) return null;
  return (
    <div className="dd-sheet-wrap" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="dd-sheet" role="dialog" aria-modal="true" aria-label="高风险行动审批">
        <header><span className="dd-sheet-icon"><PaperPlaneTilt size={24} /></span><div><h2>发送邮件：Re: Q3 预算表 v2 已更新</h2><p>高风险行动 · 将写回外部服务 · 不可撤销 · Action #A-1042</p></div><StatusPill tone="risk">高风险 · 逐次确认</StatusPill></header>
        <div className="dd-sheet-body">
          <h3>执行计划</h3>
          {["读取草稿与你确认过的口径备忘，组装最终邮件正文", "执行前校验连接权限和源内容版本", "经 Credential Broker 使用钥匙串凭据发送", "写入远端 ID、时间和 append-only 回执"].map((step, index) => <div className="dd-step" key={step}><span>{index + 1}</span><p>{step}</p></div>)}
          <h3>数据范围与外发</h3>
          <div className="dd-scope-grid"><div><small>读取范围</small><b>草稿 1 封 · 备忘 1 篇</b></div><div><small>写入范围</small><b>SMTP 发送 1 封</b></div><div><small>使用模型</small><b>本地 Qwen3-8B</b></div><div><small>云端外发</small><b>无</b></div></div>
          <h3>正文变更预览</h3>
          <div className="dd-diff"><del>「数据看起来没问题。」</del><ins>「口径我核对过了：订阅按年摊销、硬件计入当月，与备忘一致。两处小数差已在批注标出。」</ins></div>
        </div>
        <footer><p>这是 UX 原型：当前后端尚未接通 SMTP Action Engine，不会真的发送邮件。</p><button onClick={close}>拒绝</button><button onClick={() => notify("草稿编辑将在 Action Engine 阶段接通")}>编辑草稿</button><button className="dd-primary" onClick={() => { close(); notify("原型审批已记录 · 未执行外部写操作"); }}>确认原型流程</button></footer>
      </section>
    </div>
  );
}

function Copilot({
  open,
  close,
  activeView,
  sessions,
  activeAgentId,
  chats,
  running,
  onSelectAgent,
  onSendAgent,
  onAbortAgent,
  onOpenAgentTeam,
}: {
  open: boolean;
  close: () => void;
  activeView: ViewName;
  sessions: SessionInfo[];
  activeAgentId: string | null;
  chats: Record<string, ChatBlock[]>;
  running: Record<string, boolean>;
  onSelectAgent: (id: string) => void;
  onSendAgent: (id: string, text: string) => Promise<void>;
  onAbortAgent: (id: string) => Promise<void>;
  onOpenAgentTeam: () => void;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState(activeAgentId ?? sessions[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const selectedAgent = sessions.find((session) => session.id === selectedAgentId) ?? sessions[0];
  const selectedBlocks = selectedAgent ? chats[selectedAgent.id] ?? [] : [];
  const isRunning = selectedAgent ? Boolean(running[selectedAgent.id]) : false;

  useEffect(() => {
    const next = activeAgentId && sessions.some((session) => session.id === activeAgentId) ? activeAgentId : sessions[0]?.id ?? "";
    if (next !== selectedAgentId) setSelectedAgentId(next);
  }, [activeAgentId, selectedAgentId, sessions]);

  const selectAgent = (id: string) => {
    setSelectedAgentId(id);
    onSelectAgent(id);
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !selectedAgent || isRunning) return;
    setDraft("");
    void onSendAgent(selectedAgent.id, text);
  };

  const openTeam = () => {
    close();
    onOpenAgentTeam();
  };

  const renderBlock = (block: ChatBlock) => {
    switch (block.kind) {
      case "user":
        return <div key={block.id} className="dd-message dd-message--me">{block.text}</div>;
      case "assistant":
        return <div key={block.id} className="dd-message dd-message--ai">{block.text || "…"}</div>;
      case "error":
        return <div key={block.id} className="dd-message dd-message--ai dd-message--error"><StatusPill tone="risk">执行失败</StatusPill><p>{block.message}</p></div>;
      case "tool":
        return <div key={block.id} className="dd-message dd-message--ai dd-message--tool"><StatusPill tone={block.ok === false ? "risk" : block.ok ? "ok" : "muted"}>工具 · {block.ok === undefined ? "执行中" : block.ok ? "完成" : "失败"}</StatusPill><p>{block.name}</p></div>;
      case "status":
        return <div key={block.id} className="dd-message dd-message--status">{block.text}</div>;
    }
  };

  return (
    <aside className={`dd-copilot ${open ? "dd-copilot--open" : ""}`}>
      <header><img src={logo} alt="DepDek" /><div><b>DepDek Copilot</b><small>{selectedAgent ? `Agent Team · ${selectedAgent.label}` : `围绕「${VIEW_TITLES[activeView]}」协作 · 请选择 Agent`}</small></div><button onClick={close} aria-label="关闭 Copilot"><X size={18} /></button></header>
      <div className="dd-copilot-body">
        {!selectedAgent && <div className="dd-copilot-empty"><Robot size={28} /><b>先选择一个 Agent</b><span>从 Agent Team 选择工作伙伴，建立独立 chat。</span><button onClick={openTeam}>打开 Agent Team</button></div>}
        {selectedAgent && selectedBlocks.length === 0 && <div className="dd-copilot-empty dd-copilot-empty--agent"><StatusPill tone="ok">已连接</StatusPill><b>{selectedAgent.label}</b><span>向这个 Agent 发送第一条消息即可建立 chat。</span></div>}
        {selectedBlocks.map(renderBlock)}
        {selectedAgent && isRunning && <div className="dd-message dd-message--status">{selectedAgent.label} 正在思考…</div>}
      </div>
      <footer>
        <div className="dd-copilot-composer"><input disabled={!selectedAgent || isRunning} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && send()} placeholder={selectedAgent ? "和当前 Agent 聊点什么…" : "先从 Agent Team 选择一个 Agent"} /><button disabled={!selectedAgent || isRunning} onClick={send} aria-label="发送"><PaperPlaneTilt size={17} weight="fill" /></button></div>
        <div className="dd-agent-switcher">
          <Robot size={15} />
          {sessions.length > 0 ? (
            <label>
              <small>当前 Agent · {isRunning ? "执行中" : "可对话"}</small>
              <select aria-label="选择 Agent Team 中的 Agent" value={selectedAgent?.id ?? ""} onChange={(event) => selectAgent(event.target.value)}>
                {sessions.map((session) => <option key={session.id} value={session.id}>{session.label} · {session.providerName}</option>)}
              </select>
            </label>
          ) : (
            <button className="dd-agent-empty" onClick={openTeam}>去 Agent Team 创建 Agent</button>
          )}
          {selectedAgent && <button className="dd-agent-manage" onClick={openTeam}>管理</button>}
          {selectedAgent && isRunning && <button className="dd-agent-abort" onClick={() => void onAbortAgent(selectedAgent.id)}>停止</button>}
        </div>
        <small className="dd-copilot-note"><ShieldCheck size={12} />chat 由 Agent Team 会话承载 · 数据范围和外发策略仍由你控制</small>
      </footer>
    </aside>
  );
}

export default function DepDekHome({ root, providerCount, sessionCount, onOpenAgentTeam, onOpenSettings, onPickRoot, sessions, activeAgentId, chats, running, onSelectAgent, onSendAgent, onAbortAgent }: Props) {
  const [activeView, setActiveView] = useState<ViewName>("today");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [taskHistoryLoaded, setTaskHistoryLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [todoCount, setTodoCount] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);
  const now = useMemo(() => new Date(), []);
  const [time, setTime] = useState(`${pad(now.getHours())}:${pad(now.getMinutes())}`);

  const refreshTodoCount = useCallback(async () => {
    try {
      const items = await listTodos();
      setTodoCount(items.filter((item) => item.lane !== "done").length);
    } catch {
      setTodoCount(0);
    }
  }, []);

  const refreshInboxCount = useCallback(async (previewCount?: number) => {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      setInboxCount(previewCount ?? 2);
      return;
    }
    try {
      const config = JSON.parse((await api.vaultReadFile("mail/accounts.json")).content) as { accounts?: api.MailAccount[] };
      let messageStates: Record<string, { read?: boolean; archived?: boolean; folder?: string }> = {};
      try {
        const index = JSON.parse((await api.vaultReadFile("mail/index.json")).content) as { messages?: Record<string, { read?: boolean; archived?: boolean; folder?: string }> };
        messageStates = index.messages ?? {};
      } catch {
        // A missing derived index means all local messages are unread.
      }
      const counts = await Promise.all((config.accounts ?? []).map(async (account) => {
        try {
          const { entries } = await api.vaultListDir(`mail/${account.name}`);
          return entries.filter((entry) => {
            if (entry.kind !== "file" || !entry.name.endsWith(".md")) return false;
            const state = messageStates[`mail/${account.name}/${entry.name}`];
            // Sent/draft copies created by older builds may not have a state
            // index entry yet; their filename remains the durable fallback.
            const inferredFolder = entry.name.toLocaleLowerCase().startsWith("sent-")
              ? "sent"
              : entry.name.toLocaleLowerCase().startsWith("draft-")
                ? "drafts"
                : undefined;
            const effectiveFolder = state?.folder ?? inferredFolder;
            return !state?.read && !state?.archived && (!effectiveFolder || effectiveFolder === "inbox");
          }).length;
        } catch {
          return 0;
        }
      }));
      setInboxCount(counts.reduce((sum, count) => sum + count, 0));
    } catch {
      setInboxCount(0);
    }
  }, [root]);

  useEffect(() => {
    void refreshTodoCount();
    const unsubscribe = subscribeTodoChanges(() => { void refreshTodoCount(); });
    return unsubscribe;
  }, [refreshTodoCount, root]);

  useEffect(() => { void refreshInboxCount(); }, [refreshInboxCount]);

  useEffect(() => {
    let active = true;
    void api.vaultReadFile(TASK_HISTORY_PATH).then((result) => {
      if (!active) return;
      const parsed = JSON.parse(result.content) as { tasks?: TaskRecord[] };
      setTasks((parsed.tasks ?? []).map((task) => {
        const normalized = { ...task, logs: task.logs ?? [] };
        return normalized.status === "running"
          ? { ...normalized, status: "error" as const, detail: `${normalized.detail}（应用重启前未完成）`, message: "任务在上次会话结束时仍在执行" }
          : normalized;
      }));
    }).catch(() => undefined).finally(() => { if (active) setTaskHistoryLoaded(true); });
    return () => { active = false; };
  }, [root]);

  useEffect(() => {
    if (!taskHistoryLoaded) return;
    void api.vaultWriteFile(TASK_HISTORY_PATH, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), tasks }, null, 2) + "\n").catch(() => undefined);
  }, [taskHistoryLoaded, tasks]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const date = new Date();
      setTime(`${pad(date.getHours())}:${pad(date.getMinutes())}`);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === "Escape") { setPaletteOpen(false); setActionOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  };

  const startTask = (input: TaskStartInput) => {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const { logs, ...taskInput } = input;
    setTasks((current) => [{ ...taskInput, id, status: "running" as const, startedAt: Date.now(), logs: logs ?? [] }, ...current].slice(0, 50));
    setTaskCenterOpen(true);
    return id;
  };

  const updateTask = (id: string, update: TaskUpdate) => {
    const { log, ...taskUpdate } = update;
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...taskUpdate, logs: log ? [...task.logs, { ...log, ts: Date.now() }] : task.logs } : task));
  };

  const runningTaskCount = tasks.filter((task) => task.status === "running").length;

  const navGroup = (label: string, items: NavItem[]) => (
    <><span className="dd-nav-label">{label}</span>{items.map((item) => {
      const Icon = item.icon;
      const badge = item.key === "todo" ? String(todoCount) : item.key === "inbox" ? String(inboxCount) : item.badge;
      return <button key={item.key} className={`dd-nav-item ${activeView === item.key ? "dd-nav-item--active" : ""}`} onClick={() => setActiveView(item.key)}><Icon size={18} weight={activeView === item.key ? "fill" : "regular"} /><span>{item.label}</span>{badge !== undefined && <em className={item.badgeTone === "warn" ? "dd-nav-badge--warn" : ""}>{badge}</em>}</button>;
    })}</>
  );

  return (
    <div className={`depdek ${copilotOpen ? "depdek--copilot-open" : ""} ${sidebarCollapsed ? "depdek--sidebar-collapsed" : ""}`}>
      <div className="dd-sidebar-shell">
        <aside className="dd-sidebar">
          <div className="dd-brand"><img src={logo} alt="DepDek 图标" /><div><b>DepDek</b></div></div>
          <nav>{navGroup("工作台", WORK_NAV)}{navGroup("数据领域", DATA_NAV)}{navGroup("信任与系统", TRUST_NAV)}</nav>
          <div className="dd-sidebar-foot">
            <button onClick={onOpenAgentTeam}><Robot size={16} />Agent Team <span>{sessionCount}</span></button>
            <button onClick={onOpenSettings}><GearSix size={16} />模型与 Provider <span>{providerCount}</span></button>
            <button onClick={onPickRoot}><HardDrives size={16} />更换 Home</button>
            <p><span />Home 已连接 · Rust Vault</p><small title={root}>{root}</small>
          </div>
        </aside>
        <button className="dd-sidebar-toggle" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? "展开侧栏" : "收拢侧栏"} title={sidebarCollapsed ? "展开侧栏" : "收拢侧栏"}>{sidebarCollapsed ? <CaretRight size={13} weight="bold" /> : <CaretLeft size={13} weight="bold" />}</button>
      </div>

      <div className="dd-main">
        {activeView === "today" && <header className="dd-topbar">
          <div className="dd-clock"><strong>{time}</strong><span>{now.getMonth() + 1}月{now.getDate()}日 · 本地优先<em>本地优先 · 今日安好</em></span></div>
          <div className="dd-greeting"><b>晚上好，阿哲。</b><span>今天也从容一点。尚有 <strong>1 项承诺</strong> 待闭环</span></div>
          <button className="dd-command" onClick={() => setPaletteOpen(true)}><MagnifyingGlass size={17} /><span>搜索、导航、创建、提问…<small>试试「我这周还有哪些承诺没完成？」</small></span><kbd>⌘ K</kbd></button>
          <div className="dd-top-actions">
            <button onClick={() => setPaletteOpen(true)}><Plus size={18} /><span>新建</span></button>
            <button onClick={() => setActionOpen(true)}><ListChecks size={18} /><span>审批</span><i /></button>
            <button onClick={() => setTaskCenterOpen((current) => !current)} aria-label="打开任务中心"><ClipboardText size={18} /><span>任务</span>{runningTaskCount > 0 && <i />}</button>
            <button onClick={() => setCopilotOpen((current) => !current)}><Sparkle size={18} /><span>Copilot</span></button>
          </div>
        </header>}

        <main className={`dd-workbench ${activeView === "inbox" ? "dd-workbench--inbox" : ""}`}>
          {activeView === "today" ? <TodayView notify={notify} openAction={() => setActionOpen(true)} /> : <DomainView name={activeView} root={root} providerCount={providerCount} sessionCount={sessionCount} openAgentTeam={onOpenAgentTeam} notify={notify} onStartTask={startTask} onUpdateTask={updateTask} onInboxCountChange={refreshInboxCount} />}
        </main>
      </div>

      <TaskCenter open={taskCenterOpen} tasks={tasks} close={() => setTaskCenterOpen(false)} />
      <Copilot open={copilotOpen} close={() => setCopilotOpen(false)} activeView={activeView} sessions={sessions} activeAgentId={activeAgentId} chats={chats} running={running} onSelectAgent={onSelectAgent} onSendAgent={onSendAgent} onAbortAgent={onAbortAgent} onOpenAgentTeam={onOpenAgentTeam} />
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} go={setActiveView} openAction={() => setActionOpen(true)} />
      <ActionSheet open={actionOpen} close={() => setActionOpen(false)} notify={notify} />
      {toast && <div className="dd-toast"><CheckCircle size={18} weight="fill" />{toast}</div>}
    </div>
  );
}
