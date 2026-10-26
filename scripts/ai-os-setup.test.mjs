import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { BUILTIN_PROVIDER, customSetupProvider, isBuiltinProvider, isLocalProvider, providerAllowedForMode, saveSetupProvider } from '../src/lib/aiOsSetup.ts';
import { bitBayEmail, bitBayError, passwordBytes } from '../src/lib/bitbay.ts';

const custom = { kind: 'custom', name: 'My model', endpoint: 'https://models.example.test/v1/', model: 'example-model', apiKey: 'test-only-not-a-real-key' };
function fixture(initial = {}) {
  let settings = structuredClone({ providers: {}, agents: [], ...initial });
  const calls = [];
  return {
    calls, read: () => structuredClone(settings),
    port: {
      async settingsGet() { calls.push('get'); return structuredClone(settings); },
      async vaultInitHome() { calls.push('init'); settings.last_root = '/test-home'; return settings.last_root; },
      async vaultSetRoot(path) { calls.push('root'); settings.last_root = path; return path; },
      async settingsSet(next) {
        calls.push('save'); settings = structuredClone(next);
        for (const provider of Object.values(settings.providers)) {
          if (provider.api_key && !provider.api_key.startsWith('$secret:')) provider.api_key = '$secret:providers.test-ref';
        }
      },
    },
  };
}

test('first save preserves last_root created by Vault and returns only encrypted reference', async () => {
  const f = fixture(); const saved = await saveSetupProvider(custom, f.port);
  assert.equal(f.read().last_root, '/test-home');
  assert.equal(saved.provider.api_key, '$secret:providers.test-ref');
  assert.equal(saved.provider.base_url, 'https://models.example.test/v1');
  assert.deepEqual(f.calls, ['get', 'init', 'get', 'save', 'get']);
  assert.equal(f.read().agents[0].provider_name, saved.name);
  assert.deepEqual(f.read().agents[0].enabled_skills, []);
});

test('rebind only shell agent and preserve other agents, policies, providers, and roots', async () => {
  const other = { id: 'someone-else', label: 'Other', provider_name: 'old', engine: 'pi' };
  const shell = { id: 'depdek-os-assistant', label: 'My assistant', provider_name: 'old', engine: 'deepseek-harness', enabled_skills: ['photos'], system_prompt: 'keep this role' };
  const old = { kind: 'openai-compatible', base_url: 'https://old.example.test/v1', model: 'old', api_key: '$secret:providers.old' };
  const f = fixture({ last_root: '/existing-home', obsidian_root: '/obsidian', agents: [other, shell], providers: { old } });
  await saveSetupProvider(custom, f.port);
  assert.equal(f.read().last_root, '/existing-home'); assert.equal(f.read().obsidian_root, '/obsidian');
  assert.deepEqual(f.read().providers.old, old); assert.deepEqual(f.read().agents[0], other);
  assert.deepEqual(f.read().agents[1], { ...shell, provider_name: 'My model' });
  assert.ok(!f.calls.includes('init'));
});

test('builtin selection is explicit and does not overwrite a name collision', async () => {
  const original = { kind: 'openai-compatible', base_url: 'https://another.example.test/v1', model: 'different' };
  const f = fixture({ providers: { 'Jiaho 本地助手': original } });
  const saved = await saveSetupProvider({ kind: 'builtin' }, f.port);
  assert.equal(saved.name, 'Jiaho 本地助手 2'); assert.ok(isBuiltinProvider(saved.provider));
  assert.deepEqual(f.read().providers['Jiaho 本地助手'], original);
  const again = await saveSetupProvider({ kind: 'builtin' }, f.port);
  assert.equal(again.name, saved.name); assert.equal(Object.keys(f.read().providers).length, 2);
});

