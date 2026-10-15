/** Actual SDK loops over a fixed, keyless Rust client. Not the legacy session API. */
import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  type ResolvedRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type Engine = "pi" | "deepseek-harness";
export interface EngineInput {
  workspace_id: string;
  lease_token: string;
  run_id: string;
  call_id: string;
  engine: Engine;
  provider_id: string;
  model: string;
  max_tokens: number;
  prompt: string;
}
export interface EngineContext {
  engine: Engine;
  provider_id: string;
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
}
export interface ModelCall {
  workspace_id: string;
  lease_token: string;
  run_id: string;
  call_id: string;
  context: EngineContext;
}
export interface ModelResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  provider_id: string;
  model: string;
  profile_revision: number;
  reported_model?: string | null;
  source: string;
  engine: null;
}
export type Gateway = (
  call: ModelCall,
  signal?: AbortSignal,
) => Promise<ModelResult>;
export interface RuntimeFacts {
  engine: Engine;
  package: string;
  version: string;
  mode: "sdk-agent-loop";
  tools: [];
  key_received: false;
  gateway: "core-worker-rpc";
}
export interface EngineEvent {
  type: "progress";
  phase: string;
}
const SAFE_ERRORS = new Set([
  "INVALID_INPUT",
  "INVALID_CONFIG",
  "INPUT_LIMIT",
  "INVALID_FRAME",
  "INPUT_DEADLINE",
  "RUNTIME_UNSUPPORTED",
  "GATEWAY_LIMIT",
  "GATEWAY_DEADLINE",
  "GATEWAY_UNAVAILABLE",
  "GATEWAY_INVALID",
  "GATEWAY_REJECTED",
  "ABORTED",
  "RUN_STOPPED",
  "RUN_FAILED",
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "POLICY_CHANGED",
  "CAPABILITY_UNAVAILABLE",
  "AUDIT_UNAVAILABLE",
  "SECRET_STORE_LOCKED",
  "SECRET_STORE_NOT_INITIALIZED",
  "SECRET_STORE_UNAVAILABLE",
  "MODEL_OUTCOME_UNKNOWN",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_REQUEST_REJECTED",
  "PROVIDER_QUOTA_LIMITED",
  "PROVIDER_UNAVAILABLE",
]);
export function safeEngineError(error: unknown): string {
  return error instanceof Error && SAFE_ERRORS.has(error.message)
    ? error.message
    : "ENGINE_RUN_FAILED";
}

