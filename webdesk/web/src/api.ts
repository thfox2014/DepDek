/**
 * Typed client for the depdek-webdesk JSON API.
 *
 * When `VITE_WEBDESK_DEMO=1` or `?demo=1` is present the client answers from
 * `demo.ts` instead of the network, which is how the desktop/performance UI is
 * reviewed in a plain browser (same convention as the Tauri app's preview).
 */

import { demoApi } from "./demo";

export interface SessionInfo {
  authenticated: boolean;
  user: string | null;
  csrf: string | null;
  version: string;
  insecure_no_auth: boolean;
  tls: boolean;
  session_ttl_secs: number;
}

export interface CoreUsage {
  index: number;
  usage_pct: number;
  frequency_mhz: number;
}

export interface CpuSummary {
  usage_pct: number;
  per_core: CoreUsage[];
  load1: number;
  load5: number;
  load15: number;
}

export interface MemorySummary {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_pct: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  swap_used_pct: number;
}

export interface DiskSummary {
  name: string;
  file_system: string;
  mount_point: string;
  kind: string;
  removable: boolean;
  total_bytes: number;
  available_bytes: number;
  used_bytes: number;
  used_pct: number;
}

export interface DiskThroughput {
  read_bytes_per_sec: number;
  write_bytes_per_sec: number;
}

export interface NetworkSummary {
  name: string;
  received_bytes: number;
  transmitted_bytes: number;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
  errors: number;
}

export interface HostInfo {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  uptime_secs: number;
  cores_logical: number;
  cores_physical: number;
  cpu_brand: string;
  cpu_frequency_mhz: number;
  sampled_at_ms: number;
}

export interface Sample {
  ts_ms: number;
  cpu_pct: number;
  per_core_pct: number[];
  mem_pct: number;
  mem_used_bytes: number;
  swap_pct: number;
  load1: number;
  net_rx_bps: number;
  net_tx_bps: number;
  disk_read_bps: number;
  disk_write_bps: number;
  process_count: number;
}

export interface ProcessUsage {
  pid: number;
  name: string;
  exe: string | null;
  cmd: string;
  cpu_pct: number;
  cpu_pct_total: number;
  mem_bytes: number;
  virtual_bytes: number;
  status: string;
  run_time_secs: number;
  disk_read_bytes: number;
  disk_write_bytes: number;
  app_key: string;
  app_label: string;
  app_from_unit: boolean;
}

export interface AppUsage {
  key: string;
  label: string;
  from_unit: boolean;
  processes: number;
  cpu_pct: number;
  cpu_pct_total: number;
  mem_bytes: number;
  disk_read_bytes: number;
  disk_write_bytes: number;
  top_pids: number[];
}

export interface Summary {
  version: string;
  uptime_secs: number;
  sampled_at_ms: number;
  sample_count: number;
  interval_ms: number;
  host: HostInfo;
  cpu: CpuSummary;
  memory: MemorySummary;
  disks: DiskSummary[];
  disk_io: DiskThroughput;
  networks: NetworkSummary[];
  apps: AppUsage[];
  process_count: number;
}

export interface Series {
  interval_ms: number;
  sampled_at_ms: number;
  sample_count: number;
  samples: Sample[];
}

export interface ProcessList {
  sampled_at_ms: number;
  cores: number;
  total: number;
  processes: ProcessUsage[];
}

export interface AppList {
  sampled_at_ms: number;
  cores: number;
  total_memory_bytes: number;
  apps: AppUsage[];
}

export interface AuditEntry {
  ts: string;
  action: string;
  actor: string;
  ip: string;
  ok: boolean;
  detail: unknown;
}

export interface AuditTail {
  path: string;
  entries: AuditEntry[];
}

const params = new URLSearchParams(window.location.search);
export const demoMode =
  import.meta.env.VITE_WEBDESK_DEMO === "1" || params.get("demo") === "1";

let csrfToken: string | null = null;

export function setCsrf(token: string | null) {
  csrfToken = token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { "x-depdek-csrf": csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  session: () => (demoMode ? demoApi.session() : request<SessionInfo>("/api/session")),
  login: (password: string) =>
    demoMode
      ? demoApi.login()
      : request<SessionInfo>("/api/login", {
          method: "POST",
          body: JSON.stringify({ password }),
        }),
  logout: () =>
    demoMode ? demoApi.logout() : request<{ authenticated: boolean }>("/api/logout", { method: "POST" }),
  summary: () => (demoMode ? demoApi.summary() : request<Summary>("/api/system/summary")),
  series: (window: number) =>
    demoMode ? demoApi.series(window) : request<Series>(`/api/system/series?window=${window}`),
  processes: (sort: string, limit: number) =>
    demoMode
      ? demoApi.processes(sort, limit)
      : request<ProcessList>(`/api/processes?sort=${sort}&limit=${limit}`),
  apps: (limit: number) =>
    demoMode ? demoApi.apps(limit) : request<AppList>(`/api/apps?limit=${limit}`),
  audit: (limit: number) =>
    demoMode ? demoApi.audit(limit) : request<AuditTail>(`/api/audit?limit=${limit}`),
};

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

export function formatTime(ms: number): string {
  if (!ms) return "--:--:--";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}
