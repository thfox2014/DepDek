import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({ entryPoints: ["scripts/fixtures/jiaho-first-mile-state.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { demoInitial, demoReducer: reduce, rememberedGreeting, canDemoSend } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
test("unconfirmed and skipped memories never personalize a return", () => {
  const proposed = reduce(demoInitial(), { type: "send", text: "以后回答简单一点，先说重点" });
  assert.equal(proposed.candidate.confirmed, false);
  assert.equal(rememberedGreeting(reduce(proposed, { type: "return" })), null);
  assert.equal(reduce(proposed, { type: "skip" }).candidate, null);
});
test("only explicit confirmation enables return personalization; edits preserve source", () => {
  const proposed = reduce(demoInitial(), { type: "send", text: "以后回答简单一点，先说重点" });
  const confirmed = reduce(proposed, { type: "confirm", text: "先说重点" });
  assert.equal(rememberedGreeting(reduce(confirmed, { type: "return" })), "先说重点");
  assert.equal(confirmed.memory.source, proposed.candidate.source);
  assert.deepEqual(reduce(confirmed, { type: "confirm", text: " " }), confirmed);
});
test("new candidates do not overwrite a previously confirmed preference", () => {
  let state = reduce(demoInitial(), { type: "send", text: "以后回答简单一点" });
  state = reduce(state, { type: "confirm", text: "先说重点" });
  state = reduce(state, { type: "send", text: "以后回答简短一点" });
  assert.equal(rememberedGreeting(reduce(state, { type: "return" })), "先说重点");
  state = reduce(state, { type: "skip" });
  assert.equal(state.candidate, null);
  assert.equal(state.memory.text, "先说重点");
});
test("editing saved memory cannot accidentally confirm another pending source", () => {
  let state = reduce(demoInitial(), { type: "send", text: "以后回答简单一点" });
  state = reduce(state, { type: "confirm", text: "先说重点" });
  const source = state.memory.source;
  state = reduce(state, { type: "send", text: "以后回答简短一点" });
  state = reduce(state, { type: "confirm", text: "简短回答", target: "memory" });
  assert.equal(state.memory.source, source);
  assert.equal(state.candidate.confirmed, false);
});
test("forget excludes memory from return without pretending chat was deleted", () => {
  const proposed = reduce(demoInitial(), { type: "send", text: "以后回答简单一点" });
  const forgotten = reduce(reduce(proposed, { type: "confirm", text: "简单一点" }), { type: "forget" });
  assert.equal(rememberedGreeting(reduce(forgotten, { type: "return" })), null);
  assert.equal(forgotten.messages.length, 2);
  assert.match(forgotten.notice, /原文没有一并删除/);
});
test("cloud preview requires consent for each turn and resets it on mode change", () => {
  const cloud = reduce(demoInitial(), { type: "mode", mode: "cloud" });
  assert.equal(canDemoSend(cloud, "你好"), false);
  assert.equal(reduce(cloud, { type: "send", text: "你好" }).messages.length, 0);
  const allowed = reduce(cloud, { type: "consent", allowed: true });
  assert.equal(canDemoSend(allowed, "你好"), true);
  assert.equal(reduce(allowed, { type: "send", text: "你好" }).cloudConsent, false);
  assert.equal(reduce(allowed, { type: "mode", mode: "local" }).cloudConsent, false);
});
test("no source selection or filename match means no file result", () => {
  assert.equal(reduce(demoInitial(), { type: "send", text: "找洗衣机购买凭证" }).messages[1].file, false);
  const ready = reduce(demoInitial(), { type: "library" });
  assert.equal(reduce(ready, { type: "send", text: "找洗衣机购买凭证" }).messages[1].file, true);
  assert.match(reduce(ready, { type: "send", text: "找旅行照片" }).messages[1].text, /没有找到/);
});
test("reset clears fixture input-derived state and empty sends are inert", () => {
  const first = demoInitial();
  assert.deepEqual(reduce(first, { type: "send", text: " " }), first);
  const ready = reduce(reduce(first, { type: "library" }), { type: "send", text: "以后回答简单一点" });
  assert.deepEqual(reduce(ready, { type: "reset" }), first);
});
