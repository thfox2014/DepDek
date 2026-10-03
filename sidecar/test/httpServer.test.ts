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
    // The stored value survives as its `$secret:` reference (redacted round-trips
    // preserve it) and the model field still updated.
    expect(saved.providers.DeepSeek.api_key).toBe("$secret:providers.DeepSeek.api_key");
    expect(saved.providers.DeepSeek.model).toBe("deepseek-v3");
    // The ciphertext blob holds the encrypted secret, never the plaintext.
    const blob = await new LocalVault(dir).request<{ content: string }>("vault/read_file", {
      session_id: "settings",
      path: "secrets/providers.enc.json",
    });
    expect(blob.content).not.toContain("sk-real");
  });

  it("accepts a fresh api_key on PUT, encrypts it and stores a $secret reference", async () => {
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
    expect(saved.providers.New.api_key).toBe("$secret:providers.New.api_key");
    // Plaintext never lands in settings.json or the blob file.
    expect(read.content).not.toContain("sk-new");
    const blob = await new LocalVault(dir).request<{ content: string }>("vault/read_file", {
      session_id: "settings",
      path: "secrets/providers.enc.json",
    });
    expect(blob.content).not.toContain("sk-new");
  });

  it("round-trips conversation history over GET/PUT /v1/vault", async () => {
    const write = await fetch(`http://127.0.0.1:${service.port}/v1/vault/write`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-depdek-token": TOKEN, origin: ORIGIN },
      body: JSON.stringify({
        path: "agent/tanvis/conversations.json",
        content: JSON.stringify([{ id: "c1", title: "t", createdAt: 1, blocks: [] }]),
      }),
    });
    expect(write.status).toBe(200);
    const body = (await write.json()) as { size: number };
    expect(body.size).toBeGreaterThan(0);

    const readFile = await new LocalVault(dir).request<{ content: string }>("vault/read_file", {
      session_id: "user",
      path: "agent/tanvis/conversations.json",
    });
    const parsed = JSON.parse(readFile.content) as { id: string }[];
    expect(parsed[0].id).toBe("c1");

    const res = await fetch(
      `http://127.0.0.1:${service.port}/v1/vault/read?path=${encodeURIComponent("agent/tanvis/conversations.json")}`,
      { headers: { "x-depdek-token": TOKEN, origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).content).toContain("\"c1\"");
  });

  it("rejects vault paths outside agent/<id>/conversations.json", async () => {
    for (const path of ["settings/settings.json", "agent/tanvis/notes.md", "../escape", "secrets/master.key"]) {
      const res = await fetch(
        `http://127.0.0.1:${service.port}/v1/vault/read?path=${encodeURIComponent(path)}`,
        { headers: { "x-depdek-token": TOKEN, origin: ORIGIN } },
      );
      expect(res.status).toBe(400);
    }
    const missing = await fetch(
      `http://127.0.0.1:${service.port}/v1/vault/read?path=${encodeURIComponent("agent/nobody/conversations.json")}`,
      { headers: { "x-depdek-token": TOKEN, origin: ORIGIN } },
    );
    expect(missing.status).toBe(404);
  });

  it("requires the token for vault routes too", async () => {
    const res = await fetch(
      `http://127.0.0.1:${service.port}/v1/vault/read?path=${encodeURIComponent("agent/tanvis/conversations.json")}`,
    );
    expect(res.status).toBe(401);
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