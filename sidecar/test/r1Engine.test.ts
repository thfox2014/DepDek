import { describe, expect, it, vi } from "vitest";
import {
  parseEngineInput,
  runR1Engine,
  safeEngineError,
  type Engine,
  type EngineInput,
  type ModelCall,
} from "../src/r1Engine.js";

function input(engine: Engine): EngineInput {
  return {
    workspace_id: "w1",
    lease_token: "ml_" + "a".repeat(64),
    run_id: "run_" + "b".repeat(64),
    call_id: "one",
    engine,
    provider_id: "local-test",
    model: "synthetic-model",
    max_tokens: 128,
    prompt: "仅分析合成空调维修材料",
  };
}
it("preserves only classified provider failures, never a vendor body or secret", () => {
  for (const code of [
    "PROVIDER_AUTH_FAILED",
    "PROVIDER_REQUEST_REJECTED",
    "PROVIDER_QUOTA_LIMITED",
    "PROVIDER_UNAVAILABLE",
  ])
    expect(safeEngineError(new Error(code))).toBe(code);
  expect(safeEngineError(new Error("401 reflected-private-key"))).toBe(
    "ENGINE_RUN_FAILED",
  );
});
const result = {
  text: "已核对：forms@support.example.invalid",
  usage: { input_tokens: 12, output_tokens: 8 },
  provider_id: "local-test",
  model: "synthetic-model",
  profile_revision: 1,
  source: "local-provider",
  engine: null,
};
describe("R1 actual SDK engines", () => {
  for (const engine of ["pi", "deepseek-harness"] as const) {
    it(`${engine} accepts bounded cloud metadata from the same gateway without acquiring a Key`, async () => {
      const answer = await runR1Engine(input(engine), async () => ({
        ...result,
        source: "cloud-provider",
      }));
      expect(answer.result.source).toBe("cloud-provider");
      expect(answer.runtime.key_received).toBe(false);
    });
    it(`${engine} executes actual loop with exact single-user context and no Key/tools`, async () => {
      const gateway = vi.fn(async () => result),
        events: { type: string; phase: string }[] = [];
      const answer = await runR1Engine(input(engine), gateway, (event) =>
        events.push(event),
      );
      expect(answer.result).toEqual(result);
      expect(answer.runtime.engine).toBe(engine);
      expect(answer.runtime.version).toBe(
        engine === "pi" ? "0.73.1" : "0.1.0-rc.6",
      );
      expect(answer.runtime.key_received).toBe(false);
      expect(answer.runtime.tools).toEqual([]);
      expect(gateway).toHaveBeenCalledTimes(1);
      const call = gateway.mock.calls[0]?.[0] as unknown as ModelCall;
      expect(call.context).toEqual({
        engine,
        provider_id: "local-test",
        model: "synthetic-model",
        max_tokens: 128,
        system: "",
        messages: [{ role: "user", content: "仅分析合成空调维修材料" }],
      });
      expect(events.some((e) => e.phase === "model_request")).toBe(true);
      expect(events.at(-1)?.phase).toBe("engine_completed");
      const observable = JSON.stringify({ answer, events });
      expect(observable).not.toContain(input(engine).lease_token);
      expect(observable).not.toContain(input(engine).prompt);
    });
    it(`${engine} keeps missing usage unknown and contains rejected requests without retry`, async () => {
      const unknown = await runR1Engine(input(engine), async () => ({
        ...result,
        usage: null,
      }));
      expect(unknown.result.usage).toBeNull();
      const gateway = vi.fn(async () => {
        throw new Error("SYNTHETIC_DIAGNOSTIC_MUST_NOT_ESCAPE");
      });
      await expect(runR1Engine(input(engine), gateway)).rejects.not.toThrow(
        "SYNTHETIC_DIAGNOSTIC_MUST_NOT_ESCAPE",
      );
      expect(gateway).toHaveBeenCalledTimes(1);
    });
    it(`${engine} observes an already-aborted run without contacting the gateway`, async () => {
      const controller = new AbortController();
      controller.abort();
      const gateway = vi.fn(async () => result);
      await expect(
        runR1Engine(input(engine), gateway, () => {}, controller.signal),
      ).rejects.toThrow();
      expect(gateway).not.toHaveBeenCalled();
    });
  }
  it("closed input cannot carry keys/history/tools/endpoints or unknown engine", () => {
    for (const patch of [
      { api_key: "sensitive" },
      { history: [] },
      { tools: [] },
      { endpoint: "https://example.invalid" },
      { engine: "other" },
      { max_tokens: 2048 },
      { prompt: "x".repeat(16385) },
    ])
      expect(() => parseEngineInput({ ...input("pi"), ...patch })).toThrow(
        "INVALID_INPUT",
      );
  });
  it("only fixed error codes leave the runtime, never raw diagnostic values", () => {
    expect(safeEngineError(new Error("FORBIDDEN"))).toBe("FORBIDDEN");
    expect(safeEngineError(new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"))).toBe(
      "ENGINE_RUN_FAILED",
    );
    expect(safeEngineError("FORBIDDEN")).toBe("ENGINE_RUN_FAILED");
  });
});
