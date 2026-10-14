import { useMemo, useState } from "react";
import { ArrowRight, Brain, EnvelopeSimple, FileText, GearSix, ImageSquare, MusicNotes, Plus, Robot, ShieldCheck, VideoCamera, Wrench, XCircle } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { AgentSkill, ProviderConfig, SavedAgent, TeamTask, TeamTaskStatus } from "../api";
import type { AgentMetrics, SessionInfo } from "../App";
import "./agent-team-dashboard.css";

const SKILL_CATALOG: Record<AgentSkill, { name: string; description: string; icon: Icon }> = {
  documents: { name: "文档管理", description: "查找、读取、整理和压缩本地文档", icon: FileText },
  photos: { name: "照片管理", description: "按名称检索图片并在本地查看", icon: ImageSquare },
  music: { name: "播放音乐", description: "搜索音乐文件并调用内置播放器", icon: MusicNotes },
  videos: { name: "播放视频", description: "搜索视频文件并调用内置播放器", icon: VideoCamera },
  mail: { name: "邮件收取", description: "通过已配置的 IMAP 连接收取邮件", icon: EnvelopeSimple },
  memory: { name: "共享记忆", description: "提交有来源的记忆候选，待用户确认", icon: Brain },
};

interface Props {
  agents: SavedAgent[];
  sessions: SessionInfo[];
  metrics: Record<string, AgentMetrics>;
  providers: Record<string, ProviderConfig>;
  running: Record<string, boolean>;
  teamTasks: TeamTask[];
  onCancelTask: (taskId: string) => Promise<void>;
  onEnter: (id: string) => void;
  onConfigure: () => void;
  onCreate: (label: string, providerName: string, id?: string, openWorkbench?: boolean, engine?: "pi" | "deepseek-harness", skills?: AgentSkill[]) => Promise<void>;
  onOpenSettings: () => void;
}

const TASK_STATUS: Record<TeamTaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function taskSort(tasks: TeamTask[]): TeamTask[] {
  const rank = (status: TeamTaskStatus) => status === "running" ? 0 : status === "queued" ? 1 : 2;
  return [...tasks].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return a.updated_at < b.updated_at ? 1 : -1;
  });
}

