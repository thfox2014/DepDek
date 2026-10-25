import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { ensureAiOsRoom, makeRoomAgent, roomMembers, roomStartupAgents, ROOM_AGENT_ID, followUpClues, submitsChat, sessionSettingsChanged } from '../src/lib/aiOsRoom.ts';
import { BUILTIN_PROVIDER, saveSetupProvider } from '../src/lib/aiOsSetup.ts';
import { roomProviderFallback, roomModelLabel } from '../src/lib/roomModel.ts';

const initial = () => ({ providers: { local: { ...BUILTIN_PROVIDER } }, last_root: '/family' });
const cloud = { kind: 'openai-compatible', base_url: 'https://models.example.test/v1', model: 'synthetic-model' };
test('unavailable or absent local model defaults to an existing public model only in online mode', () => {
  const settings = { providers: { local: BUILTIN_PROVIDER, cloud } };
  const failed = { local: { state: 'unavailable', reason: 'unreachable' } };
  assert.equal(roomProviderFallback(settings, 'local', 'online', failed, true), 'cloud');
  assert.equal(roomProviderFallback({ providers: { cloud } }, '', 'online', {}, true), 'cloud');
  assert.equal(roomProviderFallback(settings, 'local', 'local', failed, true), '');
  assert.equal(roomProviderFallback(settings, 'local', 'online', failed, false), '');
  assert.equal(roomProviderFallback({ providers: {} }, '', 'online', {}, true), '');
});
test('local detection must finish before fallback; a healthy local service and explicit public selection are retained', () => {
  const settings = { providers: { local: BUILTIN_PROVIDER, cloud } };
  for (const state of ['checking', 'unknown', 'available']) assert.equal(roomProviderFallback(settings, 'local', 'online', { local: { state, reason: 'synthetic' } }, true), 'local');
  assert.equal(roomProviderFallback(settings, 'cloud', 'online', { local: { state: 'available', reason: 'model_listed' } }, true), 'cloud');
  assert.equal(roomModelLabel({ state: 'unavailable', reason: 'unauthorized' }), '密钥待检查');
  assert.equal(roomModelLabel({ state: 'unknown', reason: 'unsupported_endpoint' }), '待验证');
});
test('room seeds only Wukong without granting tool access or changing data roots', () => {
  const settings = ensureAiOsRoom(initial());
  assert.deepEqual(roomMembers(settings).map((item) => item.name), ['悟空']);
  assert.equal(settings.agents.length, 1);
  assert.equal(settings.agents[0].id, ROOM_AGENT_ID);
  assert.equal(settings.last_root, '/family');
  for (const agent of settings.agents) { assert.deepEqual(agent.enabled_skills, []); assert.equal(agent.provider_name, 'local'); }
  assert.deepEqual(ensureAiOsRoom(settings), settings);
});
test('existing roles, providers, tools, engines and custom agents are preserved', () => {
  const agent = { ...makeRoomAgent(ROOM_AGENT_ID, 'custom'), label: '我的悟空', engine: 'deepseek-harness', system_prompt: 'My role', enabled_skills: ['photos'], config_dir: 'agents/me' };
  const settings = { ...initial(), obsidian_root: '/notes', providers: { ...initial().providers, custom: { kind: 'anthropic', model: 'my-model', api_key: '$secret:providers.mine' } }, agents: [agent, { ...agent, id: 'other', label: 'Other' }] };
  const result = ensureAiOsRoom(settings);
  assert.deepEqual(result.agents.slice(0, 2), settings.agents); assert.deepEqual(result.providers, settings.providers);
  assert.equal(result.obsidian_root, '/notes'); assert.equal(result.agents.length, 2);
  assert.deepEqual(roomMembers(result).map((item) => item.name), ['我的悟空', 'Other']); assert.deepEqual(settings.agents.length, 2);
});
test('saved agents appear in the box without auto-starting their sessions or changing settings', () => {
  const originals = ['jiaho-bajie', 'jiaho-master', 'jiaho-shaseng', 'custom'].map((id) => ({ ...makeRoomAgent(ROOM_AGENT_ID, 'local'), id, label: id, config_dir: `agents/${id}` }));
  const settings = { ...initial(), agents: originals };
  const next = ensureAiOsRoom(settings);
  assert.deepEqual(next.agents.slice(0, 4), originals);
  assert.deepEqual(settings.agents, originals);
  assert.deepEqual(roomMembers(next).map((item) => item.id), [ROOM_AGENT_ID, ...originals.map((agent) => agent.id)]);
  assert.deepEqual(roomStartupAgents(next).map((item) => item.id), [ROOM_AGENT_ID]);
  assert.deepEqual(ensureAiOsRoom(next), next);
});
test('only generated legacy setup identity is migrated and no provider is invented', () => {
  const original = { providers: {}, agents: [] }; assert.equal(ensureAiOsRoom(original), original);
  const result = ensureAiOsRoom({ ...initial(), agents: [{ id: ROOM_AGENT_ID, label: '家合助手', provider_name: 'local', system_prompt: '你是家合，一个亲切可靠的家庭 AI 配置助手。请用中文交流。' }] });
  assert.equal(result.agents[0].label, '悟空'); assert.match(result.agents[0].system_prompt, /你是悟空/);
});
test('full workbench can still configure a retained custom agent without rebinding Wukong', async () => {
  let settings = ensureAiOsRoom(initial()); settings.providers.other = { ...BUILTIN_PROVIDER, model: 'other-model' }; const wukong = structuredClone(settings.agents[0]);
  settings.agents.push({ ...makeRoomAgent(ROOM_AGENT_ID, 'local'), id: 'custom', label: 'Custom' });
  const port = { settingsGet: async () => structuredClone(settings), settingsSet: async (next) => { settings = structuredClone(next); }, vaultInitHome: async () => '/family', vaultSetRoot: async (path) => path };
  await saveSetupProvider({ kind: 'existing', name: 'other' }, port, 'zh-CN', 'custom');
  assert.deepEqual(settings.agents[0], wukong); assert.equal(settings.agents[1].id, 'custom'); assert.equal(settings.agents[1].provider_name, 'other');
});
test('same-name model changes require fresh runtime sessions', () => {
  const before = ensureAiOsRoom(initial()); const after = structuredClone(before);
  assert.equal(sessionSettingsChanged(before, after, ROOM_AGENT_ID), false);
  after.providers.local.model = 'new-model'; assert.equal(sessionSettingsChanged(before, after, ROOM_AGENT_ID), true);
  after.providers.local = { ...before.providers.local, api_key: '$secret:providers.rotated' };
  assert.equal(sessionSettingsChanged(before, after, ROOM_AGENT_ID), true);
});
test('IME confirmation and Shift Enter never submit a chat', () => {
  assert.equal(submitsChat('Enter', false, true), false); assert.equal(submitsChat('Enter', true, false), false);
  assert.equal(submitsChat('a', false, false), false); assert.equal(submitsChat('Enter', false, false), true);
});
test('follow-up suggestions are bounded deduplicated draft strings, not executable actions', () => {
  assert.deepEqual(followUpClues('# 标题\n- **核对日期**\n- **核对日期**\n1. 整理清单\n还需要什么？\n- 第四条'), ['核对日期', '整理清单', '还需要什么？']);
  assert.ok(followUpClues('- ' + '长'.repeat(1000))[0].length <= 100);
});
test('native entry renders the compact shell with collapsed inspector, version, voice and real runtime controls', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Room from './src/components/DepDekAiOsShell'; import {ensureAiOsRoom} from './src/lib/aiOsRoom'; import {BUILTIN_PROVIDER} from './src/lib/aiOsSetup';
      const props = {root:'/family', settings:ensureAiOsRoom({providers:{local:BUILTIN_PROVIDER}}), sessions:[], activeAgentId:null, chats:{},running:{},onSelectAgent:()=>{},onSend:async()=>{},onAbort:async()=>{},onCreateAgent:async()=>{},onSaveSettings:async()=>{},onOpenHome:()=>{}};
      export const html = renderToStaticMarkup(React.createElement(Room, props));
      export const applications = renderToStaticMarkup(React.createElement(Room, {...props, initialWorkspace:'applications'}));
      export const entertainment = renderToStaticMarkup(React.createElement(Room, {...props, initialWorkspace:'entertainment'}));`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.png': 'dataurl', '.css': 'empty' }, define: { '__APP_VERSION__': '"0.2.1"' }, logLevel: 'silent',
  });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const html = module.exports.html;
  for (const text of ['ai-room--modern', 'is-panel-collapsed', 'data-theme="light"', 'data-appearance="glass"', '今天，想做点什么？', '找照片', '理资料', '做计划', '悟空，盒内共有 1 位 Agent', 'aria-label="数据"', 'aria-label="娱乐"', 'Agent 列表', '聊天区域', '操作面板', '语音输入', '当前 Agent 执行器', '当前 Agent 模型', '使用公域大模型', '家庭文件不会自动上传', '本地大模型', 'v0.2.1']) assert.ok(html.includes(text), text);
  const nav = html.match(/<nav[^>]*aria-label="主菜单"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]), ['悟空，盒内共有 1 位 Agent', '智能体', '资料', '数据', '娱乐']);
  assert.ok(!html.includes('aria-label="应用与 Agent Store"'));
  assert.ok(module.exports.applications.includes('data-workspace="applications"') && module.exports.applications.includes('agent-store-grid'));
  assert.ok(!module.exports.applications.includes('is-agents-open'));
  assert.ok(module.exports.entertainment.includes('data-workspace="entertainment"') && module.exports.entertainment.includes('aria-label="娱乐面板"'));
  assert.ok(module.exports.entertainment.includes('aria-label="娱乐分类"') && module.exports.entertainment.includes('影视'));
  assert.ok(!module.exports.entertainment.includes('video-panel'));
  for (const text of ['八戒', '师傅', '沙僧', '西游协作室']) assert.ok(!html.includes(text), text);
  assert.ok(!html.includes('class="os-shell')); assert.ok(!html.includes('dangerouslySetInnerHTML'));
  assert.ok(!html.includes('LIVE CONTEXT')); assert.ok(!html.includes('YOUR EVERYDAY COMPANION'));
});
test('Webdesk core entry also exposes only Wukong without changing business configuration', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Room from './webdesk/web/src/apps/AgentCore'; export const html=renderToStaticMarkup(React.createElement(Room,{initial:{enabled:true,workspace_id:'synthetic',engines:['pi','deepseek-harness'],store:{initialized:false,locked:true},profiles:[],cloud_hosts:[],household_enabled:false,worker_mode:'disabled',computer_enabled:false}}));`, resolveDir:new URL('..',import.meta.url).pathname,loader:'jsx' },
    bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom/server','react/jsx-runtime'],loader:{'.png':'dataurl','.css':'empty'},define:{'import.meta.env.VITE_WEBDESK_DEMO':'"0"'},logLevel:'silent',
  });
  const module={exports:{}}; new Function('require','module','exports','window',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports,{location:{search:''}});
  for (const text of ['悟空','家庭资料管家']) assert.ok(module.exports.html.includes(text),text);
  for (const text of ['八戒','师傅','沙僧']) assert.ok(!module.exports.html.includes(text),text);
});
