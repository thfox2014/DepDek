import { describe, expect, it, vi } from "vitest";
import { buildPersonalContext, isLocalProvider, withPersonalContext } from "../src/context.js";
import type { VaultClient } from "../src/tools.js";

describe("personal context snapshot", () => {
  it("only includes confirmed MyInfo and MyData entries for loopback providers", async () => {
    const files: Record<string, string> = {
      "myinfo/profile.json": JSON.stringify({ items: [
        { id: "confirmed", kind: "preference", value: "中文回答", status: "confirmed", source_refs: ["prefs.md"] },
        { id: "candidate", kind: "goal", value: "不要进入上下文", status: "candidate" },
      ] }),
      "mydata/long_term.jsonl": [
        JSON.stringify({ id: "m1", type: "fact", content: "晚上处理邮件", status: "confirmed", confidence: 0.9, source_refs: ["mail/a.md"] }),
        JSON.stringify({ id: "m2", type: "fact", content: "不应出现", status: "rejected" }),
      ].join("\n"),
    };
    const client: VaultClient = { request: vi.fn(async (_method, params: any) => ({ content: files[params.path] ?? "" })) };
    const context = await buildPersonalContext(client, "s1", { kind: "openai-compatible", model: "qwen", base_url: "http://127.0.0.1:11434/v1" });
    expect(context).toContain("中文回答");
    expect(context).toContain("晚上处理邮件");
    expect(context).not.toContain("不要进入上下文");
    expect(context).not.toContain("不应出现");
    expect(withPersonalContext("现在做什么？", context)).toContain("当前用户请求（优先级最高）");
  });

  it("does not include personal context for cloud providers", async () => {
    expect(isLocalProvider({ kind: "openai", api_key: "x", model: "deepseek" })).toBe(false);
    const client: VaultClient = { request: vi.fn() };
    expect(await buildPersonalContext(client, "s1", { kind: "openai", api_key: "x", model: "deepseek" })).toBe("");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("uses confirmed shared team memory through the memory RPC", async () => {
    const client: VaultClient = {
      request: vi.fn(async (method) => {
        if (method === "memory/query") {
          return {
            items: [
              { id: "m1", scope: "team", kind: "procedure", text: "先给建议再执行", status: "confirmed", confidence: 0.99, source_refs: ["mail/a.md"] },
              { id: "m2", scope: "team", kind: "fact", text: "候选不应进入上下文", status: "candidate" },
            ],
          };
        }
        throw new Error(`unexpected fallback call: ${method}`);
      }),
    };
    const context = await buildPersonalContext(client, "agent-tanvis", { kind: "openai-compatible", model: "qwen", base_url: "http://127.0.0.1:11434/v1" });
    expect(context).toContain("先给建议再执行");
    expect(context).not.toContain("候选不应进入上下文");
    expect(client.request).toHaveBeenCalledWith("memory/query", expect.objectContaining({ scopes: ["user", "team"], statuses: ["confirmed"] }));
  });
});
