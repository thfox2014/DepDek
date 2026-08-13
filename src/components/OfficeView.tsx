import { useState, type ReactNode } from "react";
import { useEffect } from "react";
import * as api from "../api";
import { FileText, FloppyDisk, GearSix, ShieldCheck } from "@phosphor-icons/react";
import type { ProviderConfig } from "../api";
import type { ChatBlock, SessionInfo } from "../App";

interface Props {
  sessions: SessionInfo[];
  running: Record<string, boolean>;
  chats: Record<string, ChatBlock[]>;
  providers: Record<string, ProviderConfig>;
  settings: api.Settings;
  onEnter: (id: string) => void;
  onCreate: (label: string, providerName: string, agentId?: string, openWorkbench?: boolean) => Promise<void>;
  onSaveSettings: (settings: api.Settings) => Promise<void>;
  onOpenSettings: () => void;
}

// Body colors rotate per session index (matches the reference artwork).
const COLLARS = ["#34a853", "#ea4335", "#9b51e0", "#2f6bff", "#fbbc04", "#12b5cb"];

// Static code-line widths used on idle screens and as the running loop content.
const LINE_WIDTHS = [72, 48, 88, 60, 40, 78, 55, 68];

// Darken a #rrggbb hex color for the shade pixels (tentacle tips, head edge).
const darken = (hex: string, f = 0.72) => {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
};

// ---------------------------------------------------------------------------
// Pixel octopus on a 16x14 grid. Characters: B=body, S=shade, W=eye white,
// P=pupil/outline. Each group is a list of rows drawn at y0+i.
// ---------------------------------------------------------------------------

const BODY_ROWS = [
  ".....BBBBBB.....",
  "...BBBBBBBBBB...",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..", // eyes render on top of this row
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "...SSSSSSSSSS...",
];

const EYES_OPEN_ROWS = [
  "....WW....WW....",
  "....WP....PW....", // pupils look slightly inward
];

const EYES_CLOSED_ROWS = ["....PP....PP...."]; // closed = dark horizontal line

// Frame A: all four tentacles hang straight down.
const TENTACLES_A_ROWS = [
  "..BB..BBBB..BB..",
  "..BB..BBBB..BB..",
  "..BB..BBBB..BB..",
  "..BB..BBBB..BB..",
  "..SS..SSSS..SS..",
];

// Frame B: outer tentacles swing outward, inner pair stays down.
const TENTACLES_B_ROWS = [
  "..BB..BBBB..BB..",
  ".BB...BBBB...BB.",
  "BB....BBBB....BB",
  "BB....BBBB....BB",
  "SS....SSSS....SS",
];

function Pixels({
  rows,
  y0,
  colors,
}: {
  rows: string[];
  y0: number;
  colors: Record<string, string>;
}) {
  const rects: ReactNode[] = [];
  rows.forEach((row, dy) => {
    [...row].forEach((ch, x) => {
      const fill = colors[ch];
      if (fill) {
        rects.push(<rect key={`${x}-${y0 + dy}`} x={x} y={y0 + dy} width={1} height={1} fill={fill} />);
      }
    });
  });
  return <>{rects}</>;
}

function PixelOctopus({ colorIndex, running }: { colorIndex: number; running: boolean }) {
  const body = COLLARS[colorIndex % COLLARS.length];
  const colors = { B: body, S: darken(body), W: "#ffffff", P: "#1d2129" };
  return (
    <svg
      width={96}
      height={84}
      viewBox="0 0 16 14"
      shapeRendering="crispEdges"
      className={`octopus ${running ? "octopus--running" : ""}`}
      aria-hidden="true"
    >
      <g className="octopus__tentacles octopus__tentacles--frame-a">
        <Pixels rows={TENTACLES_A_ROWS} y0={9} colors={colors} />
      </g>
      <g className="octopus__tentacles octopus__tentacles--frame-b">
        <Pixels rows={TENTACLES_B_ROWS} y0={9} colors={colors} />
      </g>
      <g className="octopus__head">
        <Pixels rows={BODY_ROWS} y0={0} colors={colors} />
      </g>
      <g className="octopus__eyes octopus__eyes--open">
        <Pixels rows={EYES_OPEN_ROWS} y0={4} colors={colors} />
      </g>
      <g className="octopus__eyes octopus__eyes--closed">
        <Pixels rows={EYES_CLOSED_ROWS} y0={5} colors={colors} />
      </g>
    </svg>
  );
}

