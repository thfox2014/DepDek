/**
 * Sidecar entry point: wires the stdio JSON-RPC layer to the session manager
 * and registers the contract agent/* methods (section 2.1).
 *
 * stdout carries protocol lines only; all logging goes to stderr.
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createStdioPeer } from "./rpc.js";
import { SessionManager } from "./sessions.js";
import { TeamOrchestrator, type RosterAgent } from "./team.js";
import { ApprovalGate } from "./approval.js";
import { McpRegistry, type McpSecrets } from "./mcp.js";
import { Scheduler, mailArrivalDetail } from "./schedule.js";
import { createCredentialsAccess } from "./credentials.js";
import { LocalVault } from "./localVault.js";
import { startAgentHttpServer } from "./httpServer.js";
import { applyMailAction, deleteMail, fetchMail, listMailboxes, sendMail } from "./mail.js";
import { pushCalendarEvent, syncCalendar } from "./calendar.js";
import { enqueueTodo, listTodos, todoBus, updateTodo } from "./todo.js";
import { registerMemoryHandlers } from "./memory.js";
import { registerContentAgentHandlers } from "./contentAgent.js";
import type { ProviderConfig } from "./providers.js";

// Anything accidentally logged via console.log must not corrupt the protocol
// stream, so redirect all console output to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

const peer = createStdioPeer();
registerContentAgentHandlers(peer);
let sessions!: SessionManager;
const team = new TeamOrchestrator({
  has: (id) => sessions.has(id),
  isBusy: (id) => sessions.isBusy(id),
  labelOf: (id) => sessions.labelOf(id),
  setLabel: (id, label) => sessions.setLabel(id, label),
  listSessions: () => sessions.listSessions(),
  currentTurn: (id) => sessions.currentTurn(id),
  runTurn: (id, text, turn) => sessions.runTurn(id, text, turn),
  abortRun: (id) => sessions.abortRun(id),
}, peer, peer);
const approval = new ApprovalGate(peer, peer);
const mcpSecrets: McpSecrets = {
  async get(key) {
    const access = await mcpCredentials();
    return access.getSecret("mcp", key);
  },
  async set(key, value) {
    const access = await mcpCredentials();
    await access.setSecret("mcp", key, value);
  },
  async delete(key) {
    const access = await mcpCredentials();
    await access.deleteSecret("mcp", key);
  },
};
let mcpCredentialsPromise: ReturnType<typeof createCredentialsAccess> | undefined;
function mcpCredentials() {
  mcpCredentialsPromise ??= createCredentialsAccess(peer, "mcp");
  return mcpCredentialsPromise;
}
const mcp = new McpRegistry(peer, approval, mcpSecrets);
const schedule = new Scheduler({
  has: (id) => sessions.has(id),
  isBusy: (id) => sessions.isBusy(id),
  runTurn: (id, text, turn) => sessions.runTurn(id, text, turn),
}, peer, peer);
sessions = new SessionManager(peer, peer, team, { approval, mcp });
schedule.start();
todoBus.subscribe("*", (event) => {
  if (event.type !== "enqueued") return;
  schedule.onEvent("todo", `${event.item.title} ${event.item.source ?? ""}`);
});

registerMemoryHandlers(peer);

peer.register("agent/create_session", (params) =>
  sessions.createSession(
    params.session_id,
    params.provider as ProviderConfig,
    params.system_prompt,
    params.engine,
    params.enabled_skills,
    params.label,
    params.config_dir,
    params.mcp_grants,
  ),
);
peer.register("team/list", () => team.list());
peer.register("team/cancel", (params) => team.cancel(String(params?.task_id ?? "")));
peer.register("team/roster", (params) => team.applyRoster((params?.agents ?? []) as RosterAgent[]));
peer.register("team/policy_get", () => team.getPolicy());
peer.register("team/policy_set", (params) => team.setPolicy(params?.policy ?? params));
peer.register("approval/list", () => approval.list());
peer.register("approval/decide", (params) => approval.decide(String(params?.id ?? ""), String(params?.decision ?? "")));
peer.register("schedule/list", () => schedule.list());
peer.register("schedule/put", (params) => schedule.put(params?.routine ?? params));
peer.register("schedule/delete", (params) => schedule.delete(String(params?.id ?? "")));
peer.register("mcp/connectors_get", () => mcp.listConnectors());
peer.register("mcp/connector_put", (params) => mcp.putConnector(params?.connector ?? params));
peer.register("mcp/connector_delete", (params) => mcp.deleteConnector(String(params?.id ?? "")));
peer.register("mcp/oauth_store", (params) => mcp.oauthStore(params ?? {}));
peer.register("mcp/oauth_status", (params) => mcp.oauthStatus(String(params?.connector_id ?? "")));
peer.register("mcp/list_tools", (params) => mcp.listRemoteTools(String(params?.connector_id ?? "")));
peer.register("mcp/reload", (params) => sessions.reloadMcp(String(params?.session_id ?? "")));
peer.register("agent/send", (params) => sessions.send(params.session_id, params.text));
peer.register("agent/analyze", (params) => sessions.runOnce(
  params.provider as ProviderConfig,
  String(params.text ?? ""),
  String(params.system_prompt ?? ""),
  params.engine,
));
peer.register("agent/abort", (params) => sessions.abort(params.session_id));
peer.register("agent/close_session", (params) => sessions.closeSession(params.session_id));
peer.register("mail/fetch", async (params) => {
  const result = await fetchMail(peer, {
    account: params?.account,
    refresh_body: params?.refresh_body,
  }, undefined, (event) => peer.notify("mail/event", event));
  const arrived = mailArrivalDetail(result.accounts);
  if (arrived) schedule.onEvent("mail", arrived);
  return result;
});
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

// ---------------------------------------------------------------------------
// Optional standalone HTTP service (browser preview, headless appliances).
//
//   node dist/sidecar.mjs --http[=port] --home <data folder>
//
// Serves the settings API out of the local data folder. The desktop shell
// keeps talking over stdio and never starts this server.
// ---------------------------------------------------------------------------

function cliValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

if (process.argv.slice(2).some((arg) => arg === "--http" || arg.startsWith("--http="))) {
  const port = Number(cliValue("--http") ?? process.env["DEPDEK_AGENT_HTTP_PORT"] ?? 1421);
  const home = resolve(
    cliValue("--home") ?? process.env["DEPDEK_HOME"] ?? join(homedir(), "DepDek-Home"),
  );
  // The per-launch token gates settings reads/writes; the dev preview script
  // picks it up from stderr and hands it to the Vite proxy, which injects it
  // as a header so browser JS never sees it.
  const token =
    cliValue("--token") ?? process.env["DEPDEK_PREVIEW_TOKEN"] ?? randomBytes(24).toString("hex");
  const service = await startAgentHttpServer(new LocalVault(home), port, { token });
  console.error(`[sidecar] agent HTTP service: http://127.0.0.1:${service.port} (home: ${home})`);
  console.error(`[sidecar] preview token: ${token}`);
}

console.error("[sidecar] ready");
