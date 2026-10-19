import test from "node:test";
import assert from "node:assert/strict";
import { photoAge, photoQueryFromText, photoTagsFromText, storyDraft, storyFrames, suggestTreasureScene } from "../src/lib/treasure.ts";

test("photo intent suggests a scene without treating unrelated or negated requests as tasks", () => {
  assert.equal(suggestTreasureScene("把孩子0到18岁的照片串成成长影片"), "story");
  assert.equal(suggestTreasureScene("帮我挑选连拍照片，留下最好的一张"), "review");
  assert.equal(suggestTreasureScene("找回海边的照片"), "memory");
  assert.equal(suggestTreasureScene("不要做成长影片，找海边照片"), "memory");
  assert.equal(suggestTreasureScene("分析一下下周的待办"), null);
});
test("queries and editable annotations require explicit user text, with valid capture dates", () => {
  assert.equal(photoQueryFromText("找照片：海边"), "海边");
  assert.equal(photoQueryFromText("找到“生日”的照片"), "生日");
  assert.equal(photoQueryFromText("随便找些照片"), undefined);
  assert.deepEqual(photoTagsFromText("人物是小满，地点是三亚，事件是第一次看海"), { person: "小满", place: "三亚", event: "第一次看海" });
  assert.equal(photoTagsFromText("人物不是小满"), null);
  assert.equal(photoTagsFromText("拍摄日期是2026-02-30"), null);
});
test("age calculation uses confirmed dates and handles birthday boundaries and unknown dates", () => {
  assert.equal(photoAge("2026-02-11", "2008-02-12"), 17);
  assert.equal(photoAge("2026-02-12", "2008-02-12"), 18);
  assert.equal(photoAge("2007-01-01", "2008-02-12"), null);
  assert.equal(photoAge("2026-02-30", "2008-02-12"), null);
  assert.equal(photoAge("", "2008-02-12"), null);
});
test("story drafts reference originals, keep date gaps and never claim video output", () => {
  const photo = (name, date) => ({ file: { path: name, sha256: name.repeat(64).slice(0, 64) }, tags: date ? [{ kind: "captured_date", value: date }] : [] });
  const photos = [photo("b", "2026-02-12"), photo("a", "2008-02-12"), photo("c", "")];
  assert.deepEqual(storyFrames(photos, "2008-02-12").map((item) => item.age), [0, 18, null]);
  const draft = storyDraft(photos, "我们的故事", "2008-02-12");
  assert.equal(draft.frames.length, 3); assert.equal(draft.missing_ages.length, 17);
  assert.equal(draft.status, "selection_draft"); assert.equal(draft.output, null);
  assert.equal(draft.frames[2].captured_date, null); assert.equal(draft.frames[2].age, null);
  assert.ok(!JSON.stringify(draft).includes("base64"));
});
