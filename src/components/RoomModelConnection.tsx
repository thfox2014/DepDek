import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { isLocalProvider, providerAllowedForMode, providerEndpoint } from "../lib/aiOsSetup";
import { roomModelLabel, type RoomModelState, type RoomModelStates } from "../lib/roomModel";

export type ModelStatusService = typeof api.aiOsModelStatus;
const signature = (provider: api.ProviderConfig) => JSON.stringify([provider.kind, providerEndpoint(provider), provider.model, provider.api_key]);
export function useRoomModelConnections(settings: api.Settings, current: string, mode: api.AiOsConnectionMode, cloudEnabled: boolean, service?: ModelStatusService) {
  const [results, setResults] = useState<Record<string, { signature: string; status: api.ModelConnection }>>({});
  const [revision, setRevision] = useState(0);
  const cache = useRef(new Map<string, { expires: number; result: Promise<api.ModelConnection> }>());
  const refresh = useCallback(() => { cache.current.clear(); setResults({}); setRevision((value) => value + 1); }, []);
  useEffect(() => {
    window.addEventListener(api.SETTINGS_CHANGED, refresh);
    window.addEventListener(api.AI_OS_LOGIN_RESTORED, refresh);
    return () => {
      window.removeEventListener(api.SETTINGS_CHANGED, refresh);
      window.removeEventListener(api.AI_OS_LOGIN_RESTORED, refresh);
    };
  }, [refresh]);
  const providers = settings.providers;
  const entries = Object.entries(providers);
  // At most eight local services plus one chosen cloud route. Never contact
  // unrelated cloud providers, or any cloud service in local/paused mode.
  const names = [...new Set([
    ...entries.filter(([, provider]) => isLocalProvider(provider)).slice(0, 8).map(([name]) => name),
    ...(mode === "online" && cloudEnabled ? [providers[current] && !isLocalProvider(providers[current]) ? current : entries.find(([, provider]) => !isLocalProvider(provider))?.[0]].filter((name): name is string => !!name) : []),
    ...(providers[current] && isLocalProvider(providers[current]) ? [current] : []),
  ])];
  const key = JSON.stringify(names.map((name) => [name, signature(providers[name])]));
  useEffect(() => {
    let active = true;
    const probe = service ?? (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? api.aiOsModelStatus : undefined);
    for (const name of names) {
      const fingerprint = signature(providers[name]);
      const cacheKey = `${name}:${fingerprint}`;
      let cached = cache.current.get(cacheKey);
      if (!cached || cached.expires < Date.now()) {
        const result = probe ? probe(name).catch((error): api.ModelConnection => /E32006|AUTH_REQUIRED|LOGIN_REQUIRED/.test(String(error))
          ? { state: "unknown", reason: "login_required" }
          : { state: "unavailable", reason: "unreachable" })
          : Promise.resolve<api.ModelConnection>({ state: "unknown", reason: "preview" });
        cached = { expires: Date.now() + 30_000, result };
        cache.current.set(cacheKey, cached);
      }
      void cached.result.then((status) => {
        if (active) setResults((items) => ({ ...items, [name]: { signature: fingerprint, status } }));
      });
    }
    return () => { active = false; };
  }, [key, mode, revision, service]);
  const states: RoomModelStates = {};
  for (const [name, provider] of entries) {
    const saved = results[name];
    states[name] = !providerAllowedForMode(provider, mode) || !cloudEnabled && !isLocalProvider(provider)
      ? { state: "unavailable", reason: "disabled" }
      : saved?.signature === signature(provider) ? saved.status
      : { state: "checking", reason: "pending" };
  }
  return { states, refresh };
}

export default function RoomModelConnection({ settings, providerName, states, cloudEnabled, onRefresh }: {
  settings: api.Settings; providerName: string; states: RoomModelStates; cloudEnabled: boolean; onRefresh: () => void;
}) {
  const provider = settings.providers[providerName];
  const local = Object.entries(settings.providers).filter(([, value]) => isLocalProvider(value));
  const localStatus: RoomModelState = local.find(([name]) => states[name]?.state === "available")?.[0]
    ? { state: "available", reason: "model_listed" }
    : local.some(([name]) => states[name]?.state === "checking") ? { state: "checking", reason: "pending" }
    : local.some(([name]) => states[name]?.state === "unknown") ? { state: "unknown", reason: "unverified" }
    : { state: "unavailable", reason: "no_local_model" };
  const active = provider && (isLocalProvider(provider) || cloudEnabled);
  const state = active ? states[providerName] : undefined;
  const secondary = provider && isLocalProvider(provider)
    ? "公域大模型 · 未使用"
    : `本地大模型 · ${localStatus.state === "unavailable" ? "不可用" : roomModelLabel(localStatus)}`;
  const label = !provider ? "大模型 · 未配置" : !active ? "公域大模型 · 已暂停"
    : `使用${isLocalProvider(provider) ? "本地" : "公域"}大模型 · ${roomModelLabel(state)}`;
  return <button type="button" className="ai-room__model-status" onClick={onRefresh}
    title={`${providerName || "请先配置模型"}${provider ? ` · ${provider.model}` : ""}。点击重新检测；只查询模型列表，不发送对话。`}
    aria-label={`${label}；${secondary}，点击重新检测`}>
    <span className={active && state?.state === "available" ? "is-connected" : ""}><i />{label}</span>
    <small><i className={(!provider || !isLocalProvider(provider)) && localStatus.state === "available" ? "is-connected" : ""} />{secondary}</small>
  </button>;
}
