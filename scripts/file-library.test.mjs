import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { prepareImports, runImports, MAX_IMPORT_BYTES, importError } from "../src/lib/fileLibrary.ts";

const file = (name, size = 5) => ({ name, size });
const LIBRARY = "b".repeat(64);
function receipt(input, size = 5) {
  return { status:"indexed", file:{file_id:input.operationId, size, sha256:"a".repeat(64)}, summary:{library_id:input.libraryId,total:1} };
}
test("selection is bounded before reading file contents", () => {
  assert.throws(() => prepareImports(Array.from({length:101}, () => file("a")), LIBRARY), /100/);
  assert.throws(() => prepareImports([file("large.mp4", MAX_IMPORT_BYTES + 1)], LIBRARY), /64 MB/);
  assert.throws(() => prepareImports([file("a.txt")], ""), /连接/);
});
test("partial failure retries only failed imports with their original operation IDs", async () => {
  const entries = prepareImports([file("a.txt"), file("b.txt"), file("c.txt")], LIBRARY);
  const calls = [], reads = [], saved = []; let attempts = 0, running = 0, maxRunning = 0;
  const service = async (input) => {
    running++; maxRunning=Math.max(maxRunning,running); calls.push(input);
    try { if(input.name === "b.txt" && attempts++ === 0) throw new Error("temporary failure"); return receipt(input); }
    finally { running--; }
  };
  const options = {changed:()=>{},saved:(r)=>saved.push(r.file.file_id),read:async(f)=>{reads.push(f.name); return "aGVsbG8=";}};
  await runImports(entries, service, options);
  assert.deepEqual(entries.map((e)=>e.state), ["saved","failed","saved"]);
  const failedId=entries[1].operationId;
  await runImports(entries, service, options);
  assert.deepEqual(entries.map((e)=>e.state), ["saved","saved","saved"]);
  assert.deepEqual(calls.map((c)=>c.name), ["a.txt","b.txt","c.txt","b.txt"]);
  assert.equal(calls[3].operationId,failedId); assert.equal(maxRunning,1);
  assert.ok(calls.every((call) => call.libraryId === LIBRARY));
  assert.equal(reads.length,4); assert.equal(new Set(saved).size,3);
});
test("an incomplete receipt is not reported as a saved file", async () => {
  const entries=prepareImports([file("a.txt")], LIBRARY); let saved=0;
  await runImports(entries, async(input)=>({...receipt(input),status:"pending"}), {changed:()=>{},saved:()=>saved++,read:async()=>"aGVsbG8="});
  assert.equal(entries[0].state,"failed"); assert.equal(saved,0);
  assert.ok(!importError("server-secret-value").includes("server-secret-value"));
});
test("leaving the import view stops unsent files without claiming completion", async () => {
  const entries=prepareImports([file("a.txt")], LIBRARY); let active=true, calls=0;
  await runImports(entries, async()=>{calls++;}, {changed:()=>{},saved:()=>{},active:()=>active,read:async()=>{active=false;return "aGVsbG8=";}});
  assert.equal(calls,0); assert.equal(entries[0].state,"pending");
});
test("a receipt from a different library is never reported as saved", async () => {
  const entries=prepareImports([file("a.txt")], LIBRARY); let saved=0;
  await runImports(entries, async(input)=>({...receipt(input),summary:{library_id:"c".repeat(64)}}), {changed:()=>{},saved:()=>saved++,read:async()=>"aGVsbG8="});
  assert.equal(entries[0].state,"failed"); assert.equal(saved,0);
  assert.equal(entries[0].libraryId,LIBRARY);
  assert.match(importError("E32602 Home changed; import belongs to another library"), /空间已切换/);
});
test("wrong file IDs, sizes or missing content fingerprints cannot become successful receipts", async () => {
  for (const change of [{file_id:"other"},{size:100},{sha256:"unknown"}]) {
    const entries=prepareImports([file("a.txt")],LIBRARY); let saved=0;
    await runImports(entries,async(input)=>{const next=receipt(input);return {...next,file:{...next.file,...change}};},{changed:()=>{},saved:()=>saved++,read:async()=>"aGVsbG8="});
    assert.equal(entries[0].state,"failed");assert.equal(saved,0);
  }
});
test("a completed in-flight import is announced, but leaving never sends the next file", async () => {
  const entries=prepareImports([file("a.txt"),file("b.txt")],LIBRARY); let active=true,saved=0,calls=0;
  await runImports(entries,async(input)=>{calls++;active=false;return receipt(input);},{changed:()=>{},saved:()=>saved++,active:()=>active,read:async()=>"aGVsbG8="});
  assert.equal(calls,1);assert.equal(saved,1);
  assert.deepEqual(entries.map((entry)=>entry.state),["saved","pending"]);
});
test("native importer is actionable, while a disconnected browser preview cannot pretend to save", async () => {
  const result=await build({
    stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import Button from './src/components/FileImportButton';export const disconnected=renderToStaticMarkup(React.createElement(Button));export const connected=renderToStaticMarkup(React.createElement(Button,{service:async()=>{},resolveLibrary:async()=>'${LIBRARY}'}));`,resolveDir:new URL('..',import.meta.url).pathname,loader:'jsx'},
    bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},logLevel:'silent',
  });
  const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  assert.match(module.exports.disconnected,/disabled=""/);
  assert.ok(!module.exports.connected.includes('disabled=""'));
  assert.ok(module.exports.connected.includes('添加资料'));
  assert.ok(!module.exports.connected.includes('同意授权'));
});
