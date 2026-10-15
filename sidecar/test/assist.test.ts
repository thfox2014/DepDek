import { describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../src/approval.js";
import { effectiveGrants, parseGrantDocument } from "../src/grants.js";
import { McpRegistry, type McpFetch, type McpSecrets } from "../src/mcp.js";
import { RpcError } from "../src/rpc.js";
import { Scheduler, cronMatches, isCronExpr } from "../src/schedule.js";
import { TeamOrchestrator, policyAllows, type TeamRunResult, type TeamSessionHost, type TeamSessionInfo } from "../src/team.js";
import { createVaultTools, type VaultClient } from "../src/tools.js";

function memoryVault() {
  const files = new Map<string, string>();
  const audits: Array<Record<string, unknown>> = [];
  const vault: VaultClient = {
    request: async (method: string, params?: unknown) => {
      const body = (params ?? {}) as { path?: string; content?: string };
      if (method === "vault/read_file") {
        const content = files.get(String(body.path));
        if (content === undefined) throw new RpcError(-32002, "path not found");
        return { content };
      }
      if (method === "vault/write_file") {
        files.set(String(body.path), String(body.content ?? ""));
        return { size: String(body.content ?? "").length };
      }
      audits.push({ method, ...(params as Record<string, unknown>) });
      return {};
    },
  };
  return { files, audits, vault };
}

async function settle(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > 2000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("mcp grants and delegation policy", () => {
  it("treats only connector/tool lines as grants", () => {
    const grants = parseGrantDocument("# MCP\n\n说明文字不会执行\nnotes/search\n- notes/search\nnot a grant\n../escape\n");
    expect(grants).toEqual(["notes/search"]);
    expect(effectiveGrants(["notes/search", "notes/write"], ["notes/write", "other/run"])).toEqual(["notes/write"]);
    expect(effectiveGrants(null, ["notes/search"])).toEqual(["notes/search"]);
  });

  it("lets the more specific delegation rule win", () => {
    const policy = {
      version: 1 as const,
      mode: "allow" as const,
      rules: [
        { from: "*", to: "*", allow: false },
        { from: "doc-manager", to: "photo-manager", allow: true },
        { from: "doc-manager", to: "photo-manager", allow: false },
      ],
    };
    expect(policyAllows(policy, { id: "doc-manager", label: "文档" }, { id: "photo-manager", label: "照片" })).toBe(false);
    const allowSpecific = {
      ...policy,
      rules: [
        { from: "*", to: "*", allow: false },
        { from: "doc-manager", to: "photo-manager", allow: true },
      ],
    };
    expect(policyAllows(allowSpecific, { id: "doc-manager", label: "文档" }, { id: "photo-manager", label: "照片" })).toBe(true);
    expect(policyAllows(allowSpecific, { id: "doc-manager", label: "文档" }, { id: "music", label: "音乐" })).toBe(false);
    expect(policyAllows({ version: 1, mode: "deny", rules: [] }, { id: "a", label: "A" }, { id: "b", label: "B" })).toBe(false);
  });
});

describe("approval and drafts", () => {
  it("blocks a write until the user approves, and never sends mail before approval", async () => {
    const { vault, audits } = memoryVault();
    const gate = new ApprovalGate({ notify() {} }, vault, { timeoutMs: 30_000 });
    const client: VaultClient = { request: vi.fn(async () => ({ size: 1, sha256: "abc" })) };
    const write = createVaultTools(client, "sess-1", ["documents"], gate).find((tool) => tool.name === "write_file");
    const pendingWrite = write!.execute("tc", { path: "notes/a.md", content: "hi" });
    await settle(() => gate.list().cards.some((card) => card.tool === "write_file" && card.status === "pending"));
    expect(client.request).not.toHaveBeenCalled();
    const writeCard = gate.list().cards.find((card) => card.tool === "write_file")!;
    expect(JSON.stringify(writeCard.preview)).not.toMatch(/password|token/i);
    await gate.decide(writeCard.id, "deny");
    const denied = await pendingWrite;
    expect(denied.details).toMatchObject({ approval: "denied" });
    expect(client.request).not.toHaveBeenCalled();

    const sent: Array<Record<string, unknown>> = [];
    const sending = new ApprovalGate({ notify() {} }, vault, {
      timeoutMs: 30_000,
      send: async (_client, input) => {
        sent.push(input as unknown as Record<string, unknown>);
        return { account: input.account, message_id: "mid-1" };
      },
    });
    const draft = createVaultTools(vault, "sess-1", ["mail"], sending);
    expect(draft.some((tool) => tool.name === "draft_email")).toBe(false);
    const { createDraftEmailTool } = await import("../src/approval.js");
    const tool = createDraftEmailTool(sending, "sess-1");
    const pendingMail = tool.execute("tc", { account: "工作", to: "ada@example.com", subject: "周报", text: "三件事" });
    await settle(() => sending.list().cards.some((card) => card.kind === "email" && card.status === "pending"));
    expect(sent).toHaveLength(0);
    const card = sending.list().cards.find((item) => item.kind === "email")!;
    await sending.decide(card.id, "approve");
    const mailed = await pendingMail;
    expect(mailed.details).toMatchObject({ sent: true, message_id: "mid-1" });
    expect(sent).toHaveLength(1);
    await sending.decide(card.id, "approve");
    expect(sent).toHaveLength(1);
    expect(audits.some((entry) => entry.method === "approval/audit" && entry.decision === "approved")).toBe(true);
  });
});

describe("MCP client", () => {
  it("does not call the network without a grant and approval", async () => {
    const { vault, files, audits } = memoryVault();
    files.set("mcp/connectors.json", JSON.stringify({
      version: 1,
      connectors: [{ id: "notes", label: "笔记", url: "https://mcp.example/mcp", auth: "none" }],
    }));
    const calls: string[] = [];
    const fetchImpl: McpFetch = async (url, init) => {
      calls.push(`${url} ${init.body ?? ""}`);
      const message = JSON.parse(init.body || "{}") as { id?: number; method?: string };
      if (message.method === "initialize") {
        return { status: 200, headers: { get: () => "mcp-session" }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26" } }) };
      }
      if (message.method === "notifications/initialized") {
        return { status: 202, headers: { get: () => null }, text: async () => "" };
      }
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "found" }] } }),
      };
    };
    const secrets: McpSecrets = { get: async () => undefined, set: async () => undefined, delete: async () => undefined };
    const denied = new McpRegistry(vault, { request: async () => false }, secrets, fetchImpl);
    const [tool] = denied.toolsFor("sess-1", ["notes/search"]);
    denied.forget("sess-1");
    const blocked = await tool!.execute("tc", { arguments: "{\"q\":\"周报\"}" });
    expect(blocked.details).toMatchObject({ blocked: true });
    expect(calls).toHaveLength(0);

    const approved = new McpRegistry(vault, { request: async () => true }, secrets, fetchImpl);
    const [live] = approved.toolsFor("sess-1", ["notes/search"]);
    const result = await live!.execute("tc", { arguments: "{\"q\":\"周报\"}" });
    expect(result.content[0]?.text).toContain("found");
    expect(calls.some((call) => call.includes("tools/call"))).toBe(true);
    expect(calls.join("\n")).not.toMatch(/Bearer /);
    expect(audits.some((entry) => entry.method === "mcp/audit" && entry.status === "ok" && entry.tool === "search")).toBe(true);
    await expect(approved.putConnector({ id: "bad", label: "x", url: "file:///tmp/mcp", auth: "none" })).rejects.toThrow(/http/);
  });

  it("refreshes an oauth token once and does not return the token", async () => {
    const { vault, files } = memoryVault();
    files.set("mcp/connectors.json", JSON.stringify({
      version: 1,
      connectors: [{ id: "notes", label: "笔记", url: "https://mcp.example/mcp", auth: "oauth" }],
    }));
    const stored = new Map<string, string>([
      ["notes.access_token", "stale"],
      ["notes.refresh_token", "refresh-secret"],
      ["notes.token_url", "https://auth.example/token"],
      ["notes.client_id", "depdek"],
    ]);
    const secrets: McpSecrets = {
      get: async (key) => stored.get(key),
      set: async (key, value) => { stored.set(key, value); },
      delete: async (key) => { stored.delete(key); },
    };
    let calls = 0;
    const fetchImpl: McpFetch = async (url, init) => {
      if (url.includes("/token")) {
        expect(init.body).toContain("refresh-secret");
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ access_token: "access-secret" }) };
      }
      const message = JSON.parse(init.body || "{}") as { id?: number; method?: string };
      if (message.method === "initialize") {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) };
      }
      if (message.method === "notifications/initialized") {
        return { status: 202, headers: { get: () => null }, text: async () => "" };
      }
      calls += 1;
      if (calls === 1) return { status: 401, headers: { get: () => null }, text: async () => "" };
      expect(init.headers.authorization).toBe("Bearer access-secret");
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } }) };
    };
    const registry = new McpRegistry(vault, { request: async () => true }, secrets, fetchImpl);
    const [tool] = registry.toolsFor("sess-1", ["notes/search"]);
    const result = await tool!.execute("tc", {});
    expect(result.content[0]?.text).toContain("ok");
    const status = await registry.oauthStatus("notes");
    expect(status.has_access_token).toBe(true);
    expect(JSON.stringify(status)).not.toContain("access-secret");
    const storedNames = await registry.oauthStore({ connector_id: "notes", access_token: "" });
    expect(storedNames.stored).toEqual(["access_token"]);
    expect(stored.has("notes.access_token")).toBe(false);
  });
});

