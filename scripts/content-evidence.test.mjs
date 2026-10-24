import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContentEvidence, contentAgentError } from '../src/lib/contentEvidence.ts';

const file = { path: 'documents/receipt.txt', sha256: 'a'.repeat(64), category: 'documents' };
test('content extraction reads only the selected reference and records a bounded text scope', async () => {
  const calls = [], progress = [];
  const evidence = await prepareContentEvidence(file, 'current-home', {
    documentPreview: async (input) => { calls.push(input); return { kind: 'text', content: '空调购买凭证\n保修条款'.repeat(4000), sha256: file.sha256, size: 100000, truncated: true }; },
  }, (value) => progress.push(value));
  assert.equal(calls.length, 1); assert.equal(calls[0].libraryId, 'current-home'); assert.equal(calls[0].reference.path, file.path);
  assert.deepEqual(Object.keys(calls[0].reference).sort(), ['path', 'sha256']);
  assert.equal(Array.from(evidence.text).length, 24000); assert.equal(evidence.images.length, 0);
  assert.match(evidence.coverage, /已截取/); assert.ok(progress.length > 0);
});
test('unsupported, empty or changed documents cannot be presented as successful content analysis', async () => {
  for (const result of [{ kind: 'unsupported' }, { kind: 'text', content: '' }, { kind: 'text', content: 'real', sha256: 'b'.repeat(64) }]) {
    await assert.rejects(prepareContentEvidence(file, 'home', { documentPreview: async () => ({ sha256: file.sha256, size: 10, truncated: false, ...result }) }, () => {}));
  }
});
test('unsupported vision models and source conflicts have actionable, non-success states', () => {
  assert.match(contentAgentError(new Error('CONTENT_VISION_MODEL_REQUIRED')), /支持图片输入/);
  assert.match(contentAgentError(new Error('content revision conflict')), /已保留最新版本/);
  assert.match(contentAgentError(new Error('CONTENT_INVALID_RESULT')), /未保存/);
});
