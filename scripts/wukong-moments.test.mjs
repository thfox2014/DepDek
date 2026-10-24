import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { WUKONG_MOMENTS, createMomentBag, startMomentDirector } from '../src/lib/wukongMoments.ts';

function clock({ allowed = true, random = () => 0, initialDelay } = {}) {
  const scheduled = new Map(), shown = [];
  let id = 0, permit = allowed;
  const stop = startMomentDirector({
    schedule: (callback, delay) => { const key = ++id; scheduled.set(key, { callback, delay }); return key; },
    cancel: (key) => scheduled.delete(key), next: createMomentBag(random),
    canPlay: () => permit, show: (value) => shown.push(value), random, initialDelay,
  });
  return { scheduled, shown, stop, allow(value) { permit = value; },
    tick() { assert.equal(scheduled.size, 1); const [key, entry] = scheduled.entries().next().value; scheduled.delete(key); entry.callback(); return entry.delay; },
    delay() { return scheduled.values().next().value.delay; },
  };
}

test('all six requested performances are finite and separate from model messages', () => {
  assert.deepEqual(WUKONG_MOMENTS.map((item) => item.title), ['挥舞金箍棒', '打瞌睡', '喝茶', '筋斗云', '吃俺老孙一棒', '烦死了']);
  assert.equal(new Set(WUKONG_MOMENTS.map((item) => item.id)).size, 6);
  for (const moment of WUKONG_MOMENTS) assert.ok(moment.duration >= 4000 && moment.duration <= 6000);
});
test('shuffle bag covers all six per round and never repeats across round boundaries', () => {
  for (const random of [() => 0, () => 0.5, () => 0.99999, () => NaN, () => Infinity, () => -2]) {
    const next = createMomentBag(random), played = Array.from({ length: 120 }, () => next().id);
    for (let offset = 0; offset < played.length; offset += 6) assert.equal(new Set(played.slice(offset, offset + 6)).size, 6);
    played.slice(1).forEach((id, index) => assert.notEqual(id, played[index]));
  }
});
test('first show waits, each show expires, and later plays have a long randomized gap', () => {
  const state = clock();
  assert.equal(state.shown.length, 0); assert.equal(state.tick(), 4000);
  const first = state.shown[0]; assert.ok(first);
  assert.equal(state.delay(), first.duration); state.tick();
  assert.equal(state.shown.at(-1), null); assert.equal(state.delay(), 28000);
  state.tick(); assert.notEqual(state.shown.at(-1).id, first.id);
  state.stop(); assert.equal(state.scheduled.size, 0);
});
test('busy, hidden, selected-text or scrolled-history guard never consumes a performance', () => {
  const state = clock({ allowed: false }); state.tick();
  assert.deepEqual(state.shown, []); assert.equal(state.delay(), 28000);
  state.allow(true); state.tick(); assert.ok(state.shown.at(-1));
  state.stop();
});
test('disable and unmount cancel the only timer, remove the sticker and ignore stale callbacks', () => {
  const state = clock(); const stale = state.scheduled.values().next().value.callback;
  state.stop(); state.stop(); stale();
  assert.equal(state.scheduled.size, 0); assert.deepEqual(state.shown, [null]);
  const playing = clock(); playing.tick(); const end = playing.scheduled.values().next().value.callback;
  playing.stop(); end(); assert.equal(playing.scheduled.size, 0); assert.equal(playing.shown.length, 2);
});
test('pausing and resuming cannot bypass the cooldown', () => {
  const state = clock({ initialDelay: 42_000 }); assert.equal(state.delay(), 42_000); state.stop();
  const bounded = clock({ initialDelay: 1_000_000 }); assert.equal(bounded.delay(), 60_000); bounded.stop();
});
test('stickers reuse the flat Wukong identity and are decorative rather than chat announcements', async () => {
  const result = await build({
    stdin: { contents: `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {WukongMomentSticker} from './src/components/WukongMoment';import {WUKONG_MOMENTS} from './src/lib/wukongMoments';export const html=WUKONG_MOMENTS.map(moment=>renderToStaticMarkup(React.createElement(WukongMomentSticker,{moment})));`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  module.exports.html.forEach((html, index) => {
    assert.ok(html.includes(`data-moment="${WUKONG_MOMENTS[index].id}"`));
    assert.ok(html.includes('aria-hidden="true"')); assert.ok(html.includes('悟空小剧场'));
    assert.ok(html.includes('room-wukong')); assert.ok(html.includes(WUKONG_MOMENTS[index].line));
    for (const forbidden of ['aria-live', 'foreignObject', '<audio', '<video', '<image', '<iframe']) assert.ok(!html.includes(forbidden), forbidden);
  });
});
test('production motion honors interruption, reduced motion, cleanup and has no external assets', () => {
  const source = readFileSync(new URL('../src/components/WukongMoment.tsx', import.meta.url), 'utf8');
  const room = readFileSync(new URL('../src/components/DepDekAiOsShell.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/components/wukong-moment.css', import.meta.url), 'utf8');
  for (const guard of ['prefers-reduced-motion', 'visibilitychange', 'selectionchange', 'getSelection', 'scrollHeight', 'removeEventListener']) assert.ok(source.includes(guard), guard);
  assert.match(source, /cancel:\s*\(id\)\s*=>\s*window\.clearTimeout\(id\)/, 'clearTimeout must be called with its Window receiver');
  assert.doesNotMatch(source, /cancel:\s*window\.clearTimeout\b/, 'do not pass Window.clearTimeout as an unbound callback');
  assert.ok(room.includes('voice.recording || voice.transcribing || !!draft || saving || settingsOpen || pending.length > 0'));
  assert.ok(room.includes('aria-pressed={momentsEnabled}')); assert.ok(room.includes('hasDialogue && momentPlayer'));
  assert.ok(css.includes('prefers-reduced-motion: reduce')); assert.ok(css.includes('pointer-events: none'));
  assert.ok(!css.includes('infinite')); assert.ok(!css.includes('url('));
  assert.ok(!source.includes('api.')); assert.ok(!source.includes('invoke('));
});