function exactObject(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function parseEngineInput(value: unknown): EngineInput {
  if (
    !exactObject(value, [
      "workspace_id",
      "lease_token",
      "run_id",
      "call_id",
      "engine",
      "provider_id",
      "model",
      "max_tokens",
      "prompt",
    ])
  )
    throw new Error("INVALID_INPUT");
  const string = (name: string, pattern: RegExp, max: number) =>
    typeof value[name] === "string" &&
    Buffer.byteLength(value[name]) <= max &&
    pattern.test(value[name]);
  if (
    !string("workspace_id", /^[A-Za-z0-9_.:-]+$/, 128) ||
    !string("call_id", /^[A-Za-z0-9_.:-]+$/, 128) ||
    !string("lease_token", /^ml_[a-f0-9]{64}$/, 67) ||
    !string("run_id", /^run_[a-f0-9]{64}$/, 68) ||
    !string("provider_id", /^[a-z][a-z0-9-]*$/, 48) ||
    !string("model", /^[A-Za-z0-9._:/-]+$/, 128) ||
    !["pi", "deepseek-harness"].includes(String(value.engine)) ||
    !Number.isInteger(value.max_tokens) ||
    Number(value.max_tokens) < 1 ||
    Number(value.max_tokens) > 1024 ||
    typeof value.prompt !== "string" ||
    !value.prompt ||
    Buffer.byteLength(value.prompt) > 16 * 1024
  )
    throw new Error("INVALID_INPUT");
  return value as unknown as EngineInput;
}
function runtimeFacts(engine: Engine): RuntimeFacts {
  const name =
    engine === "pi"
      ? "@mariozechner/pi-agent-core"
      : "@deepseek-ai/dsh-agent-loop";
  const expected = engine === "pi" ? "0.73.1" : "0.1.0-rc.6";
  const require = createRequire(import.meta.url);
  // Only fixed code-package metadata, never arbitrary input paths or Home.
  const metadata: { name?: string; version?: string } = JSON.parse(
    readFileSync(
      join(dirname(require.resolve(name)), "../package.json"),
      "utf8",
    ),
  );
  if (metadata.name !== name || metadata.version !== expected)
    throw new Error("RUNTIME_UNSUPPORTED");
  return {
    engine,
    package: name,
    version: metadata.version,
    mode: "sdk-agent-loop",
    tools: [],
    key_received: false,
    gateway: "core-worker-rpc",
  };
}
function validateResult(value: unknown, input: EngineInput): ModelResult {
  const keys = [
    "text",
    "usage",
    "provider_id",
    "model",
    "profile_revision",
    "source",
    "engine",
  ];
  if (
    !exactObject(value, keys) &&
    !exactObject(value, [...keys, "reported_model"])
  )
    throw new Error("GATEWAY_INVALID");
  if (
    value.reported_model !== undefined &&
    value.reported_model !== null &&
    (typeof value.reported_model !== "string" ||
      value.reported_model.length > 128 ||
      !/^[A-Za-z0-9._:/-]+$/.test(value.reported_model))
  )
    throw new Error("GATEWAY_INVALID");
  if (
    typeof value.text !== "string" ||
    Buffer.byteLength(value.text) > 16 * 1024 ||
    value.provider_id !== input.provider_id ||
    value.model !== input.model ||
    !Number.isSafeInteger(value.profile_revision) ||
    Number(value.profile_revision) < 1 ||
    !["local-provider", "cloud-provider"].includes(String(value.source)) ||
    value.engine !== null
  )
    throw new Error("GATEWAY_INVALID");
  if (
    value.usage !== null &&
    (!exactObject(value.usage, ["input_tokens", "output_tokens"]) ||
      !Number.isSafeInteger(value.usage.input_tokens) ||
      Number(value.usage.input_tokens) < 0 ||
      Number(value.usage.input_tokens) > 1_000_000 ||
      !Number.isSafeInteger(value.usage.output_tokens) ||
      Number(value.usage.output_tokens) < 0 ||
      Number(value.usage.output_tokens) > input.max_tokens)
  )
    throw new Error("GATEWAY_INVALID");
  return value as unknown as ModelResult;
}
export function fixedGateway(options: {
  command: string;
  socket: string;
  serverUid: number;
}): Gateway {
  if (
    !isAbsolute(options.command) ||
    !isAbsolute(options.socket) ||
    !Number.isSafeInteger(options.serverUid) ||
    options.serverUid < 1
  )
    throw new Error("INVALID_CONFIG");
  return (call, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("ABORTED"));
        return;
      }
      const child = spawn(
        options.command,
        [
          "--socket",
          options.socket,
          "--server-uid",
          String(options.serverUid),
          "--model",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { LANG: "C.UTF-8" },
        },
      );
      const chunks: Buffer[] = [];
      let bytes = 0,
        settled = false;
      const finish = (error?: string, data?: ModelResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        for (const chunk of chunks) chunk.fill(0);
        if (error) {
          child.kill("SIGTERM");
          reject(new Error(error));
        } else resolve(data!);
      };
      const abort = () => finish("ABORTED");
      const timer = setTimeout(() => finish("GATEWAY_DEADLINE"), 47_000);
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => finish("GATEWAY_UNAVAILABLE"));
      child.stdin.on("error", () => finish("GATEWAY_UNAVAILABLE"));
      // Drain but do not forward raw child diagnostics or secrets.
      child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) {
          chunk.fill(0);
          return;
        }
        bytes += chunk.length;
        if (bytes > 128 * 1024) {
          chunk.fill(0);
          finish("GATEWAY_LIMIT");
          return;
        }
        chunks.push(chunk);
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish("GATEWAY_UNAVAILABLE");
          return;
        }
        const raw = Buffer.concat(chunks);
        try {
          const reply: unknown = JSON.parse(raw.toString("utf8"));
          if (!reply || typeof reply !== "object") {
            finish("GATEWAY_REJECTED");
            return;
          }
          if (!("result" in reply)) {
            const code = (
              reply as { error?: { data?: { error?: { code?: unknown } } } }
            ).error?.data?.error?.code;
            finish(
              typeof code === "string" && SAFE_ERRORS.has(code)
                ? code
                : "GATEWAY_REJECTED",
            );
            return;
          }
          const envelope = reply as {
            result?: { data?: { status?: string; result?: ModelResult } };
          };
          if (envelope.result?.data?.status !== "completed") {
            finish("GATEWAY_REJECTED");
            return;
          }
          finish(undefined, envelope.result.data.result);
        } catch {
          finish("GATEWAY_INVALID");
        } finally {
          raw.fill(0);
        }
      });
      const payload = Buffer.from(JSON.stringify(call) + "\n");
      child.stdin.end(payload, () => payload.fill(0));
    });
}

