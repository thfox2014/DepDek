/**
 * Maps the contract ProviderConfig (section 2.1) to a pi-ai Model plus the
 * API key used for the session. Models are constructed directly so that
 * openai-compatible endpoints (Ollama etc.) can carry a custom base_url.
 */

import type { Model } from "@mariozechner/pi-ai";

export type ProviderConfig =
  | { kind: "openai"; api_key: string; model: string; base_url?: string }
  | { kind: "anthropic"; api_key: string; model: string }
  | { kind: "openai-compatible"; api_key?: string; model: string; base_url: string };

export interface ResolvedProvider {
  model: Model<any>;
  apiKey?: string;
}

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

function baseModel(): Omit<Model<any>, "api" | "provider" | "baseUrl" | "id" | "name"> {
  return {
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

export function resolveProvider(config: ProviderConfig): ResolvedProvider {
  switch (config.kind) {
    case "openai":
      return {
        model: {
          id: config.model,
          name: config.model,
          api: "openai-completions",
          provider: "openai",
          baseUrl: config.base_url ?? OPENAI_DEFAULT_BASE_URL,
          ...baseModel(),
        },
        apiKey: config.api_key,
      };
    case "anthropic":
      return {
        model: {
          id: config.model,
          name: config.model,
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: ANTHROPIC_DEFAULT_BASE_URL,
          ...baseModel(),
        },
        apiKey: config.api_key,
      };
    case "openai-compatible":
      // Covers Ollama and other local/OpenAI-compatible endpoints; api_key optional.
      return {
        model: {
          id: config.model,
          name: config.model,
          api: "openai-completions",
          provider: "openai-compatible",
          baseUrl: config.base_url,
          ...baseModel(),
        },
        apiKey: config.api_key,
      };
  }
}
