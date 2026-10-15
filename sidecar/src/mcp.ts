/**
 * HTTP MCP client.
 *
 * Connectors are user-configured URLs. This module never spawns a process
 * and never accepts a command line. Grants come from mcp.md lines of the
 * form `connector/tool` (see grants.ts). Every tools/call is checked against
 * that grant, waits for an approval card, then is appended to the Rust audit
 * log. OAuth and bearer tokens stay in the existing encrypted credential
 * store and are not returned to the model or the UI.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  CONTROL_PATHS,
  assertSlug,
  isHttpUrl,
  isRootNotSet,
  oneLine,
  readControlJson,
  writeControlJson,
} from "./control.js";
import { effectiveGrants, parseGrantDocument, sanitizeGrantList } from "./grants.js";
import { RpcError } from "./rpc.js";
import type { ActionApproval, VaultClient } from "./tools.js";

export const MCP_PROTOCOL = "2025-03-26";

export type McpAuth = "none" | "bearer" | "oauth";

export interface McpConnector {
  id: string;
  label: string;
  url: string;
  auth: McpAuth;
}

interface ConnectorFile {
  version: 1;
  connectors: McpConnector[];
}

export interface McpSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface McpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type McpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<McpResponse>;

const SECRET_FIELDS = ["access_token", "refresh_token", "token_url", "client_id", "client_secret", "token"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

function toolResult(text: string, details: Record<string, unknown>): AgentToolResult<any> {
  return { content: [{ type: "text", text }], details };
}

function asConnectors(file: ConnectorFile | undefined): McpConnector[] {
  if (!file || file.version !== 1 || !Array.isArray(file.connectors)) return [];
  return file.connectors.filter((item) => item && typeof item.id === "string" && typeof item.url === "string");
}

export class McpRegistry {
  private readonly grants = new Map<string, Set<string>>();
  private readonly sessions = new Map<string, string>();
  private readonly initialized = new Set<string>();
  private nextId = 1;

  constructor(
    private readonly vault: VaultClient,
    private readonly approval: ActionApproval,
    private readonly secrets: McpSecrets,
    private readonly fetchImpl: McpFetch = (url, init) => fetch(url, init),
  ) {}

  forget(sessionId: string): void {
    this.grants.delete(sessionId);
  }

  async resolveGrants(configDir?: string, explicit?: string[]): Promise<string[]> {
    const fileGrants = configDir ? await this.readGrantFile(configDir) : null;
    const argGrants = explicit ? sanitizeGrantList(explicit) : null;
    return effectiveGrants(fileGrants, argGrants);
  }

  toolsFor(sessionId: string, grants: string[]): AgentTool<any>[] {
    const allowed = new Set(grants);
    this.grants.set(sessionId, allowed);
    return [...allowed].map((grant) => this.makeTool(sessionId, grant));
  }

  async listConnectors(): Promise<{ connectors: McpConnector[] }> {
    return { connectors: await this.readConnectors() };
  }

  async putConnector(input: unknown): Promise<{ connector: McpConnector }> {
    const connector = normalizeConnector(input);
    const connectors = await this.readConnectors();
    const index = connectors.findIndex((item) => item.id === connector.id);
    if (index >= 0) connectors[index] = connector;
    else {
      if (connectors.length >= 50) throw new RpcError(-32602, "too many MCP connectors");
      connectors.push(connector);
    }
    await this.writeConnectors(connectors);
    this.initialized.delete(connector.id);
    this.sessions.delete(connector.id);
    return { connector };
  }

  async deleteConnector(id: string): Promise<{ deleted: boolean }> {
    const connectorId = assertSlug(id, "connector id");
    const connectors = await this.readConnectors();
    const next = connectors.filter((item) => item.id !== connectorId);
    await this.writeConnectors(next);
    this.initialized.delete(connectorId);
    this.sessions.delete(connectorId);
    return { deleted: next.length !== connectors.length };
  }

  async oauthStore(input: unknown): Promise<{ connector_id: string; stored: string[] }> {
    const body = (input ?? {}) as Record<string, unknown>;
    const connectorId = assertSlug(String(body.connector_id ?? body.connectorId ?? ""), "connector id");
    const stored: string[] = [];
    for (const field of SECRET_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];
      if (typeof value !== "string") throw new RpcError(-32602, `${field} must be a string`);
      if (value.length > 8192) throw new RpcError(-32602, `${field} is too long`);
      if (field === "token_url" && value && !isHttpUrl(value)) throw new RpcError(-32602, "token_url must be an http(s) URL without userinfo");
      const key = `${connectorId}.${field}`;
      if (!value) await this.secrets.delete(key);
      else await this.secrets.set(key, value);
      stored.push(field);
    }
    return { connector_id: connectorId, stored };
  }

  async oauthStatus(connectorId: string): Promise<{ connector_id: string; has_access_token: boolean; has_refresh_token: boolean; has_bearer_token: boolean; has_client_id: boolean }> {
    const id = assertSlug(connectorId, "connector id");
    const [access, refresh, bearer, client] = await Promise.all([
      this.secrets.get(`${id}.access_token`),
      this.secrets.get(`${id}.refresh_token`),
      this.secrets.get(`${id}.token`),
      this.secrets.get(`${id}.client_id`),
    ]);
    return {
      connector_id: id,
      has_access_token: Boolean(access),
      has_refresh_token: Boolean(refresh),
      has_bearer_token: Boolean(bearer),
      has_client_id: Boolean(client),
    };
  }

  /** User-initiated tool discovery. Not registered as an agent tool. */
  async listRemoteTools(connectorId: string): Promise<{ connector_id: string; tools: Array<{ name: string; description: string }> }> {
    const connector = await this.requireConnector(connectorId);
    try {
      const tools: Array<{ name: string; description: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await this.rpc(connector, "tools/list", cursor ? { cursor } : {});
        const batch = Array.isArray(result?.tools) ? result.tools : [];
        for (const tool of batch) {
          if (!tool || typeof tool.name !== "string") continue;
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) continue;
          tools.push({ name: tool.name, description: oneLine(String(tool.description ?? ""), 240) });
        }
        cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      await this.audit("user", connector.id, "tools_list", "ok", true);
      return { connector_id: connector.id, tools };
    } catch (err) {
      await this.audit("user", connector.id, "tools_list", "error", false, oneLine(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  private makeTool(sessionId: string, grant: string): AgentTool<any> {
    const [connectorId, toolName] = grant.split("/") as [string, string];
    return {
      name: `mcp__${connectorId}__${toolName}`,
      label: `${connectorId}/${toolName}`,
      description:
        `Call the user-authorized MCP tool ${connectorId}/${toolName} over HTTP. ` +
        "The call waits for an approval card and is audited. It cannot start a process or read arbitrary files.",
      parameters: Type.Object({
        arguments: Type.Optional(Type.String({ description: "JSON object of arguments for the remote tool." })),
      }, { additionalProperties: false }),
      execute: async (_toolCallId: string, raw: unknown): Promise<AgentToolResult<any>> => {
        const allowed = this.grants.get(sessionId);
        if (!allowed?.has(grant)) {
          await this.audit(sessionId, connectorId, toolName, "denied", false, "grant missing");
          return toolResult("这个 MCP 工具没有授权，调用已拒绝。", { blocked: true });
        }
        const connector = (await this.readConnectors()).find((item) => item.id === connectorId);
        if (!connector) {
          await this.audit(sessionId, connectorId, toolName, "denied", false, "connector missing");
          return toolResult(`连接器「${connectorId}」不存在，调用已拒绝。`, { blocked: true });
        }
        let args: Record<string, unknown> = {};
        const encoded = (raw as { arguments?: unknown })?.arguments;
        if (typeof encoded === "string" && encoded.trim()) {
          try {
            const parsed = JSON.parse(encoded) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return toolResult("arguments 必须是 JSON 对象。", { blocked: true });
            }
            args = parsed as Record<string, unknown>;
          } catch {
            return toolResult("arguments 不是合法的 JSON。", { blocked: true });
          }
        }
        if (JSON.stringify(args).length > 32_000) {
          return toolResult("参数过大，调用已拒绝。", { blocked: true });
        }
        const approved = await this.approval.request({
          sessionId,
          kind: "external",
          tool: `mcp/${grant}`,
          title: `调用 ${connector.label}`,
          summary: toolName,
          preview: { connector: connector.id, tool: toolName, arguments: args },
        });
        if (!approved) {
          await this.audit(sessionId, connectorId, toolName, "denied", false, "user denied");
          return toolResult("用户没有批准这次 MCP 调用。", { blocked: true });
        }
        try {
          const result = await this.rpc(connector, "tools/call", { name: toolName, arguments: args });
          const text = renderToolResult(result);
          const failed = Boolean(result && typeof result === "object" && (result as { isError?: boolean }).isError);
          await this.audit(sessionId, connectorId, toolName, failed ? "error" : "ok", !failed, failed ? oneLine(text) : undefined);
          return toolResult(text, { ok: !failed });
        } catch (err) {
          const message = oneLine(err instanceof Error ? err.message : String(err), 300) || "MCP 调用失败";
          await this.audit(sessionId, connectorId, toolName, "error", false, message);
          return toolResult(`MCP 调用失败：${message}`, { ok: false });
        }
      },
    };
  }

  private async requireConnector(id: string): Promise<McpConnector> {
    const connectorId = assertSlug(id, "connector id");
    const connector = (await this.readConnectors()).find((item) => item.id === connectorId);
    if (!connector) throw new RpcError(-32002, `unknown MCP connector: ${connectorId}`);
    return connector;
  }

  private async readGrantFile(configDir: string): Promise<string[]> {
    const path = grantPath(configDir);
    if (!path) return [];
    try {
      const result = await this.vault.request<{ content?: unknown }>("vault/read_file", { session_id: "mcp", path });
      return typeof result?.content === "string" ? parseGrantDocument(result.content) : [];
    } catch (err) {
      if (isRootNotSet(err)) return [];
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("not found") || (err as { code?: number }).code === -32002) return [];
      console.error("[sidecar] mcp.md read failed:", err);
      return [];
    }
  }

  private async readConnectors(): Promise<McpConnector[]> {
    try {
      const file = await readControlJson<ConnectorFile>(this.vault, "mcp", CONTROL_PATHS.mcpConnectors);
      return asConnectors(file);
    } catch (err) {
      if (isRootNotSet(err)) return [];
      throw err;
    }
  }

  private async writeConnectors(connectors: McpConnector[]): Promise<void> {
    await writeControlJson(this.vault, "mcp", CONTROL_PATHS.mcpConnectors, { version: 1, connectors });
  }

  private async headers(connector: McpConnector, refresh = true): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL,
    };
    if (connector.auth === "none") return headers;
    const field: SecretField = connector.auth === "bearer" ? "token" : "access_token";
    let token = await this.secrets.get(`${connector.id}.${field}`);
    if (!token && connector.auth === "oauth" && refresh) {
      if (await this.refresh(connector)) token = await this.secrets.get(`${connector.id}.access_token`);
    }
    if (!token) throw new Error(connector.auth === "bearer" ? "连接器未配置访问令牌" : "连接器未保存 OAuth 访问令牌");
    headers.authorization = `Bearer ${token}`;
    return headers;
  }

  private async refresh(connector: McpConnector): Promise<boolean> {
    const [refreshToken, tokenUrl, clientId, clientSecret] = await Promise.all([
      this.secrets.get(`${connector.id}.refresh_token`),
      this.secrets.get(`${connector.id}.token_url`),
      this.secrets.get(`${connector.id}.client_id`),
      this.secrets.get(`${connector.id}.client_secret`),
    ]);
    if (!refreshToken || !tokenUrl || !clientId || !isHttpUrl(tokenUrl)) return false;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await this.fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 200 || response.status >= 300) return false;
    let parsed: { access_token?: unknown; refresh_token?: unknown };
    try {
      parsed = JSON.parse(await response.text()) as { access_token?: unknown; refresh_token?: unknown };
    } catch {
      return false;
    }
    if (typeof parsed.access_token !== "string" || !parsed.access_token) return false;
    await this.secrets.set(`${connector.id}.access_token`, parsed.access_token);
    if (typeof parsed.refresh_token === "string" && parsed.refresh_token) {
      await this.secrets.set(`${connector.id}.refresh_token`, parsed.refresh_token);
    }
    return true;
  }

  private async rpc(connector: McpConnector, method: string, params: unknown, attempt = 0): Promise<any> {
    await this.ensureInitialized(connector);
    const id = this.nextId++;
    const headers = await this.headers(connector);
    const session = this.sessions.get(connector.id);
    if (session) headers["mcp-session-id"] = session;
    const response = await this.fetchImpl(connector.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession && /^[\w.-]{1,128}$/.test(nextSession)) this.sessions.set(connector.id, nextSession);
    if (response.status === 401 && connector.auth === "oauth" && attempt === 0 && await this.refresh(connector)) {
      this.initialized.delete(connector.id);
      return this.rpc(connector, method, params, 1);
    }
    const body = await response.text();
    const parsed = parseRpc(response.status, response.headers.get("content-type") ?? "", body, id);
    if (parsed && typeof parsed === "object" && "error" in parsed && (parsed as { error?: { message?: string } }).error) {
      throw new Error((parsed as { error?: { message?: string } }).error?.message || `MCP ${method} failed`);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`MCP HTTP ${response.status}`);
    return parsed && typeof parsed === "object" && "result" in parsed ? (parsed as { result: unknown }).result : parsed;
  }

  private async ensureInitialized(connector: McpConnector): Promise<void> {
    if (this.initialized.has(connector.id)) return;
    const id = this.nextId++;
    const headers = await this.headers(connector);
    const response = await this.fetchImpl(connector.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL,
          capabilities: {},
          clientInfo: { name: "depdek", version: "0.2.1" },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession && /^[\w.-]{1,128}$/.test(nextSession)) this.sessions.set(connector.id, nextSession);
    const body = await response.text();
    const parsed = parseRpc(response.status, response.headers.get("content-type") ?? "", body, id);
    if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
      throw new Error("MCP initialize failed");
    }
    this.initialized.add(connector.id);
    const notifyHeaders = await this.headers(connector, false);
    const session = this.sessions.get(connector.id);
    if (session) notifyHeaders["mcp-session-id"] = session;
    await this.fetchImpl(connector.url, {
      method: "POST",
      headers: notifyHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => undefined);
  }

  private async audit(sessionId: string, connectorId: string, tool: string, status: string, ok: boolean, detail?: string): Promise<void> {
    try {
      await this.vault.request("mcp/audit", {
        session_id: sessionId,
        connector_id: connectorId,
        tool,
        status,
        ok,
        detail,
      });
    } catch (err) {
      console.error("[sidecar] mcp audit failed:", err);
    }
  }
}

