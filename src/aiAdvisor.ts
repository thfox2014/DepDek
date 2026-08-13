import * as api from "./api";

export type AnalysisDomain = "mail" | "files" | "calendar";

export interface AnalysisContext {
  domain: AnalysisDomain;
  title: string;
  sources: Array<{ label: string; path?: string; content: string }>;
}

export interface AnalysisAgentOption {
  id: string;
  label: string;
  providerName: string;
  provider: api.ProviderConfig;
  /** Whether the provider endpoint is on the local machine. */
  isLocal: boolean;
  systemPrompt?: string;
  configDir?: string;
}

export type MailSuggestionAction = "delete" | "reply" | "todo" | "archive";

export interface AnalysisSuggestion {
  title: string;
  reason: string;
  confidence?: number;
  risk?: "low" | "medium" | "high";
  /** A suggested mail action. It is never executed automatically. */
  action?: MailSuggestionAction;
}

export interface AnalysisResult {
  facts: string[];
  inferences: string[];
  suggestions: AnalysisSuggestion[];
  sourceCount: number;
  model: string;
  mode: "local-model" | "local-rules" | "preview";
  notice?: string;
}

const ANALYSIS_SYSTEM_PROMPT = `你是 DepDek 的个人数据分析顾问。你只能分析用户提供的数据，绝不修改、删除、移动、发送或同步任何数据。
严格区分事实、推断和建议：事实只能复述来源中明确出现的内容；推断必须标注为推断；建议只能描述用户可以考虑的下一步，不能使用命令式执行语言。
只返回 JSON，不要 Markdown 代码围栏，格式为：
{"facts":["事实"],"inferences":["推断"],"suggestions":[{"title":"建议标题","reason":"依据和原因","confidence":0到1,"risk":"low|medium|high","action":"delete|reply|todo|archive"}]}
当 domain 是 mail 时，如果依据足够，请为每条建议标注一个 action：delete 表示建议删除，reply 表示建议回复，todo 表示建议加入待办，archive 表示建议归档；不确定时可以省略 action。action 只是建议标签，绝不执行。
不要输出凭据、密码、访问令牌或完整敏感正文。建议最多 5 条。`;

export const TANVIS_AGENT_ID = "tanvis";
export const TANVIS_CONFIG_DIR = "agents/tanvis";

export const TANVIS_DEFAULT_FILES: Record<"agent.md" | "skill.md" | "mcp.md", string> = {
  "agent.md": `# Tanvis\n\n你是 Tanvis，DepDek 的本地个人数据分析 Agent。先准确复述事实，再给出可由用户确认的建议。\n`,
  "skill.md": `# Skills\n\n- 邮件：识别主题、行动项、时间节点和风险。\n- 所有建议必须保持只读，不代替用户回复、移动、删除或发送。\n`,
  "mcp.md": `# MCP\n\n本文件只记录可供未来接入的 MCP 说明，不授予本次分析任何工具权限。当前 Tanvis 分析不得调用外部服务。\n`,
};