test('existing selection keeps credential references and refuses deleted or inherited providers', async () => {
  const savedProvider = { kind: 'anthropic', model: 'saved-model', api_key: '$secret:providers.saved' };
  const f = fixture({ providers: { saved: savedProvider } });
  const saved = await saveSetupProvider({ kind: 'existing', name: 'saved' }, f.port);
  assert.deepEqual(saved.provider, savedProvider);
  for (const name of ['missing', '__proto__', 'constructor']) {
    await assert.rejects(saveSetupProvider({ kind: 'existing', name }, f.port), /已被删除/);
  }
});

test('duplicate custom name does not overwrite saved configuration', async () => {
  const f = fixture({ providers: { 'My model': BUILTIN_PROVIDER } });
  await assert.rejects(saveSetupProvider(custom, f.port), /显示名称已存在/);
  assert.deepEqual(f.read().providers['My model'], BUILTIN_PROVIDER); assert.ok(!f.calls.includes('save'));
});

test('editing a saved provider keeps its name and encrypted key unless a replacement key is entered', async () => {
  const original = { kind: 'openai-compatible', base_url: 'https://old.example.test/v1', model: 'old-model', api_key: '$secret:providers.saved' };
  const f = fixture({ providers: { 'My model': original } });
  const saved = await saveSetupProvider({ kind: 'update', name: 'My model', endpoint: 'https://new.example.test/v1/', model: 'new-model', apiKey: '' }, f.port);
  assert.equal(saved.name, 'My model');
  assert.deepEqual(saved.provider, { ...original, base_url: 'https://new.example.test/v1', model: 'new-model' });
  assert.equal(f.read().providers['My model'].api_key, '$secret:providers.saved');

  const replacement = fixture({ providers: { 'My model': original } });
  const updated = await saveSetupProvider({ kind: 'update', name: 'My model', endpoint: 'https://new.example.test/v1', model: 'new-model', apiKey: 'replacement-test-key' }, replacement.port);
  assert.equal(updated.provider.api_key, '$secret:providers.test-ref');
  assert.ok(!JSON.stringify(replacement.read()).includes('replacement-test-key'));
  assert.equal(replacement.read().providers['My model'].kind, 'openai-compatible');
});

test('editing preserves provider protocol, and a missing or mode-incompatible provider cannot be overwritten', async () => {
  const anthropic = { kind: 'anthropic', model: 'old-model', api_key: '$secret:providers.anthropic' };
  const f = fixture({ providers: { claude: anthropic } });
  const saved = await saveSetupProvider({ kind: 'update', name: 'claude', endpoint: 'https://api.anthropic.com', model: 'new-model', apiKey: '' }, f.port);
  assert.deepEqual(saved.provider, { ...anthropic, model: 'new-model' });
  await assert.rejects(saveSetupProvider({ kind: 'update', name: 'missing', endpoint: 'https://api.example.test/v1', model: 'new-model', apiKey: '' }, f.port), /已被删除/);

  const cloud = fixture({ providers: { cloud: { kind: 'openai-compatible', base_url: 'https://api.example.test/v1', model: 'model' } } });
  await assert.rejects(saveSetupProvider({ kind: 'update', name: 'cloud', endpoint: 'https://api.example.test/v1', model: 'model-2', apiKey: '' }, cloud.port, 'zh-CN', 'depdek-os-assistant', 'local'), /本地模式/);
  assert.equal(cloud.read().providers.cloud.model, 'model');
  assert.ok(!cloud.calls.includes('save'));
});

test('URL and metadata constraints reject credentials, plaintext remote HTTP, query secrets, fragments, and completion URLs', () => {
  for (const endpoint of ['http://models.example.test/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=test', 'https://example.test/v1#key', 'file:///etc/passwd', 'not-a-url', 'https://example.test/v1/chat/completions']) {
    assert.throws(() => customSetupProvider({ ...custom, endpoint }));
  }
  for (const name of ['', '__proto__', 'constructor', 'prototype', 'bad\nname']) assert.throws(() => customSetupProvider({ ...custom, name }));
  for (const model of ['', 'bad model', 'bad\nmodel']) assert.throws(() => customSetupProvider({ ...custom, model }));
  for (const apiKey of ['********', '$secret:providers.fake', 'key\nextra']) assert.throws(() => customSetupProvider({ ...custom, apiKey }));
});