export function normalizeConnector(input: unknown): McpConnector {
  const body = (input ?? {}) as { id?: unknown; label?: unknown; url?: unknown; auth?: unknown };
  const id = assertSlug(String(body.id ?? ""), "connector id");
  const label = oneLine(String(body.label ?? id), 80);
  const url = String(body.url ?? "").trim();
  if (!label) throw new RpcError(-32602, "connector label is required");
  if (!isHttpUrl(url)) throw new RpcError(-32602, "connector url must be http(s) without userinfo");
  const auth = body.auth ?? "none";
  if (auth !== "none" && auth !== "bearer" && auth !== "oauth") throw new RpcError(-32602, "auth must be none, bearer or oauth");
  return { id, label, url, auth };
}

export function grantPath(configDir: string): string | undefined {
  const cleaned = configDir.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned.length > 180) return undefined;
  const parts = cleaned.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === "secrets" || !/^[A-Za-z0-9._-]+$/.test(part))) return undefined;
  return `${cleaned}/mcp.md`;
}

export function parseRpc(status: number, contentType: string, body: string, id: number): unknown {
  if (status === 202 || !body.trim()) return { result: null };
  if (contentType.includes("text/event-stream")) {
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    for (const line of events) {
      try {
        const parsed = JSON.parse(line) as { id?: number };
        if (parsed.id === id) return parsed;
      } catch {
        // Skip malformed SSE frames.
      }
    }
    return null;
  }
  return JSON.parse(body) as unknown;
}

function renderToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return oneLine(String(result ?? ""), 4000) || "(empty)";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return oneLine(JSON.stringify(result), 4000);
  const text = content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const clipped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
  return clipped || "(empty)";
}