describe("scheduler", () => {
  it("matches cron fields and runs a routine only when the agent is online", async () => {
    expect(isCronExpr("0 8 * * 1-5")).toBe(true);
    expect(isCronExpr("* * *")).toBe(false);
    const morning = new Date(2026, 9, 14, 8, 0, 0);
    expect(morning.getDay()).toBe(3);
    expect(cronMatches("0 8 * * 1-5", morning)).toBe(true);
    expect(cronMatches("0 8 * * 1-5", new Date(2026, 9, 14, 9, 0, 0))).toBe(false);
    expect(cronMatches("*/15 * * * *", new Date(2026, 9, 14, 9, 30, 0))).toBe(true);
    expect(cronMatches("0 0 * * 0", new Date(2026, 9, 18, 0, 0, 0))).toBe(true);

    const { vault } = memoryVault();
    const runs: string[] = [];
    let online = false;
    const host: { has: (id: string) => boolean; isBusy: (id: string) => boolean; runTurn: (id: string, text: string) => Promise<TeamRunResult> } = {
      has: () => online,
      isBusy: () => false,
      runTurn: async (id, text) => {
        runs.push(`${id}:${text}`);
        return { text: "done", aborted: false };
      },
    };
    const scheduler = new Scheduler(host, { notify() {} }, vault);
    const saved = await scheduler.put({
      label: "早报",
      agent_id: "doc-manager",
      prompt: "总结今天",
      trigger: { type: "cron", expr: "0 8 * * 1-5" },
    });
    scheduler.tick(morning);
    await settle(() => scheduler.list().routines[0]?.last_status === "skipped");
    expect(runs).toHaveLength(0);
    online = true;
    scheduler.tick(new Date(2026, 9, 15, 8, 0, 0));
    await settle(() => runs.length === 1);
    expect(runs[0]).toContain("总结今天");
    await scheduler.put({
      id: saved.routine.id,
      label: "来信",
      agent_id: "doc-manager",
      prompt: "看新邮件",
      enabled: true,
      trigger: { type: "event", source: "mail", match: "work" },
    });
    scheduler.onEvent("mail", "personal");
    scheduler.onEvent("mail", "work");
    await settle(() => runs.length === 2);
    expect(scheduler.list().routines[0]?.last_status).toBe("ran");
  });
});

