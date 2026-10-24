export type DebugErrorEntry = {
  id: string;
  time: string;
  source: string;
  message: string;
  stack?: string;
};

const ENABLED_KEY = "jiaho.debug.capture.enabled";
const ERRORS_KEY = "jiaho.debug.capture.errors.v1";
const MAX_ENTRIES = 30;
const MAX_STACK_LENGTH = 8_000;

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function isDebugCaptureEnabled(): boolean {
  const local = storage();
  if (!local) return import.meta.env?.VITE_DEPDEK_DEBUG === "1";
  try {
    const saved = local.getItem(ENABLED_KEY);
    return saved === null ? import.meta.env?.VITE_DEPDEK_DEBUG === "1" : saved === "true";
  } catch { return import.meta.env?.VITE_DEPDEK_DEBUG === "1"; }
}

export function setDebugCaptureEnabled(enabled: boolean): void {
  try { storage()?.setItem(ENABLED_KEY, String(enabled)); } catch { /* local diagnostics are best effort */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("jiaho-debug-capture-changed"));
}

export function readDebugErrors(): DebugErrorEntry[] {
  try {
    const value = storage()?.getItem(ERRORS_KEY);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(-MAX_ENTRIES) as DebugErrorEntry[] : [];
  } catch { return []; }
}

export function clearDebugErrors(): void {
  try { storage()?.removeItem(ERRORS_KEY); } catch { /* local diagnostics are best effort */ }
}

function safeText(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : typeof value === "string" ? value : String(value);
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

export function captureDebugError(source: string, failure: unknown, stack?: string): void {
  if (!isDebugCaptureEnabled()) return;
  const entry: DebugErrorEntry = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    source: safeText(source),
    message: safeText(failure),
    ...(stack ? { stack: safeText(stack).slice(0, MAX_STACK_LENGTH) } : failure instanceof Error && failure.stack ? { stack: safeText(failure.stack).slice(0, MAX_STACK_LENGTH) } : {}),
  };
  try {
    const entries = [...readDebugErrors(), entry].slice(-MAX_ENTRIES);
    storage()?.setItem(ERRORS_KEY, JSON.stringify(entries));
  } catch { /* quota/privacy mode: retain console evidence without breaking the app */ }
  console.error(`[Jiaho diagnostic] ${entry.source}: ${entry.message}`, entry.stack ?? "");
}

let installed = false;
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    captureDebugError("window.error", event.error ?? event.message, event.error instanceof Error ? event.error.stack : undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    captureDebugError("unhandledrejection", event.reason, event.reason instanceof Error ? event.reason.stack : undefined);
  });
}