/** A complete SDK loop, with the same one-call core boundary for both engines. */
export async function runR1Engine(
  raw: unknown,
  gateway: Gateway,
  notify: (event: EngineEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<{ runtime: RuntimeFacts; result: ModelResult }> {
  const input = parseEngineInput(raw),
    runtime = runtimeFacts(input.engine);
  let calls = 0,
    received: ModelResult | undefined,
    failureCode: string | undefined;
  const invoke = async (
    system: string,
    messages: { role: "user"; content: string }[],
    model: string,
    provider: string,
    maxTokens: number,
  ) => {
    if (++calls !== 1 || signal?.aborted) throw new Error("RUN_STOPPED");
    const context: EngineContext = {
      engine: input.engine,
      provider_id: provider,
      model,
      max_tokens: maxTokens,
      system,
      messages,
    };
    notify({ type: "progress", phase: "model_request" });
    try {
      const value = await gateway(
        {
          workspace_id: input.workspace_id,
          lease_token: input.lease_token,
          run_id: input.run_id,
          call_id: input.call_id,
          context,
        },
        signal,
      );
      received = validateResult(value, input);
      return received;
    } catch (error) {
      failureCode = safeEngineError(error);
      throw new Error(failureCode);
    }
  };
  notify({ type: "progress", phase: "engine_started" });
  if (input.engine === "pi") {
    const model: Model<"openai-completions"> = {
      id: input.model,
      name: input.model,
      api: "openai-completions",
      provider: input.provider_id,
      baseUrl: "http://127.0.0.1:0",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16 * 1024,
      maxTokens: input.max_tokens,
    };
    const streamFn: StreamFn = (actualModel, context) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const partial: AssistantMessage = {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: input.provider_id,
          model: input.model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        try {
          if (
            context.tools?.length ||
            context.messages.length !== 1 ||
            context.messages[0]?.role !== "user"
          )
            throw new Error("CONTEXT_UNSUPPORTED");
          const blocks = context.messages[0].content;
          const text =
            typeof blocks === "string"
              ? blocks
              : blocks.length === 1 && blocks[0]?.type === "text"
                ? blocks[0].text
                : undefined;
          if (text === undefined) throw new Error("CONTEXT_UNSUPPORTED");
          const result = await invoke(
            context.systemPrompt ?? "",
            [{ role: "user", content: text }],
            actualModel.id,
            actualModel.provider,
            input.max_tokens,
          );
          partial.content = [{ type: "text", text: result.text }];
          // SDK requires numeric fields; these are NOT reported as observed usage/cost.
          stream.push({ type: "start", partial });
          stream.push({ type: "done", reason: "stop", message: partial });
        } catch {
          partial.stopReason = "error";
          partial.errorMessage = "受控模型调用失败";
          stream.push({ type: "error", reason: "error", error: partial });
        }
      })();
      return stream;
    };
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [] },
      getApiKey: () => undefined,
      streamFn,
    });
    const off = agent.subscribe((event) => {
      if (event.type === "agent_start" || event.type === "agent_end")
        notify({ type: "progress", phase: event.type });
    });
    const abort = () => agent.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await agent.prompt(input.prompt);
      if (agent.state.errorMessage)
        throw new Error(failureCode ?? "RUN_FAILED");
    } finally {
      signal?.removeEventListener("abort", abort);
      off();
      agent.abort();
      agent.reset();
    }
  } else {
    const ctx = new Context();
    // No console exporter, settings, filesystem/persistence/default provider or tools.
    try {
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(SessionStore);
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        persona: "",
      });
      await ctx.plugin(Tools, { mode: "native" });
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
      class Adapter extends LlmAdapter {
        providerInfo(provider: string) {
          return { id: provider, name: "DepDek controlled gateway" };
        }
        providerRetryPolicy(): ResolvedRetryPolicy {
          return {
            mode: "normal",
            maxRetries: 0,
            retryableCodes: [],
            initialDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
          };
        }
        async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          if (
            options.tools?.length ||
            options.messages.length !== 1 ||
            options.messages[0]?.role !== "user" ||
            options.messages[0].content.length !== 1 ||
            options.messages[0].content[0]?.type !== "text" ||
            options.maxTokens === undefined
          )
            throw new Error("CONTEXT_UNSUPPORTED");
          const result = await invoke(
            options.system ?? "",
            [{ role: "user", content: options.messages[0].content[0].text }],
            options.model,
            options.provider,
            options.maxTokens,
          );
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: result.text };
          yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text: result.text },
          };
          // Core prompt counts do not describe disjoint cache accounting.
          // Keep core usage as the observable result, not fabricated SDK stats.
          yield { type: "finish", reason: { kind: "stop" } };
        }
      }
      const unregister = ctx.llm.registerAdapter(
        [input.provider_id],
        new Adapter(),
      );
      ctx.on("session/event", (_session, event) => {
        if (["turn/start", "step/start", "turn/end"].includes(event.type))
          notify({ type: "progress", phase: event.type });
      });
      const handle = await ctx.agents.create({
        sessionId: SessionId(input.run_id),
        agentOptions: {
          provider: input.provider_id,
          model: input.model,
          maxTokens: input.max_tokens,
        },
      });
      const abort = () => handle.agent.cancel({ kind: "user" });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        handle.agent.followup(
          createUserMessage({
            content: [{ type: "text", text: input.prompt }],
            source: { kind: "user" },
          }),
        );
        await handle.agent.whenIdle();
      } finally {
        signal?.removeEventListener("abort", abort);
        await handle.dispose();
        unregister();
      }
    } finally {
      await ctx.fiber.dispose();
      ctx.logger.buffer.length = 0;
    }
  }
  if (!received || calls !== 1 || signal?.aborted)
    throw new Error(failureCode ?? "RUN_FAILED");
  notify({ type: "progress", phase: "engine_completed" });
  return { runtime, result: received };
}
