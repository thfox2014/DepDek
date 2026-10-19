import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const version = readFileSync(new URL('../VERSION',import.meta.url),'utf8').trim();
const result = await build({entryPoints:['scripts/fixtures/AiOsWizardPreview.tsx'],bundle:true,write:false,outdir:'/virtual',loader:{'.png':'dataurl'},define:{'__APP_VERSION__':JSON.stringify(version),'process.env.NODE_ENV':'"development"'},jsx:'automatic'});
const files = new Map(result.outputFiles.map((file)=>[file.path.split('/').at(-1),file.contents]));
const html='<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>家合 · 四步配置向导验收</title><link rel="stylesheet" href="/AiOsWizardPreview.css"></head><body><div id="root"></div><script src="/AiOsWizardPreview.js"></script></body></html>';
createServer((req,res)=>{const name=req.url?.slice(1),asset=files.get(name);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',asset?name.endsWith('.css')?'text/css':'text/javascript':'text/html; charset=utf-8');res.end(asset??html);}).listen(1427,'127.0.0.1',()=>console.log('Synthetic setup UI: http://127.0.0.1:1427/'));
