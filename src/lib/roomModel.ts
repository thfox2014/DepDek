import type { AiOsConnectionMode, ModelConnection, Settings } from "../api";
import { isLocalProvider, providerAllowedForMode } from "./aiOsSetup.ts";

export type RoomModelState = Omit<ModelConnection, "state"> & { state: ModelConnection["state"] | "checking" };
export type RoomModelStates = Record<string, RoomModelState | undefined>;

/** Preserve a working/user-selected provider. Fall back only after local checks
 * actually fail; offline mode and an explicit cloud opt-out always win. */
export function roomProviderFallback(settings: Settings, current: string, mode: AiOsConnectionMode, states: RoomModelStates, cloudEnabled: boolean): string {
  const entries = Object.entries(settings.providers);
  const provider = settings.providers[current];
  if (provider && providerAllowedForMode(provider, mode)) {
    if (!isLocalProvider(provider)) return cloudEnabled ? current : "";
    if (states[current]?.state !== "unavailable") return current;
  }
  const local = entries.filter(([, value]) => isLocalProvider(value));
  const available = local.find(([name]) => states[name]?.state === "available");
  if (available) return available[0];
  if (local.some(([name]) => !states[name] || states[name]?.state === "checking" || states[name]?.state === "unknown")) return "";
  return mode === "online" && cloudEnabled ? entries.find(([, value]) => !isLocalProvider(value))?.[0] ?? "" : "";
}

export function roomModelLabel(state: RoomModelState | undefined): string {
  if (!state || state.state === "checking") return "检测中";
  if (state.reason === "login_required") return "请重新登录";
  if (state.state === "available") return "已连接";
  if (state.state === "unknown") return "待验证";
  return ({ unauthorized: "密钥待检查", model_missing: "模型不可用", not_configured: "未配置" } as Record<string, string>)[state.reason] ?? "未连接";
}
