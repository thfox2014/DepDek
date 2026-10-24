// Extract the existing icon library; produce an offline single-file draft.
import { readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Images, FilmStrip, FolderSimple, SquaresFour, GearSix, LockKey, Play, Palette, SidebarSimple, X, Sun, Moon, Check, CheckCircle, ArrowUp, Plus, Cpu, CaretDown, Waveform, ShieldCheck, ListChecks, Cake, Clock, Sparkle, MagnifyingGlass, ArrowUpRight, FilePdf } from '@phosphor-icons/react';
const here = new URL('./',import.meta.url);
const icons = {photos:Images,video:FilmStrip,folder:FolderSimple,grid:SquaresFour,settings:GearSix,lock:LockKey,play:Play,palette:Palette,panel:SidebarSimple,x:X,sun:Sun,moon:Moon,check:Check,'check-circle':CheckCircle,up:ArrowUp,plus:Plus,chip:Cpu,down:CaretDown,wave:Waveform,shield:ShieldCheck,list:ListChecks,cake:Cake,clock:Clock,sparkle:Sparkle,search:MagnifyingGlass,'arrow-up-right':ArrowUpRight,file:FilePdf};
const symbols = Object.entries(icons).map(([id,Component]) => {
  const markup = renderToStaticMarkup(createElement(Component,{weight:'regular'}));
  return `<symbol id="${id}" viewBox="0 0 256 256">${markup.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</symbol>`;
}).join('\n');
let html = await readFile(new URL('index.html',here),'utf8');
const start = '<!-- ICON_SYMBOLS -->', end = '<!-- END_ICON_SYMBOLS -->';
const oldEnd = html.indexOf(end);
if (oldEnd !== -1) html = html.slice(0,html.indexOf(start)+start.length) + html.slice(oldEnd);
html = html.replace(start,`${start}\n${symbols}\n${oldEnd === -1 ? end : ''}`);
const version = (await readFile(new URL('../../../VERSION',here),'utf8')).trim();
html = html.replace(/v\d+\.\d+\.\d+/g,`v${version}`);
await writeFile(new URL('index.html',here),html);
const css = await readFile(new URL('prototype.css',here),'utf8');
const js = await readFile(new URL('prototype.js',here),'utf8');
let offline = html.replace('<link rel="stylesheet" href="prototype.css">', () => `<style>\n${css}\n</style>`).replace('<script src="prototype.js"></script>', () => `<script>\n${js}\n</script>`);
for (const [path,mime] of [['assets/jiaho-brand/logo.png','image/png'],['assets/jiaho-brand/wukong.svg','image/svg+xml']]) {
  offline = offline.replaceAll(path,`data:${mime};base64,${(await readFile(new URL(path,here))).toString('base64')}`);
}
await writeFile(new URL('AI-OS-2026-轻透.html',here),offline);
console.log('Prepared offline 2026 draft, v'+version);
