/**
 * Sidecar entry point: wires the stdio JSON-RPC layer to the session manager
 * and registers the contract agent/* methods (section 2.1).
 *
 * stdout carries protocol lines only; all logging goes to stderr.
 */

import { createStdioPeer } from "./rpc.js";
import { SessionManager } from "./sessions.js";
import { fetchMail } from "./mail.js";
import type { ProviderConfig } from "./providers.js";

// Anything accidentally logged via console.log must not corrupt the protocol
// stream, so redirect all console output to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

const peer = createStdioPeer();
const sessions = new SessionManager(peer, peer);

peer.register("agent/create_session", (params) =>
  sessions.createSession(params.session_id, params.provider as ProviderConfig, params.system_prompt),
);
peer.register("agent/send", (params) => sessions.send(params.session_id, params.text));
peer.register("agent/abort", (params) => sessions.abort(params.session_id));
peer.register("agent/close_session", (params) => sessions.closeSession(params.session_id));
peer.register("mail/fetch", (params) => fetchMail(peer, { account: params?.account }));

// Never crash on stray failures: report them as an agent/event error
// notification (session_id "system" marks sidecar-level failures).
function reportFatal(context: string, err: unknown): void {
  console.error(`[sidecar] ${context}:`, err);
  try {
    peer.notify("agent/event", {
      session_id: "system",
      type: "error",
      data: { message: `${context}: ${err instanceof Error ? err.message : String(err)}` },
    });
  } catch {
    // Transport is gone; nothing more we can do.
  }
}

process.on("uncaughtException", (err) => reportFatal("uncaught exception", err));
process.on("unhandledRejection", (reason) => reportFatal("unhandled rejection", reason));

console.error("[sidecar] ready");
