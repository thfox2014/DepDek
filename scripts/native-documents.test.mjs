import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { documentDuplicates, documentQuestionQuery, loadDocumentPage, documentLineChanges, missingDocumentItems, verifyDocumentDownload, suggestedDocumentGroup, collectionInput, toggleDocumentReference } from "../src/lib/documentLibrary.ts";
import { nativeDocumentExamples, samplePdf } from "./fixtures/nativeDocuments.ts";

test("only explicit document queries become lookup drafts; group suggestions remain filename hints", () => {
  assert.equal(documentQuestionQuery("悟空，找资料：滤网"), "滤网");
  assert.equal(documentQuestionQuery("帮我找一下「厨房报价」文档"), "厨房报价");
  assert.equal(documentQuestionQuery("帮我分析所有资料"), undefined);
  assert.equal(suggestedDocumentGroup({ name: "发票.pdf" }), "购买凭证");
  assert.equal(suggestedDocumentGroup({ name: "00023.pdf" }), "待归类");
});

test("document snapshots reject mixed or changed Home identities", async () => {
  const service = nativeDocumentExamples();
  const first = await loadDocumentPage(service, 0);
  assert.equal(first.catalog.items.length, 7);
  await assert.rejects(loadDocumentPage(service, 0, "another-home"), /Home changed/);
  await assert.rejects(loadDocumentPage({ ...service, documentLibraryState: async () => ({ library_id: "different", favorites: [], collections: [] }) }, 0), /Home changed/);
});

test("selecting an updated source replaces its old fingerprint instead of creating duplicate paths", () => {
  const a = { path: "docs/a.txt", sha256: "a".repeat(64) }, b = { ...a, sha256: "b".repeat(64) };
  const original = toggleDocumentReference({}, a, 1), next = toggleDocumentReference(original, b, 1);
  assert.equal(Object.values(next).length, 1); assert.equal(Object.values(next)[0].sha256, b.sha256);
  assert.deepEqual(toggleDocumentReference(next, b, 1), {});
  assert.equal(Object.values(original)[0].sha256, a.sha256);
});

test("the production component service surface supports verified reads, favorites and revision-safe undo", async () => {
  const service = nativeDocumentExamples(), { catalog, state } = await loadDocumentPage(service, 0);
  const libraryId = state.library_id, reference = { path: catalog.items[0].path, sha256: catalog.items[0].sha256 };
  const preview = await service.documentPreview({ libraryId, reference });
  assert.equal(preview.kind, "text"); assert.equal(preview.sha256, reference.sha256);
  const favorite = await service.documentFavoriteSet({ libraryId, reference, favorite: true, expectedRevision: 0 });
  assert.equal(favorite.revision, 1); assert.equal((await service.documentLibraryState()).favorites[0].favorite, true);
  await assert.rejects(service.documentFavoriteSet({ libraryId, reference, favorite: false, expectedRevision: 0 }), /revision conflict/);
  const saved = await service.documentCollectionPut({ libraryId, id: "1".repeat(32), expectedRevision: 0, title: "资料分组", kind: "organization", status: "active", references: [reference], missing: [] });
  const reverted = await service.documentCollectionPut({ ...collectionInput(libraryId, saved), status: "reverted" });
  assert.equal(reverted.status, "reverted"); assert.equal(reverted.revision, 2);
  assert.deepEqual(reverted.references, [reference]);
  assert.equal((await service.documentPreview({ libraryId, reference })).content, preview.content);
});

test("duplicate detection uses content fingerprints and text comparison never ranks versions", async () => {
  const { catalog } = await loadDocumentPage(nativeDocumentExamples(), 0);
  const groups = documentDuplicates(catalog.items); assert.equal(groups.length, 1); assert.equal(groups[0].length, 2);
  assert.equal(new Set(groups[0].map((file) => file.sha256)).size, 1);
  assert.deepEqual(documentLineChanges("第一行\n旧方案", "第一行\n新方案"), { removed: ["旧方案"], added: ["新方案"], truncated: false });
  const large = documentLineChanges("x\n".repeat(4000), "y\n".repeat(4000));
  assert.equal(large.truncated, true); assert.ok(large.added.length <= 80);
});

test("packet receipts verify gzip bytes and SHA; exported examples contain selected content and missing items", async () => {
  const service = nativeDocumentExamples(), { catalog, state } = await loadDocumentPage(service, 0);
  const file = catalog.items[0], reference = { path: file.path, sha256: file.sha256 };
  const output = await service.documentBundleExport({ libraryId: state.library_id, references: [reference], title: "我的资料包", missing: ["入场说明"] });
  const archive = gunzipSync(await verifyDocumentDownload(output));
  const entries = new Map();
  for (let offset = 0; archive[offset];) {
    const name = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/, "");
    const size = parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, ""), 8);
    entries.set(name, archive.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(entries.size, 2); assert.ok(entries.get("1.document.txt").includes("滤网"));
  assert.deepEqual(JSON.parse(entries.get("manifest.json")).missing, ["入场说明"]);
  await assert.rejects(verifyDocumentDownload({ ...output, sha256: "0".repeat(64) }), /invalid bundle receipt/);
  await assert.rejects(verifyDocumentDownload({ ...output, mime: "text/html" }), /invalid bundle receipt/);
});

test("missing lists are bounded and independent empty/error examples never silently claim success", async () => {
  assert.deepEqual(missingDocumentItems("入场说明\n\n入场说明\n路线图"), ["入场说明", "路线图"]);
  assert.throws(() => missingDocumentItems("a".repeat(121)));
  assert.throws(() => missingDocumentItems(Array.from({ length: 31 }, (_, index) => String(index)).join("\n")));
  assert.equal((await loadDocumentPage(nativeDocumentExamples("empty"), 0)).catalog.total, 0);
  const service = nativeDocumentExamples("error");
  await assert.rejects(loadDocumentPage(service, 0));
  assert.equal((await loadDocumentPage(service, 0)).catalog.total, 7);
});

test("the bundled PDF library really parses the synthetic PDF locally", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new TextEncoder().encode(samplePdf()), useSystemFonts: true, disableFontFace: true, useWasm: false });
  try {
    const pdf = await task.promise; assert.equal(pdf.numPages, 1);
    const page = await pdf.getPage(1), text = await page.getTextContent();
    assert.ok(text.items.some((item) => item.str?.includes("local document preview")));
    const view = page.getViewport({ scale: 1 }); assert.equal(view.width, 480); assert.equal(view.height, 240);
  } finally { await task.destroy(); }
});
