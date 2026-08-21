/**
 * Sidecar entry point: wires the stdio JSON-RPC layer to the session manager
 * and registers the contract agent/* methods (section 2.1).
 *
 * stdout carries protocol lines only; all logging goes to stderr.
 */

import { createStdioPeer } from "./rpc.js";
import { SessionManager } from "./sessions.js";
import { applyMailAction, deleteMail, fetchMail, listMailboxes, sendMail } from "./mail.js";
import { pushCalendarEvent, syncCalendar } from "./calendar.js";
import { enqueueTodo, listTodos, updateTodo } from "./todo.js";
import { registerMemoryHandlers } from "./memory.js";
import type { ProviderConfig } from "./providers.js";

// Anything accidentally logged via console.log must not corrupt the protocol
// stream, so redirect all console output to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

const peer = createStdioPeer();
const sessions = new SessionManager(peer, peer);

registerMemoryHandlers(peer);

peer.register("agent/create_session", (params) =>
  sessions.createSession(params.session_id, params.provider as ProviderConfig, params.system_prompt, params.engine),
);
peer.register("agent/send", (params) => sessions.send(params.session_id, params.text));
peer.register("agent/analyze", (params) => sessions.runOnce(
  params.provider as ProviderConfig,
  String(params.text ?? ""),
  String(params.system_prompt ?? ""),
  params.engine,
));
peer.register("agent/abort", (params) => sessions.abort(params.session_id));
peer.register("agent/close_session", (params) => sessions.closeSession(params.session_id));
peer.register("mail/fetch", (params) => fetchMail(peer, {
  account: params?.account,
  refresh_body: params?.refresh_body,
}, undefined, (event) => peer.notify("mail/event", event)));
peer.register("mail/delete", (params) =>
  deleteMail(peer, { account: params.account, uids: params.uids }),
);
peer.register("mail/list_mailboxes", (params) =>
  listMailboxes(peer, { account: params.account }),
);
peer.register("mail/action", (params) =>
  applyMailAction(
    peer,
    {
      account: params.account,
      action: params.action,
      uids: params.uids,
      destination: params.destination,
      mailbox: params.mailbox,
    },
    undefined,
    (event) => peer.notify("mail/action_event", event),
  ),
);
peer.register("mail/send", (params) =>
  sendMail(peer, {
    account: params.account,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    text: params.text ?? "",
    html: params.html,
    attachments: params.attachments,
  }),
);
peer.register("calendar/sync", (params) => syncCalendar(peer, { account: params?.account }));
peer.register("calendar/push", (params) => pushCalendarEvent(peer, { account: params.account, event: params.event }));
peer.register("todo/list", () => listTodos(peer));
peer.register("todo/enqueue", (params) => enqueueTodo(peer, params.input, (event) => peer.notify("todo/event", event)));
peer.register("todo/update", (params) => updateTodo(peer, params.input, (event) => peer.notify("todo/event", event)));

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
