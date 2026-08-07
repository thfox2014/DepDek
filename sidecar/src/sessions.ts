/**
 * Multi-session management on top of pi-agent-core.
 *
 * Each session owns an isolated Agent with the vault tools bound to its
 * session id. Streaming events are converted to contract agent/event
 * notifications and forwarded over the RPC channel. Sessions are fully
 * independent and may run in parallel.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { RpcError } from "./rpc.js";
import { createVaultTools, type VaultClient } from "./tools.js";
import { convertAgentEvent } from "./events.js";
import { resolveProvider, type ProviderConfig } from "./providers.js";

export const ERR_SESSION_EXISTS = -32010;
export const ERR_SESSION_NOT_FOUND = -32011;
export const ERR_SESSION_BUSY = -32012;

export const DEFAULT_SYSTEM_PROMPT =
  "You are a workbench agent. You read and write files in the user's data folder " +
  "exclusively through the provided tools. You must never access anything outside " +
  "the data folder.";

/** Outbound channel used to push agent/event notifications. */
export interface EventSink {
  notify(method: string, params?: unknown): void;
}

interface SessionEntry {
  agent: Agent;
  unsubscribe: () => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly vault: VaultClient,
    private readonly sink: EventSink,
  ) {}

  /** Create a session from a contract ProviderConfig. */
  createSession(sessionId: string, provider: ProviderConfig, systemPrompt?: string): { session_id: string } {
    const resolved = resolveProvider(provider);
    return this.createSessionWithModel(sessionId, resolved.model, {
      apiKey: resolved.apiKey,
      systemPrompt,
    });
  }

  /**
   * Create a session from an already-resolved pi-ai model.
   * Exposed separately so tests (and alternate provider sources) can inject
   * any model, e.g. a faux provider model.
   */
  createSessionWithModel(
    sessionId: string,
    model: Model<any>,
    options: { apiKey?: string; systemPrompt?: string } = {},
  ): { session_id: string } {
    if (this.sessions.has(sessionId)) {
      throw new RpcError(ERR_SESSION_EXISTS, `session already exists: ${sessionId}`);
    }
    const agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        model,
      },
      getApiKey: () => options.apiKey,
    });
    agent.state.tools = createVaultTools(this.vault, sessionId);
    const unsubscribe = agent.subscribe((event) => {
      for (const notification of convertAgentEvent(event)) {
        this.sink.notify("agent/event", {
          session_id: sessionId,
          type: notification.type,
          data: notification.data,
        });
      }
    });
    this.sessions.set(sessionId, { agent, unsubscribe });
    return { session_id: sessionId };
  }

  /** Start a run. The reply streams back through agent/event notifications. */
  send(sessionId: string, text: string): Record<string, never> {
    const entry = this.get(sessionId);
    if (entry.agent.state.isStreaming) {
      throw new RpcError(ERR_SESSION_BUSY, `session is busy: ${sessionId}`);
    }
    // Fire-and-forget: the run settles via events. Unexpected failures become
    // an error notification instead of crashing the sidecar.
    entry.agent.prompt(text).catch((err) => {
      this.sink.notify("agent/event", {
        session_id: sessionId,
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
    });
    return {};
  }

  /** Abort the session's current run, if any. */
  abort(sessionId: string): Record<string, never> {
    this.get(sessionId).agent.abort();
    return {};
  }

  /** Abort and remove a session. */
  closeSession(sessionId: string): Record<string, never> {
    const entry = this.get(sessionId);
    entry.agent.abort();
    entry.unsubscribe();
    this.sessions.delete(sessionId);
    return {};
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private get(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
    }
    return entry;
  }
}
