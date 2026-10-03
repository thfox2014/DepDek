/**
 * HTTP face of the agent service.
 *
 * The desktop shell talks to the sidecar over stdio; browsers cannot. The
 * standalone sidecar therefore exposes this small API, and every read and
 * write goes through the same vault client the agent tools use — so settings
 * land as files inside the local data folder, never in browser storage.
 *
 * Security: the server binds to 127.0.0.1, CORS is restricted to the dev
 * preview origin (`http://localhost:1420`), and settings reads/writes require
 * a per-launch bearer token injected by the Vite proxy — the browser JS never
 * sees it, and API keys are redacted before any payload leaves the sidecar.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { isSecretRef, secretRef, createCredentialsAccess } from "./credentials.js";
import { readSettings, writeSettings, type SettingsFile } from "./settingsFile.js";
import type { VaultClient } from "./tools.js";

const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_ALLOWED_ORIGIN = "http://localhost:1420";
const REDACTED = "********";
/** Only conversation files for the browser preview may be written here. */
const VAULT_FILE_PATTERN = /^agent\/[a-zA-Z0-9._-]+\/conversations\.json$/;

export interface AgentHttpService {
  port: number;
  close(): Promise<void>;
}

export interface AgentHttpOptions {
  /** Per-launch bearer token; required for settings reads/writes when set. */
  token?: string;
  /** Browser origin allowed by CORS (defaults to the Vite preview origin). */
  allowedOrigin?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** CORS headers are only emitted for the exact preview origin; other origins
 *  get no allow-origin header, so the browser blocks the response body. */
function corsHeaders(req: IncomingMessage, allowedOrigin: string): Record<string, string> {
  if (req.headers.origin === allowedOrigin) {
    return {
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "GET, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, x-depdek-token",
      vary: "origin",
    };
  }
  return {};
}

function tokenMatches(expected: string | undefined, header: string | string[] | undefined): boolean {
  if (!expected) return true; // No token configured: loopback-only service stays open.
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Redact API keys before any payload leaves the sidecar. */
function redactSettings(settings: SettingsFile): SettingsFile {
  const providers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(settings.providers)) {
    const record = (cfg ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...record };
    if (typeof record.api_key === "string" && record.api_key.length > 0) {
      out.api_key = REDACTED;
    }
    providers[name] = out;
  }
  return { ...settings, providers };
}

/** Patch merge: placeholder/empty keys preserve the stored value, so a
 *  redacted round-trip can never wipe a real API key. */
function mergeSettings(current: SettingsFile, incoming: unknown): SettingsFile {
  const raw = (incoming ?? {}) as Record<string, unknown>;
  const providers = (raw["providers"] ?? {}) as Record<string, unknown>;
  const mergedProviders: Record<string, unknown> = { ...current.providers };
  for (const [name, cfg] of Object.entries(providers)) {
    const existing = (mergedProviders[name] ?? {}) as Record<string, unknown>;
    const record = (cfg ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing, ...record };
    if (merged.api_key === REDACTED || merged.api_key === "" || merged.api_key == null) {
      merged.api_key = existing.api_key;
    }
    mergedProviders[name] = merged;
  }
  return {
    ...raw,
    providers: mergedProviders,
    agents: Array.isArray(raw["agents"]) ? raw["agents"] : current.agents,
  } as SettingsFile;
}

/**
 * Fresh (non-placeholder) provider API keys never land in settings.json:
 * they are encrypted into secrets/providers.enc.json and replaced by a
 * `$secret:` reference. Placeholder/redacted/`$secret:` values pass through.
 */
async function encryptFreshProviderKeys(
  client: VaultClient,
  settings: SettingsFile,
): Promise<void> {
  const access = await createCredentialsAccess(client, "settings");
  for (const [name, cfg] of Object.entries(settings.providers)) {
    const record = cfg as Record<string, unknown>;
    const apiKey = record.api_key;
    if (typeof apiKey !== "string" || apiKey === "" || apiKey === REDACTED || isSecretRef(apiKey)) {
      continue;
    }
    const ref = secretRef("providers", `${name}.api_key`);
    await access.setSecret("providers", `${name}.api_key`, apiKey);
    record.api_key = ref;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, headers: Record<string, string>): void {
  res.writeHead(204, { "cache-control": "no-store", ...headers });
  res.end();
}

async function handle(
  client: VaultClient,
  req: IncomingMessage,
  res: ServerResponse,
  options: AgentHttpOptions & { allowedOrigin: string },
): Promise<void> {
  const cors = corsHeaders(req, options.allowedOrigin);
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  try {
    if (req.method === "OPTIONS") {
      sendNoContent(res, cors);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/health") {
      sendJson(res, 200, { ok: true }, cors);
      return;
    }
    const settingsRoute =
      pathname === "/v1/settings" && (req.method === "GET" || req.method === "PUT");
    const vaultRoute =
      pathname === "/v1/vault/read" && req.method === "GET";
    const vaultWriteRoute =
      pathname === "/v1/vault/write" && req.method === "PUT";
    if (
      (settingsRoute || vaultRoute || vaultWriteRoute) &&
      !tokenMatches(options.token, req.headers["x-depdek-token"])
    ) {
      sendJson(res, 401, { error: "unauthorized" }, cors);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/settings") {
      sendJson(res, 200, redactSettings(await readSettings(client)), cors);
      return;
    }
    if (req.method === "PUT" && pathname === "/v1/settings") {
      const raw = await readBody(req);
      const current = await readSettings(client);
      const merged = mergeSettings(current, JSON.parse(raw || "{}"));
      await encryptFreshProviderKeys(client, merged);
      await writeSettings(client, merged);
      sendNoContent(res, cors);
      return;
    }
    if (vaultRoute) {
      // Conversation persistence for the browser preview (section 2.3):
      // only agent/<id>/conversations.json may be read/written over HTTP.
      const path = url.searchParams.get("path") ?? "";
      if (!VAULT_FILE_PATTERN.test(path)) {
        sendJson(res, 400, { error: "path must match agent/<id>/conversations.json" }, cors);
        return;
      }
      try {
        const file = await client.request<{ content: string; size: number; sha256: string }>(
          "vault/read_file",
          { session_id: "user", path },
        );
        sendJson(res, 200, file, cors);
      } catch (err) {
        if (err instanceof Error && /not found|no such file|-32002/i.test(err.message)) {
          sendJson(res, 404, { error: "file not found" }, cors);
          return;
        }
        throw err;
      }
      return;
    }
    if (vaultWriteRoute) {
      const body = JSON.parse(await readBody(req)) as { path?: string; content?: string };
      const path = String(body.path ?? "");
      if (!VAULT_FILE_PATTERN.test(path)) {
        sendJson(res, 400, { error: "path must match agent/<id>/conversations.json" }, cors);
        return;
      }
      const written = await client.request<{ size: number; sha256: string }>(
        "vault/write_file",
        { session_id: "user", path, content: String(body.content ?? "") },
      );
      sendJson(res, 200, written, cors);
      return;
    }
    sendJson(res, 404, { error: `no route for ${req.method ?? "GET"} ${pathname}` }, cors);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }, cors);
  }
}

export function startAgentHttpServer(
  client: VaultClient,
  port: number,
  options?: AgentHttpOptions,
): Promise<AgentHttpService> {
  const allowedOrigin = options?.allowedOrigin ?? DEFAULT_ALLOWED_ORIGIN;
  const server = createServer((req, res) => {
    void handle(client, req, res, { allowedOrigin, token: options?.token });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = address && typeof address === "object" ? address.port : port;
      resolve({
        port: actual,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}