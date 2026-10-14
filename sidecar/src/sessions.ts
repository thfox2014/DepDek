/**
 * Multi-session management on top of pi-agent-core.
 *
 * Each session owns an isolated Agent with the vault tools bound to its
 * session id. Streaming events are converted to contract agent/event
 * notifications and forwarded over the RPC channel. Sessions may run in
 * parallel. When a TeamOrchestrator is attached, a pi session can also
 * delegate or message another session; that work still uses only the
 * target session's own tools.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { RpcError } from "./rpc.js";
import { createReadOnlyVaultTools, createVaultTools, type VaultClient } from "./tools.js";
import { convertAgentEvent } from "./events.js";
import { resolveProvider, type ProviderConfig } from "./providers.js";
import { DeepSeekHarnessSession, HARNESS_ENGINE, HarnessAbortedError } from "./harness.js";
import { buildPersonalContext, withPersonalContext } from "./context.js";
import {
  TEAM_SYSTEM_NOTE,
  createTeamTools,
  type TeamOrchestrator,
  type TeamRunResult,
  type TeamSessionInfo,
  type TurnContext,
} from "./team.js";

export const ERR_SESSION_EXISTS = -32010;
export const ERR_SESSION_NOT_FOUND = -32011;
export const ERR_SESSION_BUSY = -32012;

export const DEFAULT_SYSTEM_PROMPT =
  "You are a workbench agent. You read and write files in the user's data folder " +
  "exclusively through the provided tools. You must never access anything outside " +
  "the data folder. The internal file tasks/history.json is excluded from analysis " +
  "context; do not request or analyze it.";

/** Outbound channel used to push agent/event notifications. */
export interface EventSink {
  notify(method: string, params?: unknown): void;
}

interface SessionEntry {
  engine: "pi" | typeof HARNESS_ENGINE;
  label: string;
  provider?: ProviderConfig;
  agent?: Agent;
  harness?: DeepSeekHarnessSession;
  unsubscribe: () => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly inflight = new Set<string>();
  private readonly turns = new Map<string, TurnContext>();

  constructor(
    private readonly vault: VaultClient,
    private readonly sink: EventSink,
    private readonly team?: TeamOrchestrator,
  ) {}