test('loopback HTTP supports optional empty key but is not confused with the bundled assistant', () => {
  for (const endpoint of ['http://127.0.0.1:11434/v1', 'http://localhost:8000/v1', 'http://[::1]:8000/v1']) {
    const { provider } = customSetupProvider({ ...custom, endpoint, apiKey: '' });
    assert.equal(provider.api_key, undefined); assert.equal(isBuiltinProvider(provider), false);
  }
});

test('save failure propagates and never returns ready selection', async () => {
  const f = fixture(); f.port.settingsSet = async () => { throw new Error('test write failed'); };
  await assert.rejects(saveSetupProvider(custom, f.port), /test write failed/);
  assert.deepEqual(f.read().providers, {});
});

test('plaintext return from misconfigured store fails closed instead of marking model ready', async () => {
  const f = fixture(); f.port.settingsSet = async (settings) => { f.port.settingsGet = async () => settings; };
  await assert.rejects(saveSetupProvider(custom, f.port), /模型凭据未安全保存/);
});

test('local AI mode allows only numeric loopback providers and never replaces a cloud configuration', async () => {
  for (const base_url of ['http://127.0.0.1:11434/v1','https://127.0.0.2/v1','http://[::1]:9000/v1']) assert.equal(isLocalProvider({kind:'openai-compatible',base_url,model:'test'}), true);
  for (const base_url of ['https://api.example.test/v1','http://localhost:11434/v1','http://192.168.1.3/v1','http://127.0.0.1.example.test/v1','http://127.0.0.1/v1?key=secret','http://secret@127.0.0.1/v1','http://[::ffff:127.0.0.1]/v1']) assert.equal(isLocalProvider({kind:'openai-compatible',base_url,model:'test'}), false, base_url);
  assert.equal(providerAllowedForMode({kind:'anthropic',model:'test',api_key:'synthetic'},'local'),false);
  const f = fixture(); await assert.rejects(saveSetupProvider(custom,f.port,'zh-CN','depdek-os-assistant','local'), /本地模式/); assert.deepEqual(f.calls, []);
  const original = {kind:'openai-compatible',base_url:'https://api.example.test/v1',model:'test'};
  const old = fixture({providers:{cloud:original}});
  await assert.rejects(saveSetupProvider({kind:'existing',name:'cloud'},old.port,'zh-CN','depdek-os-assistant','local'),/本地模式/);
  assert.deepEqual(old.read().providers.cloud, original); assert.ok(!old.calls.includes('save'));
});

test('model screen renders before chat with no ready action until explicitly saved', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Setup from './src/components/AiOsModelSetup'; export const html = renderToStaticMarkup(React.createElement(Setup, {language:'zh-CN', modelReady:true, onReady:()=>{throw new Error('unexpected continuation')}}));`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.png': 'dataurl' }, logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const html = module.exports.html.replace(/src="data:[^"]+"/g, 'src="test-image"');
  assert.match(html, /选择你的对话模型/); assert.match(html, /连接自己的大模型/); assert.match(html, /保存并测试连接/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>继续配置/);
  assert.doesNotMatch(html, /<textarea/); assert.doesNotMatch(html, /localStorage|sessionStorage/);
});

test('simplified wizard renders network/account/model/mode steps, not an LLM chat', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Entry from './src/components/AiOsEntry'; export const html = renderToStaticMarkup(React.createElement(Entry, {children:React.createElement('div',null,'workspace')}));`, resolveDir:new URL('..',import.meta.url).pathname, loader:'jsx' },
    bundle:true, platform:'node', format:'cjs', write:false, loader:{'.png':'dataurl','.css':'empty'}, define:{'__APP_VERSION__':'"0.2.1"'}, logLevel:'silent',
  });
  const module={exports:{}}; new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const html=module.exports.html.replace(/src="data:[^"]+"/g,'src="test-image"');
  for (const text of ['初始配置步骤','网络','账户','大模型','工作模式','默认联网模式','v0.2.1']) assert.ok(html.includes(text),text);
  for (const absent of ['<textarea','向配置助手提问','jiaho-entry__conversation','一起把家，安顿好']) assert.ok(!html.includes(absent),absent);
  assert.match(html, /打开即检查联网状态，无需先登录账户/);
  assert.match(html, /<button[^>]*>[^<]*<svg[^]*?打开 Wi-Fi 设置/);
  assert.doesNotMatch(html, /登录后读取本机网络|先进入第 2 步配置账户/);
  assert.match(html, /BitBay 邮箱注册/);
});

