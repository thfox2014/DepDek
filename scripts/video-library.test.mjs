import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { suggestVideoScene, videoQueryFromText, videoKey, videoRef, moveVideo, VIDEO_SCENES, videoError } from "../src/lib/videoLibrary.ts";
import { suggestTreasureScene } from "../src/lib/treasure.ts";
import { videoExamples, DEMO_VIDEO_SHA } from "./fixtures/nativeVideos.ts";

const bytes = readFileSync(new URL("./fixtures/treasure-assets/demo-video.mp4", import.meta.url));
test("video scenes suggest without acting, reject negatives and preserve the photo story route", () => {
  assert.equal(suggestVideoScene("找视频：海边"), "memory");
  assert.equal(suggestVideoScene("帮我挑选值得保留的视频"), "review");
  assert.equal(suggestVideoScene("把家人的视频串成一个故事"), "story");
  assert.equal(suggestVideoScene("不要整理视频，找照片：海边"), null);
  assert.equal(suggestVideoScene("帮我把照片串成成长视频"), null);
  assert.equal(suggestTreasureScene("帮我把照片串成成长视频"), "story");
  assert.equal(suggestVideoScene("我想查一下文档"), null);
  assert.equal(VIDEO_SCENES.length, 3);
});
test("video queries are explicit and story reordering never mutates originals", () => {
  assert.equal(videoQueryFromText("悟空，找视频：海边"), "海边");
  assert.equal(videoQueryFromText("帮我找「生日」的录像"), "生日");
  assert.equal(videoQueryFromText("帮我挑选精彩视频"), undefined);
  const refs = ["a", "b", "c"].map((path) => ({ path, sha256: path.repeat(64) }));
  assert.deepEqual(moveVideo(refs, 1, -1).map((ref) => ref.path), ["b", "a", "c"]);
  assert.deepEqual(moveVideo(refs, 2, 1), refs); assert.deepEqual(refs.map((ref) => ref.path), ["a", "b", "c"]);
  assert.equal(videoKey(refs[0]), `a:${"a".repeat(64)}`);
  assert.match(videoError("E32003 file exceeds the size limit"), /64 MiB/);
  assert.match(videoError("invalid params: video story revision conflict"), /已在别处更新/);
});
test("sample media is a real tiny MP4 with a truthful immutable content hash", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), DEMO_VIDEO_SHA);
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp"); assert.ok(bytes.length < 100000);
});
test("the component service supports search, verified media, keep correction and revision-safe story restore", async () => {
  const service = videoExamples(bytes.toString("base64"));
  const first = await service.videoLibraryQuery(), libraryId = first.summary.library_id;
  assert.equal(first.total, 3); assert.equal(first.items[0].revision, 0);
  const reference = videoRef(first.items[0]);
  assert.deepEqual(reference, { path: first.items[0].file.path, sha256: DEMO_VIDEO_SHA });
  const preview = await service.videoPreview({ libraryId, reference }); assert.equal(preview.size, bytes.length);
  const tags = [{ kind: "event", value: "生日" }, { kind: "selection", value: "keep" }];
  const saved = await service.videoTagsSet({ libraryId, reference, tags, expectedRevision: 0 }); assert.equal(saved.revision, 1);
  assert.equal((await service.videoLibraryQuery({ query: "生日" })).total, 1);
  await assert.rejects(service.videoTagsSet({ libraryId, reference, tags: [], expectedRevision: 0 }), /revision conflict/);
  await service.videoTagsSet({ libraryId, reference, tags: [], expectedRevision: 1 });
  assert.equal((await service.videoLibraryQuery({ query: "生日" })).total, 0);
  const references = first.items.slice(0, 2).map(videoRef), id = "01234567-0123-4123-8123-0123456789ab";
  await service.videoStoryPut({ libraryId, id, title: "我们的故事", references, expectedRevision: 0 });
  const restored = (await service.videoLibraryQuery()).stories[0]; assert.deepEqual(restored.references, references);
  assert.equal(restored.output, undefined); assert.equal(restored.revision, 1);
  await assert.rejects(service.videoStoryPut({ libraryId, id, title: "旧草稿", references, expectedRevision: 0 }), /revision conflict/);
  await assert.rejects(service.videoPreview({ libraryId: "another-home", reference }), /Home changed/);
  assert.equal((await videoExamples("", "empty").videoLibraryQuery()).total, 0);
  await assert.rejects(videoExamples("", "error").videoLibraryQuery());
});
test("production room renders video below album, three scenes, voice, inspector and version without retired agents", async () => {
  const result = await build({ stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Room from './src/components/DepDekAiOsShell'; import {ensureAiOsRoom} from './src/lib/aiOsRoom'; import {BUILTIN_PROVIDER} from './src/lib/aiOsSetup'; export const html=renderToStaticMarkup(React.createElement(Room,{preview:true,initialVideoScene:'story',root:'/family',settings:ensureAiOsRoom({providers:{local:BUILTIN_PROVIDER}}),sessions:[],activeAgentId:null,chats:{},running:{},onSelectAgent:()=>{},onSend:async()=>{},onAbort:async()=>{},onCreateAgent:async()=>{},onSaveSettings:async()=>{},onOpenHome:()=>{},videoServices:{videoLibraryQuery:async()=>{},videoPreview:async()=>{},videoTagsSet:async()=>{},videoStoryPut:async()=>{},fileIndexRefresh:async()=>{}}}));`, resolveDir: new URL("..", import.meta.url).pathname, loader: "jsx" }, bundle: true, platform: "node", format: "cjs", write: false, loader: { ".png": "dataurl", ".css": "empty" }, define: { __APP_VERSION__: '"0.2.1"' }, logLevel: "silent" });
  const module = { exports: {} }; new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const html = module.exports.html;
  for (const text of ["has-videos", "选择视频场景", "找回一段", "留下精彩", "串成故事", "保存故事清单", "语音输入", "收起视频，返回聊天", "v0.2.1"]) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('title="相册') < html.indexOf('title="视频'));
  assert.ok(html.indexOf('title="视频') < html.indexOf('title="资料'));
  assert.ok(!html.includes("八戒")); assert.ok(!html.includes("dangerouslySetInnerHTML")); assert.ok(!html.includes("autoplay"));
});
