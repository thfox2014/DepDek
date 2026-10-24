// Prepare repository icons and export an offline, single-file HTML deliverable.
import { readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowUp, CaretRight, Check, CheckCircle, House, Leaf, Folder, SlidersHorizontal, LockKey, SidebarSimple, Microphone, X, Plus, ListChecks, Lightbulb, Clock, MagnifyingGlass, ChatCircleDots, SquaresFour, GearSix, Info, Cpu, ShieldCheck, Image, FilmStrip, Play } from '@phosphor-icons/react';
const here = new URL('./', import.meta.url);
const icons = { up: ArrowUp, chevron: CaretRight, check: Check, 'check-circle': CheckCircle, house: House, leaf: Leaf, folder: Folder, sliders: SlidersHorizontal, lock: LockKey, panel: SidebarSimple, mic: Microphone, x: X, plus: Plus, list: ListChecks, bulb: Lightbulb, clock: Clock, search: MagnifyingGlass, chat: ChatCircleDots, grid: SquaresFour, gear: GearSix, info: Info, chip: Cpu, shield: ShieldCheck, image: Image, video: FilmStrip, play: Play };
const symbols = Object.entries(icons).map(([id, Component]) => {
  const markup = renderToStaticMarkup(createElement(Component, {weight: id === 'play' ? 'fill' : 'regular'}));
  return `<symbol id="${id}" viewBox="0 0 256 256">${markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</symbol>`;
}).join('\n');
const appDetails = `<symbol id="photo-scene" viewBox="0 0 40 34"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#59b7df"/><stop offset="1" stop-color="#b6e7e5"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h40v34H0z"/><circle cx="29" cy="9" r="5" fill="#fff3a1"/><path fill="#459966" d="m0 27 12-15 10 13 5-6 13 13v2H0z"/><path fill="#6fbb73" d="m0 34 18-15 22 15z"/></symbol><symbol id="paper-lines" viewBox="0 0 32 32"><path d="M7 7h18M7 13h18M7 19h18M7 25h12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>`;
const start = '<!-- ICON_SYMBOLS -->';
const end = '<!-- END_ICON_SYMBOLS -->';
let html = await readFile(new URL('index.html', here), 'utf8');
const oldEnd = html.indexOf(end);
if (oldEnd !== -1) html = html.slice(0, html.indexOf(start) + start.length) + html.slice(oldEnd);
html = html.replace(start, `${start}\n${symbols}\n${appDetails}\n${oldEnd === -1 ? end : ''}`);
const version = (await readFile(new URL('../../../VERSION', here), 'utf8')).trim();
html = html.replace(/v\d+\.\d+\.\d+/g, `v${version}`);
await writeFile(new URL('index.html', here), html);
let css = await readFile(new URL('prototype.css', here), 'utf8');
css = css.replace(/v\d+\.\d+\.\d+/g, `v${version}`);
await writeFile(new URL('prototype.css', here), css);
let js = await readFile(new URL('prototype.js', here), 'utf8');
let offline = html.replace('<link rel="stylesheet" href="prototype.css">', `<style>\n${css}\n</style>`).replace('<script src="prototype.js"></script>', `<script>\n${js}\n</script>`);
for (const [path, mime] of [['assets/jiaho-brand/logo.png', 'image/png'], ['assets/jiaho-brand/wukong.svg', 'image/svg+xml']]) {
  const uri = `data:${mime};base64,${(await readFile(new URL(path, here))).toString('base64')}`;
  offline = offline.replaceAll(path, uri);
}
await writeFile(new URL('AI-OS-经典拟物.html', here), offline);
console.log('Prepared app icons and offline HTML. Version', version);
