// Mechanical extraction of existing project assets; no new character or icon artwork.
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowUp, ArrowRight, ArrowLeft, CaretRight, Check, CheckCircle, House, Leaf, Folder, SlidersHorizontal, User, LockKey, CameraSlash, SidebarSimple, Moon, Sun, Microphone, Keyboard, X, Plus, Stop, FilePdf, Image, Video, Lightbulb, Clock, DownloadSimple, MagnifyingGlass, ArrowCounterClockwise, WarningCircle, Paperclip, List, Cloud, DotsThree } from '@phosphor-icons/react';
const root = new URL('./assets/', import.meta.url);
await mkdir(new URL('jiaho-brand/', root), {recursive:true});
await copyFile(new URL('../../jiaho-home-hub-v0/assets/jiaho-brand/logo.png', root), new URL('jiaho-brand/logo.png', root));
await copyFile(new URL('../../jiaho-home-hub-v0/assets/jiaho-brand/wukong.svg', root), new URL('jiaho-brand/wukong.svg', root));
const icons = {'up':ArrowUp,'arrow':ArrowRight,'back':ArrowLeft,'chevron':CaretRight,'check':Check,'check-circle':CheckCircle,'house':House,'leaf':Leaf,'folder':Folder,'sliders':SlidersHorizontal,'user':User,'lock':LockKey,'camera-slash':CameraSlash,'panel':SidebarSimple,'moon':Moon,'sun':Sun,'mic':Microphone,'keyboard':Keyboard,'x':X,'plus':Plus,'stop':Stop,'pdf':FilePdf,'image':Image,'video':Video,'bulb':Lightbulb,'clock':Clock,'download':DownloadSimple,'search':MagnifyingGlass,'undo':ArrowCounterClockwise,'warning':WarningCircle,'attachment':Paperclip,'list':List,'cloud':Cloud,'dots':DotsThree};
const symbols = Object.entries(icons).map(([name, Component]) => {
  const svg = renderToStaticMarkup(createElement(Component, {weight:'regular'}));
  return `<symbol id="${name}" viewBox="0 0 256 256">${svg.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</symbol>`;
}).join('\n');
await writeFile(new URL('icons.svg',root), `<svg xmlns="http://www.w3.org/2000/svg"><!-- Phosphor Icons, MIT, @phosphor-icons/react 2.1.10 -->\n${symbols}\n</svg>\n`);
await copyFile(new URL('../../../node_modules/@phosphor-icons/react/LICENSE',import.meta.url),new URL('PHOSPHOR-LICENSE.txt',root));
