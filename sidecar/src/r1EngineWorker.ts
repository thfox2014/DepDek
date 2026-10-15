/** Trusted launcher uses a restricted socket; this process itself is not a sandbox. */
import { isAbsolute } from "node:path";

// Do not let SDK initialization discover developer credentials, NODE_OPTIONS or Home.
for (const key of Object.keys(process.env))
  if (!["PATH", "LANG", "LC_ALL"].includes(key)) delete process.env[key];
const args = process.argv.slice(2);
const option = (key: string) => {
  const index = args.indexOf(key);
  if (index < 0 || index + 1 >= args.length) throw new Error("INVALID_CONFIG");
  const value = args[index + 1]!;
  args.splice(index, 2);
  return value;
};
let sequence = 0;
const write = (data: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ seq: ++sequence, ...data }) + "\n");
try {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "node r1-engine-worker.mjs --socket PATH --worker-command PATH --server-uid UID\nSingle bounded stdin JSON. Actual Pi/Harness SDK loops, no tools or real Key. Requires operator-provisioned OS isolation.\n",
    );
  } else {
    const socket = option("--socket"),
      command = option("--worker-command"),
      serverUid = Number(option("--server-uid"));
    if (
      args.length ||
      !isAbsolute(socket) ||
      !isAbsolute(command) ||
      !Number.isSafeInteger(serverUid) ||
      serverUid < 1
    )
      throw new Error("INVALID_CONFIG");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let input: unknown;
    const inputDeadline = setTimeout(
      () => process.stdin.destroy(new Error("INPUT_DEADLINE")),
      10_000,
    );
    try {
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 32 * 1024) {
          buffer.fill(0);
          throw new Error("INPUT_LIMIT");
        }
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      try {
        const text = raw.toString("utf8");
        if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
          throw new Error("INVALID_FRAME");
        input = JSON.parse(text);
      } finally {
        raw.fill(0);
      }
    } finally {
      clearTimeout(inputDeadline);
      for (const chunk of chunks) chunk.fill(0);
    }
    const { runR1Engine, fixedGateway } = await import("./r1Engine.js");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const deadline = setTimeout(stop, 50_000);
    try {
      const result = await runR1Engine(
        input,
        fixedGateway({ command, socket, serverUid }),
        (event) => write({ ...event }),
        controller.signal,
      );
      write({ type: "result", ...result });
    } finally {
      clearTimeout(deadline);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      input = undefined;
    }
  }
} catch (error) {
  let code = "RUNTIME_UNSUPPORTED";
  try {
    const { safeEngineError } = await import("./r1Engine.js");
    code = safeEngineError(error);
  } catch {
    /* Missing SDK must not print an import stack or input. */
  }
  write({
    type: "error",
    code,
    message: "受控执行失败；请查证授权状态，不自动重试",
  });
  process.exitCode = 2;
}
