import { describe, expect, it } from "vitest";
import { resolveProvider } from "../src/providers.js";

describe("bundled Jiaho setup model", () => {
  it("uses the real small-model context/output budget at the fixed local endpoint", () => {
    const { model } = resolveProvider({ kind: "openai-compatible", base_url: "http://127.0.0.1:11435/v1", model: "jiaho-setup" });
    expect(model.contextWindow).toBe(4096);
    expect(model.maxTokens).toBe(256);
  });
  it("does not apply a local model identity to a remote provider with the same name", () => {
    const { model } = resolveProvider({ kind: "openai-compatible", base_url: "https://provider.example/v1", model: "jiaho-setup" });
    expect(model.contextWindow).toBe(128_000);
  });
});
