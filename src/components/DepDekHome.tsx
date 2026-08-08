import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowUpRight,
  Books,
  Brain,
  CalendarBlank,
  Check,
  CheckCircle,
  CheckSquare,
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
  Tray,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ProviderConfig } from "../api";
import logo from "../assets/depdek-logo.png";
import InboxView from "./InboxView";
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
  providers: Record<string, ProviderConfig>;
  providerCount: number;
  sessionCount: number;
  onOpenDeepWork: () => void;
  onOpenSettings: () => void;
  onPickRoot: () => void;
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
  { key: "todo", label: "待办", icon: CheckSquare, badge: "4" },
  { key: "inbox", label: "收件箱", icon: Tray, badge: "3" },
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

function ToolButtons() {
  return (
    <div className="dd-card-tools" aria-label="卡片工具">
      <button title="收起"><Minus size={13} /></button>
      <button title="展开"><ArrowUpRight size={13} /></button>
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

function Timeline() {
  const items = [
    ["09:30", "产品周会", "已结束", "腾讯会议 · 与李雯、Chen 等 6 人 · 来源：日历同步", "muted"],
    ["13:00", "DepDek 重构评审", "已结束", "会议室 B · 纪要已同步到知识库", "muted"],
    ["19:00", "与 Alice 对齐 Q3 预算", "即将开始", "线上 · 关联 3 封邮件与 1 份文档", "now"],
    ["21:30", "深度工作块 · 建议", "", "依据：已确认记忆「晚间适合写作」· 置信度 86%", "accent"],
  ];
  return (
    <div className="dd-timeline">
      {items.map(([time, title, status, meta, tone]) => (
        <div className="dd-timeline-item" key={time}>
          <time>{time}</time>
          <span className={`dd-timeline-dot dd-timeline-dot--${tone}`} />
          <div className={`dd-timeline-body ${tone === "now" ? "dd-timeline-body--hot" : ""}`}>
            <div className="dd-timeline-title">
              {title}
              {status && <StatusPill tone={tone === "now" ? "warn" : "muted"}>{status}</StatusPill>}
            </div>
            <div className="dd-timeline-meta">{meta}{tone === "now" && <button>查看上下文</button>}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface TaskItem { id: number; title: string; source: string; done: boolean; pending?: boolean }

function TodayView({ notify, openAction }: { notify: (message: string) => void; openAction: () => void }) {
  const [tasks, setTasks] = useState<TaskItem[]>([
    { id: 1, title: "回复法务关于授权范围的邮件", source: "来源：邮件 · 已写回标记", done: true },
    { id: 2, title: "整理评审会议纪要", source: "手动创建", done: true },
    { id: 3, title: "确认「续费域名」抽取任务", source: "DepDek 从邮件抽取 · 待你确认", done: false, pending: true },
    { id: 4, title: "给阳台的薄荷换大花盆", source: "便签 · 生活", done: false },
  ]);
  const [draft, setDraft] = useState("");
  const doneCount = tasks.filter((task) => task.done).length;

  const toggleTask = (id: number) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, done: !task.done } : task));
    notify("承诺状态已更新 · 仅写入本地记录");
  };

  const addTask = () => {
    const title = draft.trim();
    if (!title) return;
    setTasks((current) => [...current, { id: Date.now(), title, source: "指令栏 · 仅本地", done: false }]);
    setDraft("");
    notify(`已在本地创建：「${title.length > 18 ? `${title.slice(0, 18)}…` : title}」`);
  };

  return (
    <>
      <div className="dd-view-head">
        <div><div className="dd-eyebrow">HOME / 今日概览</div><h1>我的一天</h1></div>
        <span>拖动卡片排序 · 右上角调整尺寸 · 布局保存在本地</span>
      </div>
      <div className="dd-grid">
        <article className="dd-card dd-col-7 dd-card--timeline">
          <CardHeader tag="日程与时间轴 · 日历（只读）" title="今日时间轴" />
          <Timeline />
          <SourceNote>来源：日历连接（只读） · 10 分钟前同步</SourceNote>
        </article>

        <article className="dd-card dd-col-5 dd-card--tasks">
          <CardHeader tag="待办与任务" title="今天要完成的事" />
          <div className="dd-progress-head"><strong>{doneCount}</strong> / {tasks.length} 项 <span>{Math.round(doneCount / tasks.length * 100)}%</span></div>
          <div className="dd-progress"><i style={{ width: `${doneCount / tasks.length * 100}%` }} /></div>
          <div className="dd-task-list">
            {tasks.map((task) => (
              <button className={`dd-task ${task.done ? "dd-task--done" : ""}`} key={task.id} onClick={() => toggleTask(task.id)}>
                <span className="dd-check">{task.done && <Check size={11} weight="bold" />}</span>
                <span><b>{task.title}</b><small>{task.source}</small></span>
                {task.pending && <StatusPill tone="warn">待确认</StatusPill>}
                {task.done && <StatusPill tone="ok">已完成</StatusPill>}
              </button>
            ))}
          </div>
          <div className="dd-quick-add">
            <Plus size={15} />
            <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addTask()} placeholder="试试输入「明天下午 3 点提醒我续费」" />
            <button onClick={addTask}>添加</button>
          </div>
          <SourceNote>仅本地保存 · 写回外部服务需逐次确认</SourceNote>
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
          <div className="dd-health-item"><CalendarBlank size={17} /><span><b>日历连接</b><small>权限 7 天后到期</small></span><StatusPill tone="warn">续期</StatusPill></div>
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
  calendar: { eyebrow: "CALENDAR / 时间主权", title: "日历", lead: "先看见时间，再让模型提出建议；任何写回都需要 Action 审批。", cards: [["本周时间分配", "深度工作 11h · 会议 8h", "本地聚合"], ["冲突与建议", "周四 15:00 有一处重叠", "等待确认"], ["连接状态", "日历只读 · 7 天后续期", "来源可追溯"]] },
  todo: { eyebrow: "TASKS / 个人承诺", title: "待办", lead: "从邮件、日历和文档发现承诺，先确认，再进入执行系统。", cards: [["今天", "4 项 · 已完成 2 项", "本地记录"], ["待确认抽取", "2 项来自邮件", "模型推断"], ["等待中", "3 项等待他人", "建议跟进"]] },
  inbox: { eyebrow: "INBOX / 从信息到行动", title: "收件箱", lead: "统一处理邮件、行动项、草稿和需要你做决定的内容。", cards: [["需要回复", "3 封邮件", "IMAP 本地副本"], ["行动项", "2 项待你确认", "来源可回溯"], ["待发送草稿", "1 封高风险行动", "逐次审批"]] },
  knowledge: { eyebrow: "KNOWLEDGE / 可追溯的理解", title: "知识", lead: "跨来源检索你的文档、笔记和记录；事实、推断与建议严格分开。", cards: [["本地索引", "12,482 条记录", "SQLite FTS"], ["最近知识", "Q3 预算口径备忘", "来自本地文件"], ["语义检索", "可关闭且不影响全文搜索", "本地模型"]] },
  files: { eyebrow: "FILES / 开放的数据家园", title: "文件", lead: "现有 Vault 继续作为本地文件信任边界，并逐步迁移到 Personal Data Home。", cards: [["当前 Home", "已连接本地目录", "Rust Vault"], ["对象与记录", "Home v2 待实现", "不伪装为已接通"], ["可验证导出", "JSONL / Markdown / ICS", "开放格式"]] },
  automation: { eyebrow: "AUTOMATION / 有边界的代理", title: "自动化", lead: "低风险任务可以自动执行；越接近外部世界，审批越明确。", cards: [["运行中", "3 条本地整理规则", "无需联网"], ["等待审批", "发送邮件给 Alice", "高风险"], ["失败队列", "日历权限即将到期", "需处理"]] },
  connections: { eyebrow: "CONNECTIONS / 数据回到本地", title: "连接", lead: "服务是数据源和行动通道，DepDek 才是你的长期主数据层。", cards: [["邮件", "10 分钟前同步", "凭据将迁移到钥匙串"], ["日历", "只读 · 7 天后续期", "固定权限范围"], ["本地文件", "索引健康", "Rust 沙箱"]] },
  memory: { eyebrow: "MEMORY / 你定义你自己", title: "记忆", lead: "模型推断先进入待确认；每条记忆都有来源、置信度、有效期和使用记录。", cards: [["待确认", "2 条候选记忆", "模型推断"], ["已确认", "9 条长期记忆", "用户治理"], ["本月删除", "5 条", "删除立即生效"]] },
  privacy: { eyebrow: "PRIVACY / 数据去哪了", title: "数据与隐私", lead: "每次数据访问、模型外发和外部写操作都应该留下可理解的凭证。", cards: [["本地数据", "83.6 GB · 100% 本机", "Personal Data Home"], ["云端外发", "本月 3 次", "均有回执"], ["凭据", "0 条进入数据目录", "OS Keychain 目标"]] },
};

function DomainView({ name, root, providerCount, sessionCount, openDeepWork, notify }: { name: Exclude<ViewName, "today">; root: string; providerCount: number; sessionCount: number; openDeepWork: () => void; notify: (message: string) => void }) {
  if (name === "inbox") return <InboxView />;
  const view = VIEW_COPY[name];
  return (
    <>
      <div className="dd-view-head"><div><div className="dd-eyebrow">{view.eyebrow}</div><h1>{view.title}</h1></div><span>{view.lead}</span></div>
      <div className="dd-domain-grid">
        {view.cards.map(([title, value, note], index) => (
          <article className="dd-domain-card" key={title}>
            <span className="dd-domain-index">0{index + 1}</span>
            <h2>{title}</h2><strong>{value}</strong><p>{note}</p>
            {name === "files" && index === 0 && <button onClick={openDeepWork}>打开真实文件工作区</button>}
            {name === "connections" && index === 0 && <button onClick={() => notify("邮件连接详情来自当前 Vault 配置")}>查看连接</button>}
          </article>
        ))}
      </div>
      <article className="dd-card dd-domain-note">
        <CardHeader tag="实施边界" title="这部分正在按 PRD 逐步接通" />
        <p>当前版本保留真实 Vault、邮件、Agent、Provider 与审计能力；Home v2、Credential Broker、Connector SDK、Model Gateway 和 Action Engine 会按重构路线分阶段替换这些原型状态。</p>
        <div className="dd-domain-actions"><button onClick={openDeepWork}>进入现有 Deep Work</button><button onClick={() => notify(`当前 Provider ${providerCount} 个 · Agent ${sessionCount} 个`)}>查看运行摘要</button></div>
        <SourceNote>当前数据目录：{root}</SourceNote>
      </article>
    </>
  );
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

interface ModelOption {
  id: string;
  provider: string;
  model: string;
  kind: ProviderConfig["kind"];
}

function Copilot({
  open,
  close,
  activeView,
  providers,
  onOpenSettings,
}: {
  open: boolean;
  close: () => void;
  activeView: ViewName;
  providers: Record<string, ProviderConfig>;
  onOpenSettings: () => void;
}) {
  const modelOptions = useMemo<ModelOption[]>(
    () => Object.entries(providers)
      .filter(([, config]) => config.model.trim())
      .map(([provider, config]) => ({
        id: `${provider}::${config.model}`,
        provider,
        model: config.model,
        kind: config.kind,
      })),
    [providers],
  );
  const [selectedModelId, setSelectedModelId] = useState("");
  const [messages, setMessages] = useState<Array<{ from: "me" | "ai"; text: string }>>([]);
  const [draft, setDraft] = useState("");
  const selectedModel = modelOptions.find((option) => option.id === selectedModelId) ?? modelOptions[0];

  useEffect(() => {
    if (selectedModel && selectedModel.id !== selectedModelId) setSelectedModelId(selectedModel.id);
    if (!selectedModel && selectedModelId) setSelectedModelId("");
  }, [selectedModel, selectedModelId]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const modelLabel = selectedModel ? `${selectedModel.provider} · ${selectedModel.model}` : "尚未连接模型";
    setMessages((current) => [...current, { from: "me", text }, { from: "ai", text: `已用 ${modelLabel} 处理。这是本地 UX 原型回复。真实版本会先声明数据范围，并在需要云端时展示外发预览。` }]);
    setDraft("");
  };
  return (
    <aside className={`dd-copilot ${open ? "dd-copilot--open" : ""}`}>
      <header><img src={logo} alt="DepDek" /><div><b>DepDek Copilot</b><small>围绕「{VIEW_TITLES[activeView]}」协作 · 默认本地模型</small></div><button onClick={close} aria-label="关闭 Copilot"><X size={18} /></button></header>
      <div className="dd-copilot-body">
        <div className="dd-message dd-message--me">我这周还有哪些承诺没完成？</div>
        <div className="dd-message dd-message--ai"><StatusPill tone="ok">事实 · 来自本地记录</StatusPill><p>本周你共创建 <b>12 项承诺</b>，已闭环 8 项。未完成 4 项：预算反馈、域名续费、连接中心总结和阅读计划。</p><div className="dd-source-chips"><span>任务库 · 12 条</span><span>邮件 · 2 封</span><span>日历 · 3 项</span></div></div>
        <div className="dd-message dd-message--ai"><StatusPill tone="warn">推断 · 供参考</StatusPill><p>域名续费风险最高：有硬截止且涉及付款。建议今晚留 5 分钟处理。</p></div>
        {messages.map((message, index) => <div key={`${message.from}-${index}`} className={`dd-message dd-message--${message.from}`}>{message.text}</div>)}
      </div>
      <footer>
        <div className="dd-copilot-composer"><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && send()} placeholder="继续提问，或让我起草、整理、计划…" /><button onClick={send} aria-label="发送"><PaperPlaneTilt size={17} weight="fill" /></button></div>
        <div className="dd-model-switcher">
          <Robot size={15} />
          {modelOptions.length > 0 ? (
            <label>
              <small>当前模型</small>
              <select aria-label="切换 Copilot 模型" value={selectedModel?.id ?? ""} onChange={(event) => setSelectedModelId(event.target.value)}>
                {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.provider} · {option.model}</option>)}
              </select>
            </label>
          ) : (
            <button className="dd-model-empty" onClick={onOpenSettings}>连接一个 Provider 模型</button>
          )}
          {selectedModel && <span className="dd-model-kind">{selectedModel.kind === "openai-compatible" ? "兼容接口" : selectedModel.kind}</span>}
          <button className="dd-model-manage" onClick={onOpenSettings}>管理</button>
        </div>
        <small className="dd-copilot-note"><ShieldCheck size={12} />本次对话在本地完成 · 升级云端会先展示外发预览</small>
      </footer>
    </aside>
  );
}

export default function DepDekHome({ root, providers, providerCount, sessionCount, onOpenDeepWork, onOpenSettings, onPickRoot }: Props) {
  const [activeView, setActiveView] = useState<ViewName>("today");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const [time, setTime] = useState(`${pad(now.getHours())}:${pad(now.getMinutes())}`);

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

  const navGroup = (label: string, items: NavItem[]) => (
    <><span className="dd-nav-label">{label}</span>{items.map((item) => {
      const Icon = item.icon;
      return <button key={item.key} className={`dd-nav-item ${activeView === item.key ? "dd-nav-item--active" : ""}`} onClick={() => setActiveView(item.key)}><Icon size={18} weight={activeView === item.key ? "fill" : "regular"} /><span>{item.label}</span>{item.badge && <em className={item.badgeTone === "warn" ? "dd-nav-badge--warn" : ""}>{item.badge}</em>}</button>;
    })}</>
  );

  return (
    <div className={`depdek ${copilotOpen ? "depdek--copilot-open" : ""}`}>
      <aside className="dd-sidebar">
        <div className="dd-brand"><img src={logo} alt="DepDek 图标" /><div><b>DepDek</b><small>MY DATA · MY AGENCY</small></div></div>
        <nav>{navGroup("工作台", WORK_NAV)}{navGroup("数据领域", DATA_NAV)}{navGroup("信任与系统", TRUST_NAV)}</nav>
        <div className="dd-sidebar-foot">
          <button onClick={onOpenDeepWork}><Robot size={16} />Deep Work <span>{sessionCount}</span></button>
          <button onClick={onOpenSettings}><GearSix size={16} />模型与 Provider <span>{providerCount}</span></button>
          <button onClick={onPickRoot}><HardDrives size={16} />更换 Home</button>
          <p><span />Home 已连接 · Rust Vault</p><small title={root}>{root}</small>
        </div>
      </aside>

      <div className="dd-main">
        <header className="dd-topbar">
          <div className="dd-clock"><strong>{time}</strong><span>{now.getMonth() + 1}月{now.getDate()}日 · 本地优先<em>本地优先 · 今日安好</em></span></div>
          <div className="dd-greeting"><b>晚上好，阿哲。</b><span>今天也从容一点。尚有 <strong>1 项承诺</strong> 待闭环</span></div>
          <button className="dd-command" onClick={() => setPaletteOpen(true)}><MagnifyingGlass size={17} /><span>搜索、导航、创建、提问…<small>试试「我这周还有哪些承诺没完成？」</small></span><kbd>⌘ K</kbd></button>
          <div className="dd-top-actions">
            <button onClick={() => setPaletteOpen(true)}><Plus size={18} /><span>新建</span></button>
            <button onClick={() => setActionOpen(true)}><ListChecks size={18} /><span>审批</span><i /></button>
            <button onClick={() => notify("正在检查连接健康 · 当前为 UX 原型") }><ArrowClockwise size={18} /><span>同步</span></button>
            <button onClick={() => setCopilotOpen((current) => !current)}><Sparkle size={18} /><span>Copilot</span></button>
          </div>
        </header>

        <main className="dd-workbench">
          {activeView === "today" ? <TodayView notify={notify} openAction={() => setActionOpen(true)} /> : <DomainView name={activeView} root={root} providerCount={providerCount} sessionCount={sessionCount} openDeepWork={onOpenDeepWork} notify={notify} />}
        </main>
      </div>

      <Copilot open={copilotOpen} close={() => setCopilotOpen(false)} activeView={activeView} providers={providers} onOpenSettings={onOpenSettings} />
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} go={setActiveView} openAction={() => setActionOpen(true)} />
      <ActionSheet open={actionOpen} close={() => setActionOpen(false)} notify={notify} />
      {toast && <div className="dd-toast"><CheckCircle size={18} weight="fill" />{toast}</div>}
    </div>
  );
}