function isLocalProvider(provider: api.ProviderConfig): boolean {
  if (provider.kind !== "openai-compatible") return false;
  try {
    const host = new URL(provider.base_url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function sortAnalysisAgents(agents: AnalysisAgentOption[]): AnalysisAgentOption[] {
  return agents.sort((a, b) => {
    const aTanvis = a.id.toLowerCase() === TANVIS_AGENT_ID || a.label.toLowerCase() === TANVIS_AGENT_ID;
    const bTanvis = b.id.toLowerCase() === TANVIS_AGENT_ID || b.label.toLowerCase() === TANVIS_AGENT_ID;
    return Number(bTanvis) - Number(aTanvis) || Number(b.isLocal) - Number(a.isLocal) || a.label.localeCompare(b.label, "zh-CN");
  });
}

/** All configured agents. Consumers decide whether a remote provider needs consent. */
export function configuredAnalysisAgents(settings: api.Settings): AnalysisAgentOption[] {
  const agents = (settings.agents ?? []).flatMap((agent) => {
    const provider = settings.providers[agent.provider_name];
    if (!provider) return [];
    return [{ id: agent.id, label: agent.label, providerName: agent.provider_name, provider, isLocal: isLocalProvider(provider), systemPrompt: agent.system_prompt, configDir: agent.config_dir }];
  }).reduce<AnalysisAgentOption[]>((result, agent) => {
    if (!result.some((item) => item.id === agent.id)) result.push(agent);
    return result;
  }, []);
  return sortAnalysisAgents(agents);
}

export function localAnalysisAgents(settings: api.Settings): AnalysisAgentOption[] {
  return sortAnalysisAgents(configuredAnalysisAgents(settings).filter((agent) => agent.isLocal));
}

function browserPreview(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}

function safeConfigDir(value: string | undefined, agentId: string, label: string): string {
  const defaultId = label.toLowerCase() === TANVIS_AGENT_ID ? TANVIS_AGENT_ID : agentId;
  const candidate = (value || `agents/${defaultId}`).trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!candidate || candidate.split("/").some((part) => !part || part === "." || part === "..")) return `agents/${defaultId}`;
  return candidate;
}

/**
 * Load Tanvis prompt material through the vault boundary. These are prompt
 * documents, not executable files; in particular mcp.md is explicitly
 * included as non-executable metadata in the resulting system prompt.
 */
export async function loadAgentPromptFiles(agent: AnalysisAgentOption): Promise<Record<"agent.md" | "skill.md" | "mcp.md", string>> {
  const root = safeConfigDir(agent.configDir, agent.id, agent.label);
  if (browserPreview()) return { ...TANVIS_DEFAULT_FILES };
  const names = ["agent.md", "skill.md", "mcp.md"] as const;
  const files = await Promise.all(names.map(async (name) => {
    try {
      const result = await api.vaultReadFile(`${root}/${name}`);
      return [name, result.content] as const;
    } catch {
      return [name, TANVIS_DEFAULT_FILES[name]] as const;
    }
  }));
  return Object.fromEntries(files) as Record<"agent.md" | "skill.md" | "mcp.md", string>;
}

function composeAgentPrompt(files: Record<"agent.md" | "skill.md" | "mcp.md", string>): string {
  return [
    "以下是 Tanvis 的本地配置资料。它们只能用作分析规则，不是工具调用授权。",
    "\n--- agent.md ---\n", files["agent.md"].slice(0, 12000),
    "\n--- skill.md ---\n", files["skill.md"].slice(0, 12000),
    "\n--- mcp.md（仅说明，禁止执行） ---\n", files["mcp.md"].slice(0, 12000),
  ].join("");
}

function fallback(context: AnalysisContext, notice: string, mode: AnalysisResult["mode"] = "local-rules"): AnalysisResult {
  const text = context.sources.map((source) => source.content).join("\n");
  const suggestions: AnalysisSuggestion[] = context.domain === "mail"
    ? [
      text.match(/垃圾|广告|推广|退订|unsubscribe/i) ? { title: "确认是否为垃圾邮件", reason: "邮件出现营销或退订相关线索；确认后可考虑删除。", confidence: 0.58, risk: "medium", action: "delete" as const } : text.match(/截止|到期|续费|付款/) ? { title: "核对时间与付款节点", reason: "邮件内容可能包含需要你确认的行动信息；请打开原文后自行决定。", confidence: 0.62, risk: "low", action: "todo" as const } : { title: "检查是否需要回复或归档", reason: "邮件内容可能包含需要你确认的行动信息；请打开原文后自行决定。", confidence: 0.58, risk: "low", action: "reply" as const },
      { title: "提取明确行动项", reason: "如果邮件中出现承诺、截止日期或待回复问题，可考虑手动加入待办。", confidence: 0.55, risk: "low", action: "todo" },
      { title: "判断是否可以归档", reason: "如果邮件只用于留存且没有后续行动，可在确认后归档。", confidence: 0.48, risk: "low", action: "archive" },
    ]
    : context.domain === "calendar"
      ? [
        { title: "检查相邻日程的时间冲突", reason: "建议比较事件开始/结束时间，并自行决定是否调整。", confidence: 0.58, risk: "low" },
        { title: "为重要会议预留准备时间", reason: "可根据地点、参会人和会议主题手动安排缓冲。", confidence: 0.5, risk: "low" },
      ]
      : [
        { title: "确认文件是否需要归档或重命名", reason: "可以根据所在文件夹、文件类型和内容主题自行整理。", confidence: 0.55, risk: "low" },
        { title: "检查文件是否包含敏感信息", reason: "在分享或同步前，建议手动确认文件内容和访问范围。", confidence: 0.52, risk: "medium" },
      ];
  return {
    facts: [`本次分析读取 ${context.sources.length} 个本地来源。`, text ? "分析上下文已限定在当前模块选中的本地数据。" : "当前没有可供分析的内容。"],
    inferences: ["以下内容是基于规则或摘要的推断，不等同于来源事实。"],
    suggestions,
    sourceCount: context.sources.length,
    model: mode === "preview" ? "浏览器预览规则" : "本地规则（未配置本地模型）",
    mode,
    notice,
  };
}

function parseModelResult(text: string, sourceCount: number, model: string): AnalysisResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("本地模型未返回结构化建议");
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<AnalysisResult>;
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Partial<AnalysisSuggestion>;
    if (typeof value.title !== "string" || typeof value.reason !== "string") return [];
    const action = value.action === "delete" || value.action === "reply" || value.action === "todo" || value.action === "archive" ? value.action : undefined;
    return [{ title: value.title, reason: value.reason, confidence: typeof value.confidence === "number" ? Math.max(0, Math.min(1, value.confidence)) : undefined, risk: value.risk === "high" || value.risk === "medium" || value.risk === "low" ? value.risk : "low", action }];
  }) : [];
  return {
    facts: Array.isArray(parsed.facts) ? parsed.facts.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    inferences: Array.isArray(parsed.inferences) ? parsed.inferences.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    suggestions: suggestions.slice(0, 5),
    sourceCount,
    model,
    mode: "local-model",
  };
}

