import test from "node:test";
import assert from "node:assert/strict";
import { classifyPhotoBatch, resolvedPhotoLabels, photoLabelCorrections, PHOTO_BATCH_LIMIT } from "../src/lib/photoClassification.ts";
import { suggestTreasureScene } from "../src/lib/treasure.ts";

const provider = { kind: "openai-compatible", model: "synthetic-vision", base_url: "http://127.0.0.1:11434/v1" };
const photo = (name) => ({ file: { path: `${name}.png`, sha256: "a".repeat(64), category: "photos", name }, tags: [] });
const label = (dimension, label, confidence = 90) => ({ dimension, label, confidence, evidence: "受控测试画面依据" });
function harness(photos = [photo("a"), photo("b")]) {
  const calls = [], records = new Map(), progress = [];
  const options = { photos, libraryId: "home", providerName: "test", provider, mode: "online", allowRemote: false, active: () => true, onProgress: (value) => progress.push(value),
    prepare: async () => ({ text: "", images: [{ data: "synthetic", mimeType: "image/jpeg", label: "当前单张缩略图" }], coverage: "合成测试" }),
    services: {
      contentAnnotationGet: async ({ reference }) => records.get(reference.path) ?? null,
      contentAnalyze: async (input) => { calls.push(input); const item = { ...input.reference, revision: input.expectedRevision + 1, photo_labels: [label("place", "海边")], source: "ai" }; records.set(input.reference.path, item); return item; },
    },
  };
  return { options, calls, records, progress };
}
test("classification intent opens a scene but is not model or filesystem authorization", () => {
  assert.equal(suggestTreasureScene("按人物、事件给照片分类"), "classify");
  assert.equal(suggestTreasureScene("不要给照片分类，找照片：海边"), "memory");
  assert.equal(suggestTreasureScene("把文档分类"), null);
});
test("manual names and locations override AI per dimension without erasing other dimensions", () => {
  const image = { ...photo("a"), tags: [{ kind: "person", value: "小满" }, { kind: "place", value: "三亚" }] };
  const annotation = { photo_labels: [label("people", "单人"), label("place", "海边"), label("event", "旅行")] };
  const labels = resolvedPhotoLabels(image, annotation);
  assert.deepEqual(labels.map((item) => item.label).sort(), ["三亚", "小满", "旅行"].sort());
  assert.equal(labels.find((item) => item.label === "小满").source, "user");
  assert.equal(resolvedPhotoLabels(photo("b"), { ...annotation, confirmed_photo_labels: [] }).length, 0);
  assert.deepEqual(resolvedPhotoLabels(photo("b"), { ...annotation, confirmed_photo_labels: [label("event", "第一次看海")] }).map((item) => [item.label, item.source]), [["第一次看海", "user"]]);
});
test("batch performs one image per call, stores receipts incrementally, and reuses persisted annotations", async () => {
  const { options, calls, records, progress } = harness();
  const first = await classifyPhotoBatch(options);
  assert.equal(first.completed, 2); assert.equal(first.failed, 0); assert.equal(records.size, 2);
  assert.ok(progress.some((item) => item.completed === 1));
  assert.ok(calls.every((item) => item.evidence.images.length === 1 && !item.evidence.text && item.libraryId === "home"));
  assert.ok(!JSON.stringify(calls).includes("tasks/history.json"));
  const next = await classifyPhotoBatch(options); assert.equal(next.skipped, 2); assert.equal(calls.length, 2);
});
test("classification corrections preserve existing long human tags and bound only new labels", () => {
  const photoWithLongName = { ...photo("a"), tags: [{ kind: "person", value: "人".repeat(120) }] };
  const fields = { people: "人".repeat(120), place: "三亚，三亚", event: "第一次看海", subject: "人像" };
  assert.deepEqual(photoLabelCorrections(photoWithLongName, fields).map((item) => item.label), ["第一次看海", "三亚", "人像"]);
  assert.equal(photoWithLongName.tags[0].value.length, 120);
  assert.throws(() => photoLabelCorrections(photo("a"), fields));
  assert.throws(() => photoLabelCorrections(photo("a"), { ...fields, people: "", subject: "x\0" }));
  assert.deepEqual(photoLabelCorrections(photo("a"), { people: "", event: "", place: "", subject: "" }), []);
});
test("confirmed corrections and even empty AI decisions are not reclassified", async () => {
  const { options, calls, records } = harness([photo("a"), photo("b"), photo("c")]);
  records.set("a.png", { revision: 2, source: "user_corrected", confirmed_photo_labels: [] });
  records.set("b.png", { revision: 1, photo_labels: [] });
  records.set("c.png", { revision: 3, source: "user_corrected" });
  assert.equal((await classifyPhotoBatch(options)).skipped, 2); assert.equal(calls.length, 1); assert.equal(calls[0].expectedRevision, 3);
});
test("legacy annotations can gain structured labels using the current optimistic revision", async () => {
  const { options, calls, records } = harness([photo("a")]); records.set("a.png", { revision: 7, source: "ai" });
  assert.equal((await classifyPhotoBatch(options)).completed, 1); assert.equal(calls[0].expectedRevision, 7);
});
test("unconsented cloud, local-mode cloud, invalid scopes and oversized batches make zero model calls", async () => {
  const { options, calls } = harness();
  const cloud = { kind: "openai", model: "vision-test" };
  for (const change of [{ provider: cloud }, { provider: cloud, mode: "local", allowRemote: true }, { libraryId: "" }, { photos: Array.from({ length: PHOTO_BATCH_LIMIT + 1 }, (_, i) => photo(String(i))) }, { photos: [photo("a"), photo("a")] }]) await assert.rejects(classifyPhotoBatch({ ...options, ...change }));
  assert.equal(calls.length, 0);
  assert.equal((await classifyPhotoBatch({ ...options, provider: cloud, allowRemote: true })).completed, 2);
});
test("stop during evidence preparation prevents any upload; stop in flight allows only its existing receipt", async () => {
  const a = harness(); let active = true;
  const stopped = await classifyPhotoBatch({ ...a.options, active: () => active, prepare: async (...args) => { active = false; return a.options.prepare(...args); } });
  assert.equal(stopped.stopped, true); assert.equal(a.calls.length, 0);
  const b = harness(); active = true;
  const result = await classifyPhotoBatch({ ...b.options, active: () => active, services: { ...b.options.services, contentAnalyze: async (input) => { const value = await b.options.services.contentAnalyze(input); active = false; return value; } } });
  assert.equal(result.completed, 1); assert.equal(result.stopped, true); assert.equal(b.calls.length, 1);
});
test("per-item failure is honest and not retried; a locked or changed Home stops the batch", async () => {
  const a = harness();
  const result = await classifyPhotoBatch({ ...a.options, services: { ...a.options.services, contentAnalyze: async (input) => { if (input.reference.path === "a.png") throw new Error("CONTENT_DECODE_FAILED"); return a.options.services.contentAnalyze(input); } } });
  assert.equal(result.failed, 1); assert.equal(result.completed, 1); assert.equal(result.failures[0].path, "a.png");
  const b = harness(); let reads = 0;
  const locked = await classifyPhotoBatch({ ...b.options, services: { ...b.options.services, contentAnnotationGet: async () => { reads++; throw new Error("E32006 login required"); } } });
  assert.equal(locked.stopped, true); assert.equal(reads, 1); assert.equal(b.calls.length, 0);
  let calls = 0;
  const unsupported = await classifyPhotoBatch({ ...b.options, services: { ...b.options.services, contentAnalyze: async () => { calls++; throw new Error("CONTENT_VISION_MODEL_REQUIRED"); } } });
  assert.equal(unsupported.stopped, true); assert.equal(calls, 1); assert.equal(unsupported.failed, 1);
});
test("invalid evidence and mismatched returned references are not counted as successful", async () => {
  const a = harness([photo("a")]);
  const invalid = await classifyPhotoBatch({ ...a.options, prepare: async () => ({ text: "private unbounded context", images: [], coverage: "invalid" }) });
  assert.equal(invalid.failed, 1); assert.equal(a.calls.length, 0);
  const wrong = await classifyPhotoBatch({ ...a.options, services: { ...a.options.services, contentAnalyze: async () => ({ path: "other.png", sha256: "b".repeat(64), photo_labels: [] }) } });
  assert.equal(wrong.failed, 1); assert.equal(wrong.completed, 0);
});
