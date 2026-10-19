import type { AiOsConnectionMode, ProviderConfig, Settings } from "../api";
import { makeRoomAgent } from "./aiOsRoom.ts";

export const SETUP_AGENT_ID = "depdek-os-assistant";
export const BUILTIN_PROVIDER = {
  kind: "openai-compatible", base_url: "http://127.0.0.1:11435/v1", model: "jiaho-setup",
} satisfies ProviderConfig;
export type SetupChoice =
  | { kind: "builtin" }
  | { kind: "existing"; name: string }
  | { kind: "custom"; name: string; endpoint: string; model: string; apiKey: string };
export type SetupSelection = { name: string; provider: ProviderConfig };
export type SetupPort = {
  settingsGet: () => Promise<Settings>;
  settingsSet: (settings: Settings) => Promise<void>;
  vaultSetRoot: (path: string) => Promise<string>;
  vaultInitHome: () => Promise<string>;
};
const owns = (providers: Settings["providers"], name: string) => Object.prototype.hasOwnProperty.call(providers, name);

export function isBuiltinProvider(provider: ProviderConfig): boolean {
  return provider.kind === "openai-compatible" && provider.base_url === BUILTIN_PROVIDER.base_url
    && provider.model === BUILTIN_PROVIDER.model && !provider.api_key;
}

export function providerEndpoint(provider: ProviderConfig): string {
  if (provider.kind === "anthropic") return "https://api.anthropic.com";
  return provider.base_url ?? "https://api.openai.com/v1";
}

export function isLocalProvider(provider: ProviderConfig): boolean {
  try {
    const endpoint = new URL(providerEndpoint(provider));
    const host = endpoint.hostname;
    return (endpoint.protocol === "http:" || endpoint.protocol === "https:")
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && (host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host));
  } catch { return false; }
}
export function providerAllowedForMode(provider: ProviderConfig, mode: AiOsConnectionMode): boolean {
  return mode === "online" || isLocalProvider(provider);
}

export function customSetupProvider(choice: Extract<SetupChoice, { kind: "custom" }>): SetupSelection {
  const name = choice.name.trim();
  const model = choice.model.trim();
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
    throw new Error("请填写 1–64 位的模型显示名称。");
  }
  if (!model || model.length > 160 || /\s/.test(model)) throw new Error("请填写有效的模型 ID，不要包含空格或换行。");
  let url: URL;
  try { url = new URL(choice.endpoint.trim()); }
  catch { throw new Error("请填写完整的 API 基础 URL。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("远程模型地址需要 HTTPS；本机回环服务可以使用 HTTP。");
  if (url.username || url.password || url.search || url.hash) throw new Error("请勿在 URL 中填写密码、API Key、查询参数或锚点。");
  if (/\/chat\/completions\/?$/.test(url.pathname)) throw new Error("请填写 API 基础路径（如 /v1），而不是 /chat/completions。");
  const key = choice.apiKey.trim();
  if (key === "********" || key.startsWith("$secret:") || /[\r\n\x00]/.test(key)) throw new Error("请填写服务商提供的真实 API Key，或留空。");
  return { name, provider: { kind: "openai-compatible", base_url: url.href.replace(/\/$/, ""), model, ...(key ? { api_key: key } : {}) } };
}

/** UI orchestration only. Authorization and credential encryption remain in Rust. */
export async function saveSetupProvider(choice: SetupChoice, port: SetupPort, language = "zh-CN", agentId = SETUP_AGENT_ID, mode: AiOsConnectionMode = "online"): Promise<SetupSelection> {
  const custom = choice.kind === "custom" ? customSetupProvider(choice) : null;
  if (custom && !providerAllowedForMode(custom.provider, mode)) throw new Error("本地模式仅支持数值回环地址，例如 http://127.0.0.1:11434/v1。");
  let settings = await port.settingsGet();
  if (settings.last_root) await port.vaultSetRoot(settings.last_root);
  else await port.vaultInitHome();
  // vaultInitHome persists last_root. Never overwrite it with the pre-init snapshot.
  settings = await port.settingsGet();
  let selection: SetupSelection;
  if (choice.kind === "existing") {
    if (!owns(settings.providers, choice.name)) throw new Error("该模型已被删除，请重新选择。");
    selection = { name: choice.name, provider: settings.providers[choice.name] };
  } else if (custom) {
    if (owns(settings.providers, custom.name)) throw new Error("显示名称已存在，请选择已有模型或换一个名称。");
    selection = custom;
  } else {
    const existing = Object.entries(settings.providers).find(([, provider]) => isBuiltinProvider(provider));
    let name = "Jiaho 本地助手";
    for (let suffix = 2; owns(settings.providers, name) && !existing; suffix++) name = `Jiaho 本地助手 ${suffix}`;
    selection = existing ? { name: existing[0], provider: existing[1] } : { name, provider: BUILTIN_PROVIDER };
  }
  if (!providerAllowedForMode(selection.provider, mode)) throw new Error("本地模式不能使用这个云端模型，请选择本机模型或切换联网模式。");
  const agents = settings.agents ?? [];
  const saved = agents.find((agent) => agent.id === agentId);
  await port.settingsSet({
    ...settings,
    providers: { ...settings.providers, [selection.name]: selection.provider },
    agents: saved
      ? agents.map((agent) => agent.id === agentId ? { ...agent, provider_name: selection.name } : agent)
      : [...agents, makeRoomAgent(agentId, selection.name, language)],
  });
  // Only return the persisted reference, never the submitted plaintext key.
  const stored = await port.settingsGet();
  if (!owns(stored.providers, selection.name)) throw new Error("模型配置未保存成功，请重试。");
  const provider = stored.providers[selection.name];
  if (provider.api_key && !provider.api_key.startsWith("$secret:") && provider.api_key !== "********") {
    throw new Error("模型凭据未安全保存，请检查本机凭据服务。");
  }
  return { name: selection.name, provider };
}
