/**
 * Shared helpers for first-party control files.
 *
 * These files are protected vault paths. The sidecar reads and writes them
 * with a fixed trusted session id; agent tools never choose that id.
 */

import { RpcError } from "./rpc.js";
import type { VaultClient } from "./tools.js";

export const CONTROL_PATHS = {
  teamTasks: "team/tasks.json",
  teamPolicy: "team/policy.json",
  mcpConnectors: "mcp/connectors.json",
  routines: "schedule/routines.json",
  drafts: "mail/outgoing-drafts.json",
} as const;

export function rpcCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "number") {
    return (err as { code: number }).code;
  }
  return undefined;
}

export function oneLine(value: string, max = 240): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

export async function readControlJson<T>(vault: VaultClient, sessionId: string, path: string): Promise<T | undefined> {
  try {
    const result = await vault.request<{ content?: unknown }>("vault/read_file", { session_id: sessionId, path });
    if (!result || typeof result.content !== "string" || !result.content.trim()) return undefined;
    return JSON.parse(result.content) as T;
  } catch (err) {
    const code = rpcCode(err);
    if (code === -32002) return undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("not found")) return undefined;
    if (err instanceof SyntaxError) {
      console.error(`[sidecar] ignoring malformed control file ${path}`);
      return undefined;
    }
    throw err;
  }
}

export async function writeControlJson(vault: VaultClient, sessionId: string, path: string, value: unknown): Promise<void> {
  await vault.request("vault/write_file", {
    session_id: sessionId,
    path,
    content: JSON.stringify(value),
  });
}

export function isRootNotSet(err: unknown): boolean {
  if (rpcCode(err) === -32004) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("vault root not set");
}

const SECRET_KEY = /token|password|secret|authorization|api[_-]?key|credential|cookie/i;

/** Clip a tool-argument preview so approval cards never show credential-shaped fields. */
export function redactPreview(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactPreview(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[key] = SECRET_KEY.test(key) ? "（已隐藏）" : redactPreview(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

export function assertSlug(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) {
    throw new RpcError(-32602, `${label} must be 1-64 letters, numbers, _ or -`);
  }
  return trimmed;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return value.length <= 500;
  } catch {
    return false;
  }
}
