import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAgentHttpServer, type AgentHttpService } from "../src/httpServer.js";
import { LocalVault } from "../src/localVault.js";

const ORIGIN = "http://localhost:1420";
const TOKEN = "preview-token-0123456789abcdef";

describe("agent HTTP service", () => {
  let dir: string;
  let service: AgentHttpService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "depdek-http-"));
    service = await startAgentHttpServer(new LocalVault(dir), 0, {
      token: TOKEN,
      allowedOrigin: ORIGIN,
    });
  });

  afterEach(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSettings(payload: unknown): Promise<void> {
    await new LocalVault(dir).request("vault/write_file", {
      session_id: "settings",
      path: "settings/settings.json",
      content: JSON.stringify(payload),
    });
  }

  it("rejects settings reads without the preview token", async () => {
    const res = await fetch(`http://127.0.0.1:${service.port}/v1/settings`);
    expect(res.status).toBe(401);
  });

  it("redacts api_key when returning settings with the token", async () => {
    await writeSettings({
      providers: { DeepSeek: { kind: "openai", api_key: "sk-secret", model: "deepseek-chat" } },
      agents: [],
    });
    const res = await fetch(`http://127.0.0.1:${service.port}/v1/settings`, {
      headers: { "x-depdek-token": TOKEN, origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Record<string, { api_key: string }> };
    expect(body.providers.DeepSeek.api_key).toBe("********");
  });

  it("preserves the stored api_key when the client round-trips the redacted value", async () => {
    await writeSettings({
      providers: { DeepSeek: { kind: "openai", api_key: "sk-real", model: "deepseek-chat" } },
      agents: [],
    });
    const res = await fetch(`http://127.0.0.1:${service.port}/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-depdek-token": TOKEN, origin: ORIGIN },
      body: JSON.stringify({
        providers: { DeepSeek: { kind: "openai", api_key: "********", model: "deepseek-v3" } },
      }),
    });
    expect(res.status).toBe(204);
    const read = await new LocalVault(dir).request<{ content: string }>("vault/read_file", {
      session_id: "settings",
      path: "settings/settings.json",
    });
    const saved = JSON.parse(read.content) as {
      providers: Record<string, { api_key: string; model: string }>;
    };
    expect(saved.providers.DeepSeek.api_key).toBe("sk-real");
    expect(saved.providers.DeepSeek.model).toBe("deepseek-v3");
  });

  it("accepts a fresh api_key on PUT and stores it", async () => {
    await writeSettings({ providers: {}, agents: [] });
    const res = await fetch(`http://127.0.0.1:${service.port}/v1/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-depdek-token": TOKEN, origin: ORIGIN },
      body: JSON.stringify({
        providers: { New: { kind: "openai", api_key: "sk-new", model: "gpt-4o" } },
      }),
    });
    expect(res.status).toBe(204);
    const read = await new LocalVault(dir).request<{ content: string }>("vault/read_file", {
      session_id: "settings",
      path: "settings/settings.json",
    });
    const saved = JSON.parse(read.content) as { providers: Record<string, { api_key: string }> };
    expect(saved.providers.New.api_key).toBe("sk-new");
  });

  it("emits CORS headers only for the allowed origin", async () => {
    const ok = await fetch(`http://127.0.0.1:${service.port}/v1/health`, {
      headers: { origin: ORIGIN, "x-depdek-token": TOKEN },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const ng = await fetch(`http://127.0.0.1:${service.port}/v1/health`, {
      headers: { origin: "http://evil.example", "x-depdek-token": TOKEN },
    });
    expect(ng.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("agent sessions cannot reach credential files through the local vault", async () => {
    await writeSettings({
      providers: { DeepSeek: { kind: "openai", api_key: "sk-secret" } },
      agents: [],
    });
    const vault = new LocalVault(dir);
    await expect(
      vault.request("vault/read_file", { session_id: "agent-1", path: "settings/settings.json" }),
    ).rejects.toThrow(/denied/);
    // The trusted settings session (used by the HTTP service) still works.
    await expect(
      vault.request("vault/read_file", { session_id: "settings", path: "settings/settings.json" }),
    ).resolves.toBeDefined();
  });
});