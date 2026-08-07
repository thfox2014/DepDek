// Mock sidecar for rpc.rs integration tests.
//
// Protocol: NDJSON JSON-RPC 2.0 over stdio (contract section 2). stdout is
// protocol-only; diagnostics go to stderr. On startup it drives the Rust
// side through a scripted sequence of vault/* requests, checks the
// responses itself, then reports the outcome as a single agent/event
// notification: type "message_complete" with stop_reason "mock_done" on
// success, or type "error" describing the first failed check.

import readline from "node:readline";

let nextId = 100000; // sidecar id space (contract section 2)
const pending = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(params) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", method: "agent/event", params }) + "\n"
  );
}

const log = (...args) => console.error("[mock-sidecar]", ...args);

function fail(message) {
  notify({ session_id: "test-agent", type: "error", data: { message } });
  setTimeout(() => process.exit(0), 200);
}

async function main() {
  const list = await request("vault/list_dir", { session_id: "test-agent", path: "." });
  log("list_dir ->", JSON.stringify(list));
  if (!list.result?.entries?.some((e) => e.name === "hello.txt" && e.kind === "file")) {
    return fail("list_dir did not return hello.txt: " + JSON.stringify(list));
  }

  const read = await request("vault/read_file", { session_id: "test-agent", path: "hello.txt" });
  log("read_file ->", JSON.stringify(read));
  if (read.result?.content !== "hello vault" || read.result?.size !== 11) {
    return fail("read_file returned unexpected content: " + JSON.stringify(read));
  }

  const write = await request("vault/write_file", {
    session_id: "test-agent",
    path: "sub/new.txt",
    content: "from mock",
  });
  log("write_file ->", JSON.stringify(write));
  if (write.result?.size !== 9 || typeof write.result?.sha256 !== "string") {
    return fail("write_file returned unexpected result: " + JSON.stringify(write));
  }

  // Path escape must be rejected with -32001.
  const escape = await request("vault/read_file", {
    session_id: "test-agent",
    path: "../etc/passwd",
  });
  log("escape ->", JSON.stringify(escape));
  if (escape.error?.code !== -32001) {
    return fail("expected error code -32001 for path escape, got: " + JSON.stringify(escape));
  }

  notify({
    session_id: "test-agent",
    type: "message_complete",
    data: { stop_reason: "mock_done" },
  });
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  log("fatal", err);
  notify({ session_id: "system", type: "error", data: { message: String(err) } });
  setTimeout(() => process.exit(1), 200);
});
