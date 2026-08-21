import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DeepSeekHarnessSession, type HarnessSpawn } from "../src/harness.js";

describe("DeepSeek Harness bridge", () => {
  it("runs a text-only headless turn and keeps a bounded session history", async () => {
    const seen: string[] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const progress: Array<{ phase: string; message: string }> = [];
    const fakeSpawn: HarnessSpawn = (options) => {
      seen.push(options.args.at(-1) ?? "");
      envs.push(options.env);
      return spawn(process.execPath, ["-e", "process.stdout.write('# 已完成\\n\\n这是 Harness 响应')"]) as ReturnType<typeof spawn>;
    };
    const session = new DeepSeekHarnessSession(
      { kind: "openai", api_key: "test-key", model: "deepseek-v4-flash" },
      "只返回 Markdown",
      { command: "fake-dsh", spawn: fakeSpawn, timeoutMs: 2_000, onProgress: (event) => progress.push(event) },
    );
    await expect(session.prompt("整理一下")) .resolves.toContain("Harness 响应");
    await expect(session.prompt("继续")) .resolves.toContain("Harness 响应");
    expect(seen[1]).toContain("Conversation context");
    expect(envs[0]?.DSH_PERMISSION_MODE).toBe("read-only");
    expect(envs[0]?.DSH_TELEMETRY_DISABLED).toBe("1");
    expect(seen[0]).toContain("Current user request");
    expect(progress.map((event) => event.phase)).toEqual(["started", "policy", "thinking", "generating", "complete", "started", "policy", "thinking", "generating", "complete"]);
    await session.dispose();
  });

  it("rejects unsupported Anthropic providers before spawning", async () => {
    const session = new DeepSeekHarnessSession({ kind: "anthropic", api_key: "x", model: "claude" }, undefined, {
      spawn: () => { throw new Error("must not spawn"); },
    });
    await expect(session.prompt("hello")).rejects.toThrow("只支持 DeepSeek/OpenAI 兼容 provider");
    await session.dispose();
  });

  it("does not route a local Ollama endpoint into dsh", async () => {
    const session = new DeepSeekHarnessSession({
      kind: "openai-compatible",
      api_key: "",
      model: "qwen3:8b",
      base_url: "http://127.0.0.1:11434/v1",
    }, undefined, { spawn: () => { throw new Error("must not spawn"); } });
    await expect(session.prompt("hello")).rejects.toThrow("不会调用本地 Ollama");
    await session.dispose();
  });

  it("returns an actionable install hint when dsh is not on the desktop PATH", async () => {
    const session = new DeepSeekHarnessSession(
      { kind: "openai", api_key: "test-key", model: "deepseek-v4-flash" },
      undefined,
      { command: "/definitely/missing/dsh", timeoutMs: 2_000 },
    );
    await expect(session.prompt("hello")).rejects.toThrow("未找到 dsh 可执行文件");
    await session.dispose();
  });

  it("adds a resolved dsh directory to PATH for its node shebang", async () => {
    let childEnv: NodeJS.ProcessEnv | undefined;
    const fakeSpawn: HarnessSpawn = (options) => {
      childEnv = options.env;
      return spawn(process.execPath, ["-e", "process.stdout.write('ok')"]) as ReturnType<typeof spawn>;
    };
    const session = new DeepSeekHarnessSession(
      { kind: "openai", api_key: "test-key", model: "deepseek-v4-flash" },
      undefined,
      { command: "/opt/depdek/bin/dsh", spawn: fakeSpawn, timeoutMs: 2_000 },
    );
    await expect(session.prompt("hello")).resolves.toBe("ok");
    expect(childEnv?.PATH?.split(":")[0]).toBe("/opt/depdek/bin");
    await session.dispose();
  });
});
