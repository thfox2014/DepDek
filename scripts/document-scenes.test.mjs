import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { DOCUMENT_SCENES, documentGroups, documentPacketDraft, suggestDocumentScene } from "../src/lib/documentScenes.ts";
import { documentExamples } from "./fixtures/documentExamples.ts";

test("three document intents only suggest a scene; unrelated and negated requests do not route", () => {
  assert.equal(suggestDocumentScene("洗碗机的滤网怎么清洗？帮我找一下说明书。"), "find");
  assert.equal(suggestDocumentScene("刚放进来的装修资料，帮我理一理。"), "organize");
  assert.equal(suggestDocumentScene("周末去露营，帮我把要用的资料准备好。"), "prepare");
  assert.equal(suggestDocumentScene("不要整理文件，找一下说明书"), "find");
  assert.equal(suggestDocumentScene("不要整理资料"), null);
  assert.equal(suggestDocumentScene("找海边照片"), null);
  assert.equal(suggestDocumentScene("分析一下我的待办"), null);
  assert.equal(suggestDocumentScene("x".repeat(4096) + "准备资料包"), null);
  assert.equal(DOCUMENT_SCENES.length, 3);
});

test("organization preserves every example file, including older versions and duplicates", () => {
  const before = structuredClone(documentExamples.organize);
  const groups = documentGroups(documentExamples.organize);
  assert.equal(groups.length, 3);
  assert.equal(groups.flatMap((group) => group.files).length, 5);
  assert.equal(groups.flatMap((group) => group.files).filter((file) => file.kind === "duplicate").length, 1);
  assert.deepEqual(documentExamples.organize, before);
});

test("packet drafts exclude missing and unknown IDs and never claim an export or sharing", () => {
  const draft = documentPacketDraft(documentExamples.prepare, ["booking", "booking", "entry", "not-known"]);
  assert.equal(draft.references.length, 1);
  assert.deepEqual(draft.missing, ["营地入场说明"]);
  assert.equal(draft.status, "preview_only");
  assert.equal(draft.output, null);
  assert.equal(draft.shared, false);
  assert.deepEqual(documentPacketDraft(documentExamples.prepare, []).references, []);
});

async function render(contents) {
  const result = await build({
    stdin: { contents, resolveDir: new URL("..", import.meta.url).pathname, loader: "jsx" },
    bundle: true, platform: "node", format: "cjs", write: false,
    loader: { ".css": "empty", ".png": "dataurl" }, define: { __APP_VERSION__: '"0.2.1"' }, logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

test("all three scene canvases render labeled examples with no more than three main actions", async () => {
  const result = await render(`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Panel from './src/components/DocumentsPanel'; import {documentExamples} from './scripts/fixtures/documentExamples'; export const htmls=['find','organize','prepare'].map(scene=>renderToStaticMarkup(React.createElement(Panel,{scene,examples:documentExamples,onAsk:()=>{},onProgress:()=>{},onOpenHome:()=>{},onClose:()=>{}})));`);
  for (const html of result.htmls) {
    assert.ok(html.includes("示例 · 交互原型"));
    const footer = html.match(/aria-label="当前场景操作"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.equal((footer.match(/<button/g) ?? []).length, 3);
    assert.ok(!html.includes("dangerouslySetInnerHTML"));
  }
  assert.ok(result.htmls[0].includes("洗碗机使用说明.pdf"));
  assert.ok(result.htmls[1].includes("旧版保留"));
  assert.ok(result.htmls[2].includes("营地入场说明"));
});

test("native shell renames album and exposes documents but never uses injected examples outside preview", async () => {
  const { html } = await render(`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Room from './src/components/DepDekAiOsShell'; import {ensureAiOsRoom} from './src/lib/aiOsRoom'; import {BUILTIN_PROVIDER} from './src/lib/aiOsSetup'; import {documentExamples} from './scripts/fixtures/documentExamples'; export const html=renderToStaticMarkup(React.createElement(Room,{initialDocumentScene:'find',documentExamples,root:'/family',settings:ensureAiOsRoom({providers:{local:BUILTIN_PROVIDER}}),sessions:[],activeAgentId:null,chats:{},running:{},onSelectAgent:()=>{},onSend:async()=>{},onAbort:async()=>{},onCreateAgent:async()=>{},onSaveSettings:async()=>{},onOpenHome:()=>{}}));`);
  assert.ok(html.includes("相册")); assert.ok(html.includes("资料"));
  assert.ok(!html.includes("宝箱")); assert.ok(!html.includes("宝盒"));
  assert.ok(html.includes("浏览器原型没有连接本机 Vault"));
  assert.ok(!html.includes("洗碗机使用说明.pdf"));
  assert.ok(html.includes("v0.2.1"));
});

test("preview failure and empty states do not render successful results", async () => {
  const { htmls } = await render(`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Panel from './src/components/DocumentsPanel'; import {documentExamples} from './scripts/fixtures/documentExamples'; export const htmls=['empty','error'].map(initialState=>renderToStaticMarkup(React.createElement(Panel,{scene:'find',initialState,examples:documentExamples,onAsk:()=>{},onProgress:()=>{},onOpenHome:()=>{},onClose:()=>{}})));`);
  assert.ok(htmls[0].includes("载入示例资料")); assert.ok(htmls[1].includes("重试示例"));
  for (const html of htmls) assert.ok(!html.includes("洗碗机使用说明.pdf"));
});