test('BitBay mailbox validation and errors never reflect remote secrets or pretend local registration is platform success', () => {
  assert.equal(bitBayEmail(' TEST@Example.com '), 'test@example.com');
  for (const value of ['', 'a@b', 'a@b@c.com', 'Name <a@b.com>', 'a\n@b.com']) assert.throws(() => bitBayEmail(value));
  assert.equal(passwordBytes('密码'), 6);
  assert.match(bitBayError('BITBAY_ALREADY_REGISTERED'), /已有账户登录/);
  assert.match(bitBayError('BITBAY_OUTCOME_UNKNOWN'), /不要重复注册/);
  assert.match(bitBayError('BITBAY_LOCAL_SAVE_FAILED'), /平台验证已成功/);
  assert.ok(!bitBayError('remote error with sensitive-token').includes('sensitive-token'));
});

test('BitBay form exposes email/code/password and consent; rendering performs zero platform requests', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Setup from './src/components/BitBayAccountSetup'; const unexpected=()=>{throw new Error('unexpected request')}; export const html=renderToStaticMarkup(React.createElement(Setup,{status:{initialized:false,authenticated:false},services:{aiOsBitBaySendCode:unexpected,aiOsBitBayRegister:unexpected,aiOsBitBayLogin:unexpected},onReady:unexpected,onBusyChange:()=>{}}));`, resolveDir:new URL('..',import.meta.url).pathname, loader:'jsx' },
    bundle:true, platform:'node', format:'cjs', write:false, logLevel:'silent',
  });
  const module={exports:{}}; new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const html=module.exports.html;
  for (const text of ['邮箱地址','邮箱验证码','设置密码','确认密码','https://api.bitbay.site','已有账户登录','注册 BitBay 并继续']) assert.ok(html.includes(text),text);
  assert.match(html, /type="email"/); assert.match(html, /autoComplete="one-time-code"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>发送验证码/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>注册 BitBay 并继续/);
  assert.ok(!html.includes('尚未接入') && !html.includes('localStorage') && !html.includes('admin'));
});

test('an existing locked Home keeps BitBay fields editable and presents its unlock step first', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Setup from './src/components/BitBayAccountSetup'; const unexpected=()=>{throw new Error('unexpected request')}; export const html=renderToStaticMarkup(React.createElement(Setup,{status:{initialized:true,authenticated:false},services:{aiOsBitBaySendCode:unexpected,aiOsBitBayRegister:unexpected,aiOsBitBayLogin:unexpected},onReady:unexpected,onBusyChange:()=>{}}));`, resolveDir:new URL('..',import.meta.url).pathname, loader:'jsx' },
    bundle:true, platform:'node', format:'cjs', write:false, logLevel:'silent',
  });
  const module={exports:{}}; new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const html=module.exports.html;
  assert.match(html, /请先在上方解锁/);
  assert.match(html, /<input[^>]*type="email"[^>]*>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*>/);
  assert.doesNotMatch(html, /<input[^>]*(?:type="email"|type="checkbox")[^>]*disabled=""/);
  assert.match(html, /解锁后注册 BitBay/);
});