describe("team persistence", () => {
  it("restores a finished task and enforces a deny policy", async () => {
    const { vault, files } = memoryVault();
    const sessions = new Map<string, TeamSessionInfo>([
      ["doc-manager", { id: "doc-manager", label: "文档管家", engine: "pi" }],
      ["photo-manager", { id: "photo-manager", label: "照片管家", engine: "pi" }],
    ]);
    const host: TeamSessionHost = {
      has: (id) => sessions.has(id),
      isBusy: () => false,
      labelOf: (id) => sessions.get(id)?.label ?? id,
      setLabel: () => false,
      listSessions: () => [...sessions.values()],
      currentTurn: () => undefined,
      runTurn: async () => ({ text: "ok", aborted: false }),
      abortRun: () => undefined,
    };
    const first = new TeamOrchestrator(host, { notify() {} }, vault);
    await first.setPolicy({ version: 1, mode: "deny", rules: [{ from: "doc-manager", to: "photo-manager", allow: true }] });
    const accepted = first.delegate("doc-manager", "照片管家", "整理相册");
    expect(accepted.accepted).toBe(true);
    await settle(() => first.list().tasks[0]?.status === "done");
    await settle(() => (files.get("team/tasks.json") ?? "").includes("\"status\":\"done\""));
    const second = new TeamOrchestrator(host, { notify() {} }, vault);
    await settle(() => second.list().tasks.some((task) => task.status === "done" && task.instruction === "整理相册"));
    await second.setPolicy({ version: 1, mode: "deny", rules: [] });
    const blocked = second.delegate("doc-manager", "照片管家", "再看一次");
    expect(blocked.accepted).toBe(false);
  });
});
