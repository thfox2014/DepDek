// Read-only local design preview. No API proxy, filesystem routes or cloud calls.
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const requested = args.length === 0 ? "1436" : args.length === 2 && args[0] === "--port" ? args[1] : "invalid";
const port = Number(requested);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Usage: node scripts/preview-jiaho-first-mile.mjs [--port 0..65535]");
const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
const result = await build({ absWorkingDir: new URL("..", import.meta.url).pathname, entryPoints: ["scripts/fixtures/JiahoFirstMilePreview.tsx"], bundle: true, write: false, outdir: "/virtual", loader: { ".png": "dataurl" }, define: { __APP_VERSION__: JSON.stringify(version), "process.env.NODE_ENV": '"development"' }, jsx: "automatic" });
const assets = new Map(result.outputFiles.map((file) => ["/" + file.path.split("/").at(-1), file.contents]));
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>家合 · 慢慢说</title><link rel="stylesheet" href="/JiahoFirstMilePreview.css"></head><body><div id="root"></div><script src="/JiahoFirstMilePreview.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader("Permissions-Policy", "microphone=(), camera=(), geolocation=()");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const asset = assets.get(path);
  if (!asset && path !== "/") { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", asset ? path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  res.end(req.method === "HEAD" ? undefined : asset ?? html);
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`Jiaho first-mile design v0: http://127.0.0.1:${server.address().port}/`));
