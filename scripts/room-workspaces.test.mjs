import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAiOsRoom, roomMembers, ROOM_AGENT_ID, roomStartupAgents } from '../src/lib/aiOsRoom.ts';
import { BUILTIN_AGENT_STORE, installBuiltinAgent, suggestRoomWorkspace } from '../src/lib/roomWorkspaces.ts';
import { queryMusic, checkedAudio } from '../src/lib/roomMusic.ts';
const settings = () => ensureAiOsRoom({ providers: { chosen: { kind: 'openai-compatible', base_url: 'https://models.example.test/v1', model: 'synthetic', api_key: '$secret:existing' } } });
test('install persists a bounded first-party role with selected model, retains all existing records and is idempotent', () => {
  const before = settings(), original = structuredClone(before), item = BUILTIN_AGENT_STORE[0];
  const after = installBuiltinAgent(before, item.id, 'chosen');
  assert.deepEqual(before, original); assert.deepEqual(after.providers, before.providers);
  assert.deepEqual(after.agents[0], before.agents[0]); assert.equal(after.agents[1].id, item.id);
  assert.deepEqual(after.agents[1].enabled_skills, item.skills); assert.equal(after.agents[1].provider_name, 'chosen');
  assert.equal(installBuiltinAgent(after, item.id, 'chosen'), after);
  assert.deepEqual(roomMembers(after).map((agent) => agent.id), [ROOM_AGENT_ID, item.id]);
  assert.deepEqual(roomStartupAgents(after).map((agent) => agent.id), [ROOM_AGENT_ID]);
  assert.throws(() => installBuiltinAgent(before, item.id, 'unknown'));
  assert.throws(() => installBuiltinAgent(before, 'arbitrary-download-url', 'chosen'));
});
test('resident list deduplicates custom and existing IDs, preserving first saved identity', () => {
  const current = settings(); current.agents.push({ id: 'custom', label: '我的伙伴', provider_name: 'chosen' }, { id: 'custom', label: '重复', provider_name: 'chosen' });
  assert.deepEqual(roomMembers(current).map((item) => item.name), ['悟空', '我的伙伴']);
});
test('workspace hints select household scenarios or entertainment but do not treat negated intent as an action', () => {
  assert.deepEqual(suggestRoomWorkspace('看看家里的门窗安保'), { workspace: 'family', familyScene: 'security' });
  assert.deepEqual(suggestRoomWorkspace('整理家人的体检安排'), { workspace: 'family', familyScene: 'health' });
  assert.deepEqual(suggestRoomWorkspace('记下家电维护'), { workspace: 'family', familyScene: 'home' });
  assert.deepEqual(suggestRoomWorkspace('想听音乐'), { workspace: 'entertainment' });
  assert.equal(suggestRoomWorkspace('不要打开音乐，继续聊天'), null);
});
const file = (path = 'music/demo.wav') => ({ path, name: path.split('/').at(-1), sha256: 'a'.repeat(64), size: 3, category: 'other' });
test('music queries only metadata, validates Home consistency and reports bounded partial results', async () => {
  let reads = 0; const calls = [];
  const service = { vaultReadBinary: async () => { reads++; throw new Error('should not read'); }, fileIndexQuery: async (filter) => { calls.push(filter); return { items: filter.query === '.wav' ? [file(), file('music/not.wav.txt')] : [], total: filter.query === '.wav' ? 102 : 0, summary: { library_id: 'same-home' } }; } };
  const result = await queryMusic(service, '');
  assert.equal(reads, 0); assert.equal(calls.length, 4); assert.equal(result.items.length, 1); assert.equal(result.partial, true);
  let n = 0; service.fileIndexQuery = async () => ({ items: [], total: 201, summary: { library_id: String(n++) } });
  await assert.rejects(queryMusic(service, '歌曲'), /Home changed/);
});
test('music bytes must match selected hash, size and audio MIME; no URL is accepted as media input', () => {
  const valid = { size: 3, sha256: 'a'.repeat(64), mime: 'audio/wav', data_base64: 'YWJj' };
  assert.equal(checkedAudio(valid, file()).size, 3);
  for (const patch of [{ sha256: 'b'.repeat(64) }, { size: 2 }, { mime: 'text/html' }, { data_base64: 'YQ==' }]) assert.throws(() => checkedAudio({ ...valid, ...patch }, file()));
});