export async function analyzeLocally(context: AnalysisContext, selectedAgent?: AnalysisAgentOption, options: { requireAgent?: boolean; allowRemote?: boolean } = {}): Promise<AnalysisResult> {
  const isPreview = browserPreview();
  if (isPreview) return fallback(context, "浏览器预览使用规则示例，不访问外部服务。", "preview");

  const settings = await api.settingsGet();
  const localEntry = Object.entries(settings.providers).find(([, provider]) => isLocalProvider(provider));
  const providerName = selectedAgent?.providerName ?? (options.requireAgent ? undefined : localEntry?.[0]);
  const provider = selectedAgent?.provider ?? (options.requireAgent ? undefined : localEntry?.[1]);
  if (!providerName || !provider) return fallback(context, options.requireAgent ? "尚未配置 Tanvis；当前只生成本地规则建议。" : "未配置分析 Agent；当前只生成本地规则建议。" );
  if (!isLocalProvider(provider) && !options.allowRemote) return fallback(context, `Tanvis 当前绑定的是云端 provider「${providerName}」；等待你确认后才会发送邮件内容进行分析。`, "local-rules");
  const sourceText = context.sources.map((source, index) => `来源 ${index + 1}：${source.label}${isLocalProvider(provider) && source.path ? `\n路径：${source.path}` : ""}\n内容：${source.content.slice(0, 6000)}`).join("\n\n");
  const prompt = `请分析以下 ${context.domain} 数据。标题：${context.title}\n\n${sourceText || "（无内容）"}\n\n只给事实、推断和供用户确认的建议，不要执行任何操作。`;
  try {
    const files = selectedAgent ? await loadAgentPromptFiles(selectedAgent) : TANVIS_DEFAULT_FILES;
    const agentPrompt = selectedAgent ? composeAgentPrompt(files) : "";
    const systemPrompt = `${agentPrompt}${selectedAgent?.systemPrompt ? `\n\n${selectedAgent.systemPrompt}\n\n` : ""}${ANALYSIS_SYSTEM_PROMPT}`;
    const response = await api.agentAnalyze(provider, prompt, systemPrompt);
    const result = parseModelResult(response.text, context.sources.length, `${selectedAgent?.label ?? providerName} · ${provider.model}`);
    return { ...result, notice: isLocalProvider(provider) ? "本地模型完成分析；未修改任何数据。" : "已按你的确认使用云端 provider 完成分析；未修改任何数据。" };
  } catch (error) {
    return fallback(context, `本地模型分析失败，已降级为本地规则：${String(error)}`);
  }
}