  /** Create a session from a contract ProviderConfig. */
  createSession(
    sessionId: string,
    provider: ProviderConfig,
    systemPrompt?: string,
    engine: "pi" | typeof HARNESS_ENGINE = "pi",
    enabledSkills?: string[],
    label?: string,
  ): { session_id: string } {
    if (this.sessions.has(sessionId)) {
      throw new RpcError(ERR_SESSION_EXISTS, `session already exists: ${sessionId}`);
    }
    if (engine === HARNESS_ENGINE) {
      const harness = new DeepSeekHarnessSession(provider, systemPrompt, {
        onProgress: (event) => this.sink.notify("agent/event", {
          session_id: sessionId,
          type: "progress",
          data: { ...event, engine: HARNESS_ENGINE },
        }),
      }, sessionId);
      this.sessions.set(sessionId, {
        engine,
        label: label?.trim() || sessionId,
        provider,
        harness,
        unsubscribe: () => { void harness.dispose(); },
      });
      return { session_id: sessionId };
    }
    const resolved = resolveProvider(provider);
    return this.createSessionWithModel(sessionId, resolved.model, {
      apiKey: resolved.apiKey,
      systemPrompt,
      provider,
      enabledSkills,
      label,
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
    options: { apiKey?: string; systemPrompt?: string; provider?: ProviderConfig; enabledSkills?: string[]; label?: string } = {},
  ): { session_id: string } {
    if (this.sessions.has(sessionId)) {
      throw new RpcError(ERR_SESSION_EXISTS, `session already exists: ${sessionId}`);
    }
    const basePrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const agent = new Agent({
      initialState: {
        systemPrompt: this.team ? `${basePrompt}${TEAM_SYSTEM_NOTE}` : basePrompt,
        model,
      },
      getApiKey: () => options.apiKey,
    });
    const vaultTools = createVaultTools(this.vault, sessionId, options.enabledSkills);
    agent.state.tools = this.team ? [...vaultTools, ...createTeamTools(this.team, sessionId)] : vaultTools;
    const unsubscribe = agent.subscribe((event) => {
      for (const notification of convertAgentEvent(event, "pi")) {
        this.sink.notify("agent/event", {
          session_id: sessionId,
          type: notification.type,
          data: notification.data,
        });
      }
    });
    this.sessions.set(sessionId, {
      engine: "pi",
      label: options.label?.trim() || sessionId,
      provider: options.provider,
      agent,
      unsubscribe,
    });
    return { session_id: sessionId };
  }

  /** Start a run. The reply streams back through agent/event notifications. */
  send(sessionId: string, text: string): Record<string, never> {
    const entry = this.get(sessionId);
    if (this.isBusy(sessionId)) {
      throw new RpcError(ERR_SESSION_BUSY, `session is busy: ${sessionId}`);
    }
    this.beginTurn(sessionId, { origin: "user", depth: 0, chain: [sessionId] });
    const finish = () => this.endTurn(sessionId);
    if (entry.engine === HARNESS_ENGINE) {
      if (!entry.harness) {
        finish();
        throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
      }
      void buildPersonalContext(this.vault, sessionId, entry.provider).then((context) => entry.harness!.prompt(withPersonalContext(text, context))).then((answer) => {
        this.sink.notify("agent/event", {
          session_id: sessionId,
          type: "text_delta",
          data: { delta: answer, engine: HARNESS_ENGINE },
        });
        this.sink.notify("agent/event", {
          session_id: sessionId,
          type: "message_complete",
          data: { stop_reason: "stop", engine: HARNESS_ENGINE },
        });
      }).catch((err) => {
        if (err instanceof HarnessAbortedError) return;
        this.sink.notify("agent/event", {
          session_id: sessionId,
          type: "error",
          data: { message: err instanceof Error ? err.message : String(err), engine: HARNESS_ENGINE },
        });
      }).finally(finish);
      return {};
    }
    if (!entry.agent) {
      finish();
      throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
    }
    // Fire-and-forget: the run settles via events. Unexpected failures become
    // an error notification instead of crashing the sidecar.
    void buildPersonalContext(this.vault, sessionId, entry.provider).then((context) => entry.agent!.prompt(withPersonalContext(text, context))).catch((err) => {
      this.sink.notify("agent/event", {
        session_id: sessionId,
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
    }).finally(finish);
    return {};
  }

  /**
   * Run one team turn and resolve with the assistant text.
   * The caller must not start this while `isBusy` is true.
   */
  async runTurn(sessionId: string, text: string, turn: TurnContext): Promise<TeamRunResult> {
    const entry = this.get(sessionId);
    if (this.isBusy(sessionId)) {
      throw new RpcError(ERR_SESSION_BUSY, `session is busy: ${sessionId}`);
    }
    this.beginTurn(sessionId, turn);
    try {
      if (entry.engine === HARNESS_ENGINE) {
        if (!entry.harness) throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
        try {
          const context = await buildPersonalContext(this.vault, sessionId, entry.provider);
          const answer = await entry.harness.prompt(withPersonalContext(text, context));
          this.sink.notify("agent/event", {
            session_id: sessionId,
            type: "text_delta",
            data: { delta: answer, engine: HARNESS_ENGINE },
          });
          this.sink.notify("agent/event", {
            session_id: sessionId,
            type: "message_complete",
            data: { stop_reason: "stop", engine: HARNESS_ENGINE },
          });
          return { text: answer.trim(), aborted: false };
        } catch (err) {
          if (err instanceof HarnessAbortedError) return { text: "", aborted: true };
          throw err;
        }
      }
      if (!entry.agent) throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
      let answer = "";
      let aborted = false;
      let failed: Error | undefined;
      const unsubscribe = entry.agent.subscribe((event) => {
        for (const notification of convertAgentEvent(event, "pi")) {
          if (notification.type === "text_delta") answer += String(notification.data.delta ?? "");
          if (notification.type === "error") failed = new Error(String(notification.data.message ?? "模型请求失败"));
          if (notification.type === "message_complete" && notification.data.stop_reason === "aborted") aborted = true;
        }
      });
      try {
        const context = await buildPersonalContext(this.vault, sessionId, entry.provider);
        await entry.agent.prompt(withPersonalContext(text, context));
        if (failed) throw failed;
        return { text: answer.trim(), aborted };
      } finally {
        unsubscribe();
      }
    } finally {
      this.endTurn(sessionId);
    }
  }

  /** Run one bounded, read-only analysis without creating a persistent chat session. */
  async runOnce(
    provider: ProviderConfig,
    text: string,
    systemPrompt: string,
    engine: "pi" | typeof HARNESS_ENGINE = "pi",
  ): Promise<{ text: string }> {
    if (engine === HARNESS_ENGINE) {
      const harness = new DeepSeekHarnessSession(provider, systemPrompt, {}, "analysis");
      try {
        // Keep one-shot analysis consistent with persistent sessions: a
        // locally bound provider receives only confirmed shared memory, while
        // cloud providers receive no personal context unless an explicit
        // consent flow is added later.
        const context = await buildPersonalContext(this.vault, "analysis", provider);
        return { text: await harness.prompt(withPersonalContext(text, context)) };
      } finally {
        await harness.dispose();
      }
    }
    const resolved = resolveProvider(provider);
    return this.runOnceWithModel(resolved.model, resolved.apiKey, text, systemPrompt, provider);
  }

  /** Injectable variant used by tests and offline analysis callers. */
  async runOnceWithModel(
    model: Model<any>,
    apiKey: string | undefined,
    text: string,
    systemPrompt: string,
    provider?: ProviderConfig,
  ): Promise<{ text: string }> {
    const sessionId = `analysis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const agent = new Agent({ initialState: { systemPrompt, model }, getApiKey: () => apiKey });
    agent.state.tools = createReadOnlyVaultTools(this.vault, sessionId);
    let answer = "";
    let providerError: Error | undefined;
    const unsubscribe = agent.subscribe((event) => {
      for (const notification of convertAgentEvent(event)) {
        if (notification.type === "text_delta") answer += String(notification.data.delta ?? "");
        if (notification.type === "error") providerError = new Error(String(notification.data.message ?? "模型分析失败"));
      }
    });
    try {
      const context = await buildPersonalContext(this.vault, sessionId, provider);
      await agent.prompt(withPersonalContext(text, context));
      if (providerError) throw providerError;
      return { text: answer.trim() };
    } finally {
      unsubscribe();
      agent.abort();
    }
  }

  /** Abort the session's current run, if any. */
  abort(sessionId: string): Record<string, never> {
    const entry = this.get(sessionId);
    this.team?.noteExternalAbort(sessionId);
    if (entry.engine === HARNESS_ENGINE) entry.harness?.abort();
    else entry.agent?.abort();
    return {};
  }

  /** Abort the current run without treating it as a user-level session abort. */
  abortRun(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.engine === HARNESS_ENGINE) entry.harness?.abort();
    else entry.agent?.abort();
  }

  /** Abort and remove a session. */
  closeSession(sessionId: string): Record<string, never> {
    const entry = this.get(sessionId);
    this.team?.onSessionClosed(sessionId);
    if (entry.engine === HARNESS_ENGINE) {
      entry.harness?.abort();
      void entry.harness?.dispose();
    }
    else entry.agent?.abort();
    entry.unsubscribe();
    this.sessions.delete(sessionId);
    this.inflight.delete(sessionId);
    this.turns.delete(sessionId);
    return {};
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isBusy(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (this.inflight.has(sessionId)) return true;
    return Boolean(entry.agent?.state.isStreaming);
  }

  currentTurn(sessionId: string): TurnContext | undefined {
    const turn = this.turns.get(sessionId);
    return turn ? { ...turn, chain: [...turn.chain] } : undefined;
  }

  labelOf(sessionId: string): string {
    return this.sessions.get(sessionId)?.label || sessionId;
  }

  setLabel(sessionId: string, label: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    entry.label = label.trim() || sessionId;
    return true;
  }

  listSessions(): TeamSessionInfo[] {
    return [...this.sessions.entries()].map(([id, entry]) => ({
      id,
      label: entry.label,
      engine: entry.engine,
    }));
  }

  /** Tool names bound to a pi session. Empty when the session is not pi. */
  toolNames(sessionId: string): string[] {
    const entry = this.get(sessionId);
    return entry.agent?.state.tools.map((tool) => tool.name) ?? [];
  }

  private beginTurn(sessionId: string, turn: TurnContext): void {
    this.inflight.add(sessionId);
    this.turns.set(sessionId, { ...turn, chain: [...turn.chain] });
  }

  private endTurn(sessionId: string): void {
    this.inflight.delete(sessionId);
    this.turns.delete(sessionId);
    this.team?.notifyIdle(sessionId);
  }

  private get(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${sessionId}`);
    }
    return entry;
  }
}
