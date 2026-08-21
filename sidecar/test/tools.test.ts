import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../src/rpc.js";
import { createVaultTools, type VaultClient } from "../src/tools.js";

function mockClient(result: unknown): VaultClient & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(async () => result) } as any;
}

function toolByName(client: VaultClient, name: string) {
  const tool = createVaultTools(client, "sess-1").find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe("vault tools", () => {
  it("creates the vault tools without fs/bash access", () => {
    const tools = createVaultTools(mockClient({}), "sess-1");
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["compress", "delete_file", "fetch_mail", "list_files", "propose_memory", "read_file", "search_files", "write_file"].sort(),
    );
  });

  it("tells the agent about the sandbox in every vault tool description", () => {
    for (const tool of createVaultTools(mockClient({}), "sess-1")) {
      if (tool.name === "fetch_mail") continue;
      expect(tool.description).toContain("data folder");
      expect(tool.description).toContain("relative path");
    }
  });

  it("fetch_mail describes the mail/accounts.json configuration format", () => {
    const tool = toolByName(mockClient({}), "fetch_mail");
    expect(tool.description).toContain("mail/accounts.json");
    expect(tool.description).toContain("imap.qq.com");
  });

  it("fetch_mail surfaces the not-configured error", async () => {
    const client: VaultClient = {
      request: vi.fn(async () => {
        throw new RpcError(-32002, "path not found");
      }),
    };
    await expect(toolByName(client, "fetch_mail").execute("tc1", {})).rejects.toThrow(
      "no mail accounts configured",
    );
  });

  it("read_file forwards vault/read_file with session_id and path", async () => {
    const client = mockClient({ content: "hello", size: 5, sha256: "abc" });
    const result = await toolByName(client, "read_file").execute("tc1", { path: "notes/a.txt" });
    expect(client.request).toHaveBeenCalledWith("vault/read_file", {
      session_id: "sess-1",
      path: "notes/a.txt",
    });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("blocks the internal task history from agent context", async () => {
    const client = mockClient({ content: "must not be read" });
    const result = await toolByName(client, "read_file").execute("tc1", { path: "./tasks/history.json" });
    expect(client.request).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("tasks/history.json");
    expect(result.content[0].text).toContain("excluded from AI context");
  });

  it("filters the internal task history from search results", async () => {
    const client = mockClient({ matches: [
      { path: "tasks/history.json", line: 1, snippet: "internal" },
      { path: "notes/a.txt", line: 2, snippet: "safe" },
    ] });
    const result = await toolByName(client, "search_files").execute("tc1", { query: "safe" });
    expect(result.content[0].text).toBe("notes/a.txt:2: safe");
  });

  it("hides the internal task history from directory listings", async () => {
    const client = mockClient({ entries: [
      { name: "queue.json", kind: "file", size: 12 },
      { name: "history.json", kind: "file", size: 999 },
    ] });
    const result = await toolByName(client, "list_files").execute("tc1", { path: "tasks" });
    expect(result.content[0].text).toContain("queue.json");
    expect(result.content[0].text).not.toContain("history.json");
  });

  it("write_file forwards content and reports size/sha256", async () => {
    const client = mockClient({ size: 3, sha256: "deadbeef" });
    const result = await toolByName(client, "write_file").execute("tc1", {
      path: "a.txt",
      content: "foo",
    });
    expect(client.request).toHaveBeenCalledWith("vault/write_file", {
      session_id: "sess-1",
      path: "a.txt",
      content: "foo",
    });
    expect(result.content[0].text).toContain("3 bytes");
    expect(result.content[0].text).toContain("deadbeef");
  });

  it("list_files maps to vault/list_dir and formats entries", async () => {
    const client = mockClient({
      entries: [
        { name: "sub", kind: "dir", size: 0 },
        { name: "a.txt", kind: "file", size: 12 },
      ],
    });
    const result = await toolByName(client, "list_files").execute("tc1", { path: "." });
    expect(client.request).toHaveBeenCalledWith("vault/list_dir", {
      session_id: "sess-1",
      path: ".",
    });
    expect(result.content[0].text).toContain("a.txt");
    expect(result.content[0].text).toContain("sub");
  });

  it("search_files maps to vault/search_files with the query", async () => {
    const client = mockClient({ matches: [{ path: "a.txt", line: 2, snippet: "hit" }] });
    const result = await toolByName(client, "search_files").execute("tc1", { query: "hit" });
    expect(client.request).toHaveBeenCalledWith("vault/search_files", {
      session_id: "sess-1",
      query: "hit",
    });
    expect(result.content[0].text).toBe("a.txt:2: hit");
  });

  it("delete_file maps to vault/delete_file", async () => {
    const client = mockClient({});
    const result = await toolByName(client, "delete_file").execute("tc1", { path: "a.txt" });
    expect(client.request).toHaveBeenCalledWith("vault/delete_file", {
      session_id: "sess-1",
      path: "a.txt",
    });
    expect(result.content[0].text).toBe("Deleted.");
  });

  it("compress maps to vault/compress and reports the archive", async () => {
    const client = mockClient({
      source: "docs",
      archive: "docs.tar.gz",
      files: 3,
      bytes: 42,
      archive_size: 18,
    });
    const result = await toolByName(client, "compress").execute("tc1", {
      path: "docs",
      archive_path: "archives/docs.tar.gz",
    });
    expect(client.request).toHaveBeenCalledWith("vault/compress", {
      session_id: "sess-1",
      path: "docs",
      archive_path: "archives/docs.tar.gz",
    });
    expect(result.content[0].text).toContain("docs.tar.gz");
    expect(result.content[0].text).toContain("3 file(s)");
  });

  it("propose_memory writes a source-backed candidate through memory RPC", async () => {
    const client = mockClient({ id: "mem-1" });
    const result = await toolByName(client, "propose_memory").execute("tc1", {
      text: "先给建议再执行",
      kind: "procedure",
      scope: "team",
      source_refs: ["settings/policy.json"],
      confidence: 0.9,
    });
    expect(client.request).toHaveBeenCalledWith("memory/propose", {
      session_id: "sess-1",
      text: "先给建议再执行",
      kind: "procedure",
      scope: "team",
      source_refs: ["settings/policy.json"],
      confidence: 0.9,
      sensitivity: "private",
      engine: "pi",
    });
    expect(result.content[0].text).toContain("mem-1");
  });

  it("propagates vault RPC errors to the caller", async () => {
    const client: VaultClient = {
      request: async () => {
        throw new Error("E32001 path escapes root");
      },
    };
    await expect(toolByName(client, "read_file").execute("tc1", { path: "../x" })).rejects.toThrow(
      "E32001",
    );
  });
});
