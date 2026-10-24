import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const port = Number(process.env.DEPDEK_ROOM_PREVIEW_PORT ?? 1426);
const bundle = await build({ entryPoints: ['scripts/fixtures/AiOsRoomPreview.tsx'], bundle: true, write: false, outdir: '/virtual', loader: { '.png': 'dataurl' }, define: { '__APP_VERSION__': JSON.stringify(version), 'process.env.NODE_ENV': '"development"' }, jsx: 'automatic' });
const assets = new Map(bundle.outputFiles.map((file) => [file.path.split('/').at(-1), file.contents]));
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>悟空 · AI-OS 界面预览</title><link rel="stylesheet" href="/AiOsRoomPreview.css"></head><body><div id="root"></div><script src="/AiOsRoomPreview.js"></script></body></html>';
createServer((req, res) => { const name = req.url?.slice(1); const asset = assets.get(name); res.setHeader('Content-Type', asset ? name.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(asset ?? html); }).listen(port, '127.0.0.1', () => console.log(`Isolated room UI preview: http://127.0.0.1:${port}`));
