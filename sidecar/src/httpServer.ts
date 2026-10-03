/**
 * HTTP face of the agent service.
 *
 * The desktop shell talks to the sidecar over stdio; browsers cannot. The
 * standalone sidecar therefore exposes this small API, and every read and
 * write goes through the same vault client the agent tools use — so settings
 * land as files inside the local data folder, never in browser storage.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { readSettings, writeSettings } from "./settingsFile.js";
import type { VaultClient } from "./tools.js";

const MAX_BODY = 2 * 1024 * 1024;

export interface AgentHttpService {
  port: number;
  close(): Promise<void>;
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, {
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end();
}

async function handle(client: VaultClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "OPTIONS") {
      sendNoContent(res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && pathname === "/v1/settings") {
      sendJson(res, 200, await readSettings(client));
      return;
    }
    if (req.method === "PUT" && pathname === "/v1/settings") {
      const raw = await readBody(req);
      await writeSettings(client, JSON.parse(raw || "{}"));
      sendNoContent(res);
      return;
    }
    sendJson(res, 404, { error: `no route for ${req.method ?? "GET"} ${pathname}` });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startAgentHttpServer(client: VaultClient, port: number): Promise<AgentHttpService> {
  const server = createServer((req, res) => {
    void handle(client, req, res);
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
