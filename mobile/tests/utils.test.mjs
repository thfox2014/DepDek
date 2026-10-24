import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf,
  filterResources,
  joinResourcePath,
  validProfile,
  withinPromptLimit,
} from "../src/lib/utils.ts";

test("categories use filenames, not invented content analysis", () => {
  assert.equal(categoryOf("家里的照片.HEIC"), "照片");
  assert.equal(categoryOf("骑车.MOV"), "视频");
  assert.equal(categoryOf("发票.PDF"), "文档");
  assert.equal(categoryOf("收件.eml"), "邮件");
  assert.equal(categoryOf("家庭录音.flac"), "其他");
});
test("search covers original path and real hashes; directories are not photos", () => {
  const rows = [
    {
      id: "a",
      name: "一张照片.jpg",
      path: "相册/去年/一张照片.jpg",
      sha256: "aabbcc",
      category: "照片",
      kind: "file",
      size: 1,
    },
    {
      id: "b",
      name: "相册.jpg",
      path: "其他/相册.jpg",
      category: "照片",
      kind: "dir",
      size: 0,
    },
  ];
  assert.equal(filterResources(rows, "照片", "去年").length, 1);
  assert.equal(filterResources(rows, "全部", "AABBCC").length, 1);
  assert.equal(filterResources(rows, "照片", "").length, 1);
  assert.equal(filterResources(rows, "文档", "").length, 0);
});
test("prompt limits count UTF-8 bytes and preserve Chinese", () => {
  assert.equal(withinPromptLimit("你".repeat(5461)), true);
  assert.equal(withinPromptLimit("你".repeat(5462)), false);
  assert.equal(withinPromptLimit("  "), false);
});
test("profile reference needs a real revision and an allowed engine", () => {
  const p = {
    id: "deepseek",
    revision: 1,
    name: "DeepSeek",
    model: "configured-model",
    cloud: true,
    engine: "pi",
  };
  assert.equal(validProfile(p), true);
  assert.equal(validProfile({ ...p, revision: 0 }), false);
  assert.equal(validProfile({ ...p, revision: 1.5 }), false);
  assert.equal(validProfile({ ...p, engine: "shell" }), false);
});
test("directory entry composition does not accept traversal segments", () => {
  assert.equal(
    joinResourcePath("documents/alice", "文件.md"),
    "documents/alice/文件.md",
  );
  for (const name of ["..", ".", "../private", "a/b", "a\\b", "a\0b"])
    assert.throws(() => joinResourcePath("documents", name));
});