function clipText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const compact = (value: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export default function AgentTeamDashboard({ agents, sessions, metrics, providers, running, teamTasks, onCancelTask, onEnter, onConfigure, onCreate, onOpenSettings }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSkills, setNewSkills] = useState<AgentSkill[]>(["documents", "memory"]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const orderedTasks = useMemo(() => taskSort(teamTasks).slice(0, 20), [teamTasks]);
  const activeTeamTasks = teamTasks.filter((task) => task.status === "queued" || task.status === "running").length;
  const providerNames = Object.keys(providers);
  const deepseekProvider = Object.entries(providers).find(([name, config]) => name.toLocaleLowerCase().includes("deepseek") || (config.kind === "openai-compatible" && config.base_url.toLocaleLowerCase().includes("deepseek")));
  const deepseekKeyMissing = !deepseekProvider || (deepseekProvider[1].kind === "openai-compatible" ? !deepseekProvider[1].api_key : deepseekProvider[1].kind !== "anthropic" && !deepseekProvider[1].api_key);
  const totalRuns = useMemo(() => Object.values(metrics).reduce((sum, metric) => sum + metric.completedRuns, 0), [metrics]);
  const knownTokenCount = useMemo(() => Object.values(metrics).filter((metric) => metric.tokenUsageKnown).reduce((sum, metric) => sum + metric.reportedTokens, 0), [metrics]);
  const hasAnyTokenUsage = Object.values(metrics).some((metric) => metric.tokenUsageKnown);
  const activeCount = sessions.length;

  const createAgent = async () => {
    if (!newName.trim() || providerNames.length === 0) return;
    setCreating(true);
    const id = "agent-" + Date.now().toString(36);
    try {
      await onCreate(newName.trim(), providerNames.find((name) => name.toLocaleLowerCase().includes("deepseek")) ?? providerNames[0], id, false, "pi", newSkills);
      setNewName("");
      setNewSkills(["documents", "memory"]);
      setCreateError(null);
      setCreateOpen(false);
    } catch (error) { setCreateError(String(error)); }
    finally { setCreating(false); }
  };

  const startOrEnter = async (agent: SavedAgent, hasSession: boolean) => {
    if (hasSession) { onEnter(agent.id); return; }
    setActionError(null);
    try { await onCreate(agent.label, agent.provider_name, agent.id, true, agent.engine ?? "pi", agent.enabled_skills); }
    catch (error) { setActionError(agent.label + " 未能启动：" + String(error)); }
  };

  return (
    <div className="agent-team-page">
      <header className="agent-team-header">
        <div className="agent-team-title">
          <span className="agent-team-kicker"><Robot size={15} /> AGENT TEAM</span>
          <h1>每个 Agent，都有自己的专长</h1>
          <p>选择伙伴开始协作。在线的 Agent 可以把任务委托给队友；委托在后台执行，用的仍是对方已有的工具。</p>
        </div>
        <div className="agent-team-actions">
          <button className="agent-team-secondary" onClick={onOpenSettings}><GearSix size={17} />模型与密钥</button>
          <button className="agent-team-primary" onClick={() => { setCreateError(null); setCreateOpen(true); }}><Plus size={18} />新建 Agent</button>
        </div>
      </header>

      <section className="agent-team-overview" aria-label="团队运行概览">
        <div><span>我的 Agents</span><b>{agents.length}</b><small>{activeCount} 个会话已就绪</small></div>
        <div><span>已完成任务</span><b>{totalRuns}</b><small>按完整响应计数</small></div>
        <div><span>Token 消耗</span><b>{hasAnyTokenUsage ? compact(knownTokenCount) : "—"}</b><small>{hasAnyTokenUsage ? "仅累计引擎实际回报值" : "当前引擎未回报用量"}</small></div>
        <div className="agent-team-safety"><ShieldCheck size={19} /><span><b>本地数据受控</b><small>文件能力经 Rust Vault 与审计，不向 Agent 开放任意磁盘或 Shell。</small></span></div>
      </section>

      {deepseekKeyMissing && <div className="agent-team-notice"><b>默认模型：DeepSeek</b><span>{deepseekProvider ? "尚未填写 API Key。请先在模型设置中配置凭据后开始协作。" : "尚未配置 DeepSeek Provider。请在模型设置中补充 API Key 后开始协作。"}</span><button onClick={onOpenSettings}>配置模型 <ArrowRight size={14} /></button></div>}

      <div className="agent-team-section-head"><div><h2>Agent 工作伙伴</h2><span>每个 Agent 单独配置模型、提示词和技能</span></div><button onClick={onConfigure}><Wrench size={16} />管理技能与配置</button></div>
      {actionError && <div className="agent-team-inline-error" role="alert">{actionError}</div>}
      <section className="agent-team-grid">
        {agents.map((agent, index) => {
          const session = sessions.find((item) => item.id === agent.id);
          const metric = metrics[agent.id] ?? { completedRuns: 0, reportedTokens: 0, tokenUsageKnown: false };
          const skillNames = (agent.enabled_skills ?? []).map((skill) => SKILL_CATALOG[skill]).filter(Boolean);
          const providerConfig = providers[agent.provider_name];
          const hasKey = Boolean(providerConfig && (providerConfig.kind !== "openai-compatible" || providerConfig.api_key));
          const isRunning = Boolean(running[agent.id]);
          return (
            <article className="agent-team-card" key={agent.id}>
              <div className="agent-team-card-head">
                <div className={"agent-team-avatar agent-team-avatar--" + (index % 5)}><Robot size={24} weight="duotone" /></div>
                <div className="agent-team-card-identity"><h3>{agent.label}</h3><span>{agent.engine === "deepseek-harness" ? "DeepSeek Harness" : "Pi Agent Core"} · {agent.provider_name}</span></div>
                <button className="agent-team-card-config" title="配置 Agent" aria-label={"配置 " + agent.label} onClick={onConfigure}><GearSix size={17} /></button>
              </div>
              <div className="agent-team-skill-list">
                {skillNames.length ? skillNames.map((skill) => {
                  const Icon = skill.icon;
                  return <span key={skill.name} title={skill.description}><Icon size={14} />{skill.name}</span>;
                }) : <span className="agent-team-no-skill">尚未启用工具技能</span>}
              </div>
              <div className="agent-team-card-stats"><div><b>{metric.completedRuns}</b><small>已完成任务</small></div><div><b>{metric.tokenUsageKnown ? compact(metric.reportedTokens) : "—"}</b><small>Tokens</small></div><div><b>{agent.engine === "deepseek-harness" ? "只读文本" : "Vault"}</b><small>工具范围</small></div></div>
              {agent.engine === "deepseek-harness" && <p className="agent-team-capability-note">Harness 当前配置为文本只读，不提供文件/MCP 工具调用；切换 Pi 引擎以使用所列技能。</p>}
              <footer>
                <span className={isRunning ? "agent-team-status agent-team-status--busy" : session ? "agent-team-status" : "agent-team-status agent-team-status--off"}><i />{isRunning ? "正在工作" : session ? "在线" : hasKey ? "待启动" : "等待配置 API Key"}</span>
                <button onClick={() => void startOrEnter(agent, Boolean(session))}>{session ? "进入协作" : "开始工作"}<ArrowRight size={16} /></button>
              </footer>
            </article>
          );
        })}
      </section>

      <section className="agent-team-tasks" aria-label="协作任务">
        <div className="agent-team-section-head">
          <div>
            <h2>协作任务</h2>
            <span>{activeTeamTasks > 0 ? `${activeTeamTasks} 个进行中` : "委托和消息会显示在这里"}</span>
          </div>
        </div>
        {orderedTasks.length === 0 ? (
          <p className="agent-team-tasks-empty">还没有协作任务。Agent 可以用 delegate_task 把工作交给在线队友，完成后结果会回到发起人。</p>
        ) : (
          <ul className="agent-team-task-list">
            {orderedTasks.map((task) => {
              const cancellable = task.status === "queued" || task.status === "running";
              return (
                <li className={`agent-team-task agent-team-task--${task.status}`} key={task.id}>
                  <span className="agent-team-task-status">{TASK_STATUS[task.status]}</span>
                  <span className="agent-team-task-kind">{task.kind === "message" ? "消息" : "委托"}</span>
                  <div className="agent-team-task-body">
                    <b>{task.from_label} → {task.to_label}</b>
                    <small>{clipText(task.instruction, 96)}</small>
                    {task.result_preview && <small className="agent-team-task-result">结果：{clipText(task.result_preview, 140)}</small>}
                    {task.error && task.status !== "done" && <small className="agent-team-task-error">{clipText(task.error, 120)}</small>}
                  </div>
                  {cancellable ? (
                    <button
                      type="button"
                      disabled={cancellingId === task.id}
                      aria-label={`取消 ${task.from_label} 交给 ${task.to_label} 的任务`}
                      onClick={() => {
                        setCancellingId(task.id);
                        setActionError(null);
                        void onCancelTask(task.id).catch((error) => setActionError(String(error))).finally(() => setCancellingId((current) => current === task.id ? null : current));
                      }}
                    >
                      <XCircle size={15} />{cancellingId === task.id ? "取消中…" : "取消"}
                    </button>
                  ) : <span className="agent-team-task-depth">深度 {task.depth}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="agent-team-integrations">
        <div><span className="agent-team-integration-icon"><Wrench size={18} /></span><div><b>工具与连接</b><p>内置技能已可通过受审计 Vault 调用。MCP 文件目前用于记录配置说明，外部 MCP Server 尚未启动或授予工具权限。</p></div></div>
        <button onClick={onConfigure}>查看各 Agent 配置 <ArrowRight size={15} /></button>
      </section>

      {createOpen && <div className="agent-team-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCreateOpen(false)}><section className="agent-team-modal" role="dialog" aria-modal="true" aria-label="新建 Agent"><header><div><b>新建 Agent</b><small>选择一个或多个能力，之后可在 Agent 配置中调整。</small></div><button onClick={() => setCreateOpen(false)} aria-label="关闭">×</button></header><label>名称<input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：合同整理助手" /></label><fieldset className="agent-team-modal-skills"><legend>启用技能</legend>{Object.entries(SKILL_CATALOG).map(([id, skill]) => <label key={id}><input type="checkbox" checked={newSkills.includes(id as AgentSkill)} onChange={(event) => setNewSkills((current) => event.target.checked ? [...current, id as AgentSkill] : current.filter((item) => item !== id))} /><span><b>{skill.name}</b><small>{skill.description}</small></span></label>)}</fieldset><p>默认使用 DeepSeek Provider。API Key 需要你在模型设置中填写；当前由本机应用配置存储，尚未接入系统钥匙串。凭据没有写入源码。</p>{createError && <p className="agent-team-inline-error" role="alert">{createError}</p>}<footer><button onClick={() => setCreateOpen(false)}>取消</button><button disabled={!newName.trim() || !newSkills.length || providerNames.length === 0 || creating} onClick={() => void createAgent()}>{creating ? "创建中…" : "创建并保存"}</button></footer></section></div>}
    </div>
  );
}