function CodeCopy({ running }: { running: boolean }) {
  return (
    <div className="code-copy">
      {LINE_WIDTHS.map((w, i) => (
        <div
          key={i}
          className={`code-line ${running ? "code-line--bright" : ""}`}
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

function Screen({ running }: { running: boolean }) {
  if (running) {
    // Two identical copies + translateY(-50%) gives a seamless scroll loop.
    return (
      <div className="workstation__screen workstation__screen--running">
        <div className="code-track">
          <CodeCopy running />
          <CodeCopy running />
        </div>
      </div>
    );
  }
  return (
    <div className="workstation__screen workstation__screen--idle">
      <div className="code-track code-track--static">
        <CodeCopy running={false} />
      </div>
    </div>
  );
}

// Current activity for the speech bubble: the name of the tool call still in
// flight (last tool block with ok === undefined), otherwise "思考中…".
function activityOf(blocks: ChatBlock[] | undefined): string {
  if (!blocks) return "思考中…";
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "tool") {
      return b.ok === undefined ? `正在调用 ${b.name}` : "思考中…";
    }
  }
  return "思考中…";
}

const AGENT_FILES = ["agent.md", "skill.md", "mcp.md"] as const;
type AgentFileName = (typeof AGENT_FILES)[number];

function defaultAgentFiles(label: string): Record<AgentFileName, string> {
  return {
    "agent.md": `# ${label}\n\n你是 ${label}，DepDek 的个人数据 Agent。先准确复述事实，再给出可由用户确认的建议。\n`,
    "skill.md": "# Skills\n\n- 识别主题、行动项、时间节点和风险。\n- 所有建议必须保持只读，不代替用户回复、移动、删除或发送。\n",
    "mcp.md": "# MCP\n\n本文件只记录未来接入的 MCP 说明，不授予本次分析任何工具权限。当前分析不得调用外部服务。\n",
  };
}

function agentPath(value: string | undefined, agentId: string): string {
  const fallbackId = agentId.replace(/[^a-zA-Z0-9_-]/g, "-") || "agent";
  const candidate = (value || `agents/${fallbackId}`).trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!candidate || candidate.split("/").some((part) => !part || part === "." || part === "..")) return `agents/${fallbackId}`;
  return candidate;
}

function isLocalProvider(provider: ProviderConfig): boolean {
  if (provider.kind !== "openai-compatible") return false;
  try {
    const host = new URL(provider.base_url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function AgentConfigPanel({
  settings,
  providers,
  agentId,
  onSelectAgent,
  onCreate,
  onSaveSettings,
  onOpenSettings,
}: {
  settings: api.Settings;
  providers: Record<string, ProviderConfig>;
  agentId: string;
  onSelectAgent: (id: string) => void;
  onCreate: (label: string, providerName: string, agentId?: string, openWorkbench?: boolean) => Promise<void>;
  onSaveSettings: (settings: api.Settings) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const agent = (settings.agents ?? []).find((item) => item.id === agentId);
  const agentLabel = agent?.label || (agentId.toLowerCase() === "tanvis" ? "Tanvis" : agentId);
  const defaults = defaultAgentFiles(agentLabel);
  const [files, setFiles] = useState<Record<AgentFileName, string>>(defaults);
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerNames = Object.keys(providers);
  const [providerName, setProviderName] = useState(agent?.provider_name || providerNames[0] || "");
  const usesLocalProvider = Boolean(providerName && providers[providerName] && isLocalProvider(providers[providerName]));
  const root = agentPath(agent?.config_dir, agentLabel.toLowerCase() === "tanvis" ? "tanvis" : agentId);
  const browserPreview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

  useEffect(() => {
    setProviderName(agent?.provider_name || providerNames[0] || "");
    setSystemPrompt(agent?.system_prompt ?? "");
    setNotice(null);
    setError(null);
  }, [agent?.id, agent?.provider_name, agent?.system_prompt, providerNames.join("\u0000")]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all(AGENT_FILES.map(async (name) => {
      if (browserPreview) return [name, defaults[name]] as const;
      try {
        const result = await api.vaultReadFile(`${root}/${name}`);
        return [name, result.content] as const;
      } catch {
        return [name, defaults[name]] as const;
      }
    })).then((entries) => {
      if (active) setFiles(Object.fromEntries(entries) as Record<AgentFileName, string>);
    }).catch((reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [agentId, browserPreview, root]);

  const updateFile = (name: AgentFileName, value: string) => setFiles((current) => ({ ...current, [name]: value }));

  const createAgent = async () => {
    if (!providerName) {
      setError("请先在设置中配置 provider");
      return;
    }
    setError(null);
    try {
      await onCreate(agentLabel, providerName, agentId, false);
      setNotice(`${agentLabel} 已加入 Agent Team`);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
      setNotice(null);
    try {
      if (!browserPreview) {
        for (const name of AGENT_FILES) await api.vaultWriteFile(`${root}/${name}`, files[name]);
      }
      const nextAgents = agent
        ? (settings.agents ?? []).map((item) => item.id === agent.id ? { ...item, provider_name: providerName, config_dir: root, system_prompt: systemPrompt.trim() || undefined } : item)
        : [...(settings.agents ?? []), { id: agentId, label: agentLabel, provider_name: providerName, config_dir: root, system_prompt: systemPrompt.trim() || undefined }];
      await onSaveSettings({ ...settings, agents: nextAgents });
      setNotice(browserPreview ? "预览模式已保存本地编辑状态" : `已保存 ${agentLabel} 配置到 Home/${root}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="office__tanvis" aria-label={`${agentLabel} Agent 配置`}>
      <div className="office__tanvis-head">
        <div><div className="office__eyebrow"><GearSix size={15} />{agentLabel} 配置</div><h2>{agentLabel === "Tanvis" ? "本地数据分析 Agent" : "Agent 工作配置"}</h2><p>{agentLabel === "Tanvis" ? "单封邮件的“AI 分析”会调用 Tanvis；只读本地内容并返回建议。" : "配置这个 Agent 的角色、技能和连接说明，保存后立即生效。"}</p></div>
        <div className="office__tanvis-state"><ShieldCheck size={15} />MCP 仅作说明，不授予本次分析工具权限</div>
      </div>
      <div className="office__tanvis-toolbar">
        <label className="office__agent-switcher">当前 Agent<select aria-label="选择要配置的 Agent" value={agentId} onChange={(event) => onSelectAgent(event.target.value)}>{(settings.agents ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}{!(settings.agents ?? []).some((item) => item.id === agentId) && <option value={agentId}>{agentLabel}</option>}</select></label>
        <select aria-label={`选择 ${agentLabel} provider`} value={providerName} onChange={(event) => setProviderName(event.target.value)} disabled={!providerNames.length}><option value="">选择 provider</option>{providerNames.map((name) => <option key={name} value={name}>{name} · {providers[name].model}</option>)}</select>
        {agent ? <span className={usesLocalProvider ? "office__tanvis-ready" : "office__tanvis-warning"}>{usesLocalProvider ? "已连接本地 provider" : "已配置云端 provider · 邮件分析需确认外发"} · {providerName || agent.provider_name}</span> : <><span>尚未加入 Agent Team</span><button className="primary" onClick={() => void createAgent()} disabled={!providerName}>加入 {agentLabel}</button></>}
        {!usesLocalProvider && <button className="link" onClick={onOpenSettings}>切换本地 provider</button>}
        <span className="office__tanvis-path">Home/{root}</span>
      </div>
      <div className="office__tanvis-files">
        {AGENT_FILES.map((name) => <label key={name}><span><FileText size={15} />{name}</span><textarea value={files[name]} onChange={(event) => updateFile(name, event.target.value)} spellCheck={false} disabled={loading} /></label>)}
        <label><span><FileText size={15} />system_prompt（可选）</span><textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} spellCheck={false} disabled={loading} placeholder={`补充 ${agentLabel} 的角色约束`} /></label>
      </div>
      {loading && <p className="hint">读取 {agentLabel} 配置…</p>}
      {notice && <p className="office__tanvis-notice">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="office__tanvis-actions"><span>配置文件通过 vault 读写，分析过程不会执行文件或 MCP 内容。</span><button className="primary" onClick={() => void save()} disabled={saving || loading || !providerName}><FloppyDisk size={15} />{saving ? "保存中…" : `保存 ${agentLabel} 配置`}</button></div>
    </section>
  );
}

export default function OfficeView({
  sessions,
  running,
  chats,
  providers,
  settings,
  onEnter,
  onCreate,
  onSaveSettings,
  onOpenSettings,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [providerName, setProviderName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const initialConfigAgent = settings.agents?.find((agent) => agent.label.toLowerCase() === "tanvis")?.id ?? settings.agents?.[0]?.id ?? "tanvis";
  const [configAgentId, setConfigAgentId] = useState(initialConfigAgent);

  const providerNames = Object.keys(providers);

  useEffect(() => {
    if (settings.agents?.some((agent) => agent.id === configAgentId)) return;
    setConfigAgentId(settings.agents?.find((agent) => agent.label.toLowerCase() === "tanvis")?.id ?? settings.agents?.[0]?.id ?? "tanvis");
  }, [configAgentId, settings.agents]);

  const submit = async () => {
    const name = providerName || providerNames[0];
    if (!name) {
      setError("请先在设置中配置 provider");
      return;
    }
    setError(null);
    try {
      await onCreate(label.trim(), name);
      setCreating(false);
      setLabel("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="office">
      <h1 className="office__title">Agent Team</h1>
      <p className="office__subtitle">每个工位是一个 agent 会话，点进去即可开始协作。</p>
      <AgentConfigPanel agentId={configAgentId} onSelectAgent={setConfigAgentId} settings={settings} providers={providers} onCreate={onCreate} onSaveSettings={onSaveSettings} onOpenSettings={onOpenSettings} />
      <div className="office__grid">
        {sessions.map((s, i) => {
          const isRunning = Boolean(running[s.id]);
          return (
            <div key={s.id} className="workstation" onClick={() => onEnter(s.id)}>
              {isRunning && (
                <div className="workstation__bubble">{activityOf(chats[s.id])}</div>
              )}
              <div className="workstation__scene">
                <div className="workstation__monitor">
                  <Screen running={isRunning} />
                  <div className="workstation__stand" />
                  <div className="workstation__stand-base" />
                </div>
                <div className="workstation__desk" />
                <div
                  className={`workstation__octopus ${isRunning ? "workstation__octopus--running" : ""}`}
                >
                  <PixelOctopus colorIndex={i} running={isRunning} />
                </div>
                <div className="workstation__floor" />
              </div>
              <div className="workstation__label">{s.label}</div>
              <div className="workstation__provider"><span>{s.providerName}</span><button className="workstation__configure" onClick={(event) => { event.stopPropagation(); setConfigAgentId(s.id); }}>配置</button></div>
            </div>
          );
        })}

        <div
          className="workstation workstation--empty"
          onClick={() => !creating && setCreating(true)}
        >
          {creating ? (
            <div className="workstation__form" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                placeholder="会话名称"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              {providerNames.length > 0 ? (
                <select
                  value={providerName || providerNames[0]}
                  onChange={(e) => setProviderName(e.target.value)}
                >
                  {providerNames.map((n) => (
                    <option key={n} value={n}>
                      {n}（{providers[n].model}）
                    </option>
                  ))}
                </select>
              ) : (
                <p className="hint">
                  尚无 provider，请先
                  <button className="link" onClick={onOpenSettings}>
                    配置
                  </button>
                </p>
              )}
              <div className="workstation__form-actions">
                <button onClick={() => setCreating(false)}>取消</button>
                <button className="primary" onClick={submit}>
                  创建
                </button>
              </div>
              {error && <p className="error-text">{error}</p>}
            </div>
          ) : (
            <>
              <div className="workstation__plus">+</div>
              <div className="workstation__label">新建 agent</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
