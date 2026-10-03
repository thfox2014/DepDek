#!/usr/bin/env node
/**
 * Browser-preview dev server.
 *
 * Spins up the standalone sidecar HTTP service together with the Vite dev
 * server, and forwards the sidecar's per-launch preview token to Vite via a
 * `.preview-token` file (0600). The Vite proxy injects that token as an
 * `x-depdek-token` header on `/v1` requests, so the browser JS never sees it
 * and the CORS-restricted settings API stays closed to other origins.
 *
 * Usage: npm run dev:preview
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = join(root, ".preview-token");
const port = Number(process.env.DEPDEK_AGENT_HTTP_PORT ?? 1421);
const home = resolve(process.env.DEPDEK_HOME ?? join(homedir(), "DepDek-Home"));
const sidecarEntry = join(root, "sidecar/dist/sidecar.mjs");

if (!existsSync(sidecarEntry)) {
  console.error("[dev-preview] sidecar dist missing; building first…");
  const built = spawnSync("npm", ["--prefix", "sidecar", "run", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    console.error("[dev-preview] sidecar build failed");
    process.exit(built.status ?? 1);
  }
}

let tornDown = false;
function cleanup() {
  if (tornDown) return;
  tornDown = true;
  rmSync(tokenFile, { force: true });
  for (const child of [sidecar, vite]) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

function writeToken(token) {
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  console.error(`[dev-preview] preview token written to .preview-token (0600)`);
}

const sidecar = spawn(
  "node",
  [sidecarEntry, `--http=${port}`, "--home", home],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);

let stderrBuffer = "";
sidecar.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  stderrBuffer += text;
  let newline;
  while ((newline = stderrBuffer.indexOf("\n")) >= 0) {
    const line = stderrBuffer.slice(0, newline).trim();
    stderrBuffer = stderrBuffer.slice(newline + 1);
    const match = line.match(/^\[sidecar\] preview token: ([0-9a-f]+)/);
    if (match) writeToken(match[1]);
  }
});

const vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

function onChildExit(name) {
  return (code) => {
    console.error(`[dev-preview] ${name} exited (code ${code}); stopping preview.`);
    cleanup();
    process.exit(code ?? 1);
  };
}

sidecar.on("exit", onChildExit("sidecar"));
vite.on("exit", onChildExit("vite"));

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

console.error(`[dev-preview] sidecar: http://127.0.0.1:${port} | vite: http://localhost:1420 | home: ${home}`);