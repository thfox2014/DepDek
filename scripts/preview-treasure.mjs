import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
const bundle = await build({ entryPoints: { TreasurePreview: "scripts/fixtures/TreasurePreview.tsx", documentPdf: "src/workers/documentPdf.ts" }, bundle: true, format: "esm", write: false, outdir: "/virtual", loader: { ".png": "dataurl", ".mp4": "dataurl" }, define: { "__APP_VERSION__": JSON.stringify(version), "process.env.NODE_ENV": '"development"' }, jsx: "automatic" });
const assets = new Map(bundle.outputFiles.map((file) => [file.path.split("/").at(-1), file.contents]));
assets.set("workers/documentPdf.ts", assets.get("documentPdf.js"));
for (const folder of ["cmaps", "standard_fonts"]) {
  const directory = new URL(`../node_modules/pdfjs-dist/${folder}/`, import.meta.url);
  for (const name of readdirSync(directory)) if (/^[\w.-]+\.(bcmap|pfb|ttf)$/.test(name) || /^LICENSE(?:_[A-Z]+)?$/.test(name)) assets.set(`pdf-assets/${folder}/${name}`, readFileSync(new URL(name, directory)));
}
assets.set("pdf-assets/LICENSE_PDFJS", readFileSync(new URL("../node_modules/pdfjs-dist/LICENSE", import.meta.url)));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>悟空 · 相册、视频与资料</title><link rel="stylesheet" href="/TreasurePreview.css"></head><body data-default-workspace="${process.argv.includes("--videos") ? "videos" : process.argv.includes("--documents") ? "documents" : "album"}"><div id="root"></div><script type="module" src="/TreasurePreview.js"></script></body></html>`;
const port = Number(process.env.DEPDEK_TREASURE_PREVIEW_PORT ?? 1431);
createServer((req, res) => { const name = req.url?.slice(1).split("?")[0] ?? "", asset = assets.get(name); res.setHeader("Content-Type", asset ? name.startsWith("pdf-assets/") ? "application/octet-stream" : name.endsWith(".css") ? "text/css" : "text/javascript" : "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(asset ?? html); }).listen(port, "127.0.0.1", () => console.log(`Wukong collections preview: http://127.0.0.1:${port}`));
