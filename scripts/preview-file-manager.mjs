import { build } from 'esbuild';
import { createServer } from 'node:http';
const result = await build({entryPoints:['scripts/fixtures/FileManagerDraft.tsx'],bundle:true,write:false,outdir:'/virtual',loader:{'.png':'dataurl'},jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}});
const files = new Map(result.outputFiles.map((file)=>[file.path.split('/').at(-1),file.contents]));
const html='<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>家合 · 文件管理布局稿</title><link rel="stylesheet" href="/FileManagerDraft.css"></head><body><div id="root"></div><script src="/FileManagerDraft.js"></script></body></html>';
createServer((req,res)=>{const name=req.url?.slice(1),asset=files.get(name);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',asset?name.endsWith('.css')?'text/css':'text/javascript':'text/html; charset=utf-8');res.end(asset??html);}).listen(1428,'127.0.0.1',()=>console.log('File manager layout draft: http://127.0.0.1:1428/'));
