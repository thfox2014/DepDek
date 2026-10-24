/* A deliberately local, in-memory prototype. No requests or application APIs. */
const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const workbench = $('.workbench');
const draft = $('#draft');
const pages = {
  chat: {
    title: '悟空的会客室', subtitle: '家庭资料管家', label: '悟空 · 家庭资料管家',
    eyebrow: '很高兴，又见到你', greeting: '悟空在，交给我吧。',
    description: '找文件、理资料，<br class="compact-break">留住和家有关的重要信息。',
    prompts: [
      ['list', '帮我理清今天最重要的事'],
      ['bulb', '把这个想法拆成可执行步骤'],
      ['folder', '帮我整理一份资料清单'],
    ],
    noteTitle: '重要的事，<br>都替你记着。',
    noteCopy: '聊起之后，需要补充和确认的内容，会收在这里。',
    samplePrompt: '帮我整理空调维修需要的资料',
    response: '我们可以先把需要的资料列清楚，再一步一步准备。',
    items: ['空调型号与购买日期', '购买发票和保修条款', '过去的维修记录'],
    artifact: '空调维修 · 资料清单',
  },
  photos: {
    title: '家的相册', subtitle: '照片与我们的故事', label: '相册 · 悟空陪你找回忆',
    eyebrow: '让时光，有处安放', greeting: '想找回，哪一刻？',
    description: '找一张照片，留下一个瞬间，<br class="compact-break">把成长的故事慢慢串起来。',
    prompts: [
      ['image', '找照片：我们去海边的那一次'],
      ['check-circle', '帮我挑选值得保留的照片'],
      ['clock', '把孩子的照片串成成长故事'],
    ],
    noteTitle: '一张照片，<br>一个家的故事。',
    noteCopy: '找回、挑选、串成故事。你的回忆，由你慢慢选。',
    samplePrompt: '我想把上次海边旅行的照片整理成相册',
    response: '可以。先想好这本相册想留下什么，再决定照片的顺序。',
    items: ['出发与路上的小片段', '海边玩耍和一家人的合照', '想写在照片旁边的一句话'],
    artifact: '海边旅行 · 相册提纲',
  },
  videos: {
    title: '家的放映室', subtitle: '有声有色的回忆', label: '视频 · 留住有声的时光',
    eyebrow: '有些时光，值得重播', greeting: '想再听见，哪段时光？',
    description: '重看一段录像，挑出精彩，<br class="compact-break">把家人的片段慢慢串起来。',
    prompts: [
      ['play', '找回孩子第一次学走路的录像'],
      ['video', '帮我挑出生日录像里的精彩片段'],
      ['clock', '把这次旅行的片段串成故事'],
    ],
    noteTitle: '声音和笑脸，<br>都好好留着。',
    noteCopy: '想重看哪一段，就从那段时光开始。',
    samplePrompt: '我想整理孩子生日那天的录像',
    response: '我们可以先列一个片段清单，把最想保留的时刻放进去。',
    items: ['大家到齐，布置生日桌', '点蜡烛、唱歌和许愿', '家人的祝福与孩子的笑声'],
    artifact: '生日录像 · 选片清单',
  },
  documents: {
    title: '家的资料柜', subtitle: '找得到，收得好，用得上', label: '资料 · 悟空帮你理清',
    eyebrow: '重要资料，各得其所', greeting: '你要找什么，或办什么？',
    description: '不用记住放在哪里。<br class="compact-break">把要做的事，慢慢说给悟空。',
    prompts: [
      ['search', '找一份：家里空调的保修资料'],
      ['folder', '理一摞：把这些资料按用途归类'],
      ['list', '办一件事：准备一份维修资料包'],
    ],
    noteTitle: '零散的资料，<br>一件件收好。',
    noteCopy: '原文、整理依据和待补充资料，会放在这里。',
    samplePrompt: '帮我准备一份家电维修资料包',
    response: '先准备一个清单，之后再逐项核对手上的资料。',
    items: ['需要维修的家电型号和故障描述', '购买凭证、保修卡和说明书', '预约维修时需要确认的问题'],
    artifact: '家电维修 · 准备清单',
  },
};
let currentPage = 'chat';
let panelOpen = window.matchMedia('(min-width: 1101px)').matches;
const drafts = {};
const conversations = {};
let noticeTimer;
let returnFocus;

const glyph = (name, extra = '') => `<svg aria-hidden="true" ${extra}><use href="#${name}"/></svg>`;

function notify(text) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = text;
  $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 5500);
}

function syncDraft() {
  $('#send').disabled = !draft.value.trim();
  drafts[currentPage] = draft.value;
}

function useDraft(text) {
  draft.value = text;
  syncDraft();
  draft.focus();
}

function setPanel(open) {
  panelOpen = open;
  const mobile = window.matchMedia('(max-width: 1100px)').matches;
  workbench.classList.toggle('is-panel-collapsed', !open && !mobile);
  workbench.classList.toggle('is-panel-mobile-open', open && mobile);
  const toggle = $('.header-panel-button');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? '收起操作面板' : '展开操作面板');
  $('#inspector').inert = !open;
}

function showDialog(title, html) {
  returnFocus = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-content').innerHTML = html;
  if (!$('#info-dialog').open) $('#info-dialog').showModal();
}

function closeDialog() {
  $('#info-dialog').close();
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
}

function showAbout() {
  showDialog('经典拟物，熟悉的温度。', `
    <p>在已有浅色、深色之外，探索第三种「经典拟物」外观。借鉴 iPhone 4 时期的材质和触感，为家合的日常对话保留熟悉的三栏结构。</p>
    <div class="material-swatches"><span>缝线皮革</span><span>细织亚麻</span><span>纸质便笺</span></div>
    <p><b>图标：</b>玻璃高光、柔和投影与明确的物件隐喻。照片像一张相纸，资料像一本记事本，视频像一块场记板。</p>
    <p><b>阅读：</b>材质集中在界面边缘，中央对话保持奶油纸色和清楚的中文排版。家合 Logo 与悟空形象沿用原项目。</p>
    <p><b>范围：</b>这是独立 HTML 外观稿。浅/深色为同一结构的对照预览。按钮只演示页面内交互，不连接真实模型、资料、设备或账户。</p>
  `);
}

function showChecklist() {
  const page = pages[currentPage];
  showDialog(page.artifact, `<p><span class="example-tag">示例清单</span></p><ul>${page.items.map((item) => `<li>${item}</li>`).join('')}</ul><p>这些内容是界面内置示例，没有查询或修改你的资料。</p>`);
}

function renderMessages() {
  const list = conversations[currentPage] || [];
  $('#welcome').hidden = list.length > 0;
  $('#messages').hidden = list.length === 0;
  $('#messages').replaceChildren();
  list.forEach((item) => {
    const article = document.createElement('article');
    article.className = `message ${item.role === 'user' ? 'is-user' : 'is-assistant'}`;
    if (item.role === 'user') {
      const copy = document.createElement('p');
      copy.textContent = item.text;
      article.append(copy);
    } else {
      article.innerHTML = `<span class="message-avatar"><img src="assets/jiaho-brand/wukong.svg" alt="悟空"></span><div class="message-content"><small>悟空 <span class="example-tag">示例回复</span></small><p></p>${item.items ? `<ul>${item.items.map((text) => `<li>${text}</li>`).join('')}</ul>` : ''}${item.artifact ? `<div class="sample-artifact"><span class="app-icon icon-documents">${glyph('paper-lines')}</span><div><b>${item.artifact}</b><small>内置演示 · 尚未读取任何资料</small></div><button data-action="view-artifact">查看清单 ›</button></div>` : ''}</div>`;
      article.querySelector('.message-content > p').textContent = item.text;
    }
    $('#messages').append(article);
  });
  $('#sample-label').textContent = list.length ? '回到欢迎页' : '看看示例对话';
  $('#note-title').innerHTML = list.length ? '先列好清单，<br>再一件件来。' : pages[currentPage].noteTitle;
  $('#note-copy').textContent = list.length ? '示例清单已放在对话中，可以打开查看。没有读取或整理真实文件。' : pages[currentPage].noteCopy;
}

function selectPage(id) {
  drafts[currentPage] = draft.value;
  currentPage = id;
  const page = pages[id];
  document.querySelectorAll('[data-page]').forEach((button) => {
    const selected = button.dataset.page === id;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#room-title').textContent = page.title;
  $('#room-subtitle').textContent = page.subtitle;
  $('#section-label').textContent = page.label;
  $('#eyebrow').textContent = page.eyebrow;
  $('#greeting').textContent = page.greeting;
  $('#welcome-description').innerHTML = page.description;
  $('#starters').innerHTML = page.prompts.map(([icon, text]) => `<button data-prompt="${text}">${glyph(icon)}<span>${text}</span>${glyph('chevron')}</button>`).join('');
  draft.value = drafts[id] || '';
  syncDraft();
  renderMessages();
  $('#notice').hidden = true;
  $('#conversation-scroll').scrollTop = 0;
}

function setTheme(theme) {
  root.dataset.theme = theme;
  document.querySelectorAll('[data-set-theme]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.setTheme === theme));
  });
  $('#trim-theme').textContent = { classic: 'CLASSIC EDITION', light: 'LIGHT EDITION', dark: 'DARK EDITION' }[theme];
}

function sendDraft() {
  const text = draft.value.trim();
  if (!text) return;
  const page = pages[currentPage];
  conversations[currentPage] ||= [];
  conversations[currentPage].push(
    { role: 'user', text },
    { role: 'assistant', text: `收到。这是外观稿中的示例回复，用来展示对话与清单的排版。${page.response}`, items: page.items, artifact: page.artifact },
  );
  draft.value = '';
  syncDraft();
  renderMessages();
  $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight;
  draft.focus();
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button, a[data-action]');
  if (!button) return;
  if (button.dataset.setTheme) return setTheme(button.dataset.setTheme);
  if (button.dataset.page) return selectPage(button.dataset.page);
  if (button.dataset.prompt) return useDraft(button.dataset.prompt);
  switch (button.dataset.action) {
    case 'home':
      event.preventDefault();
      selectPage('chat');
      break;
    case 'about': showAbout(); break;
    case 'toggle-panel':
      setPanel(!panelOpen);
      if (!panelOpen) $('.header-panel-button').focus();
      break;
    case 'close-dialog': closeDialog(); break;
    case 'sample': {
      if ((conversations[currentPage] || []).length) conversations[currentPage] = [];
      else {
        const page = pages[currentPage];
        conversations[currentPage] = [
          { role: 'user', text: page.samplePrompt },
          { role: 'assistant', text: `${page.response}下面是内置的演示清单。`, items: page.items, artifact: page.artifact },
        ];
      }
      renderMessages();
      $('#conversation-scroll').scrollTop = 0;
      break;
    }
    case 'view-artifact': showChecklist(); break;
    case 'voice':
      useDraft(pages[currentPage].samplePrompt);
      notify('已填入示例语音草稿，未启动麦克风。');
      break;
    case 'model-info':
    case 'settings':
      showDialog('执行器与模型', '<p>正式 AI-OS 的执行器、模型连接与隐私设置入口在这里保持可达。</p><h3>本稿为独立设计预览</h3><p>本页没有配置或连接模型，不收集 API Key，不发送对话，也不读取家庭资料。当前「本机助手」只是界面示意。</p>');
      break;
    case 'workbench':
      showDialog('工作台入口', '<p>正式界面保留 AI-OS 与 DepDek 工作台之间的入口。</p><p>这份 HTML 专注于第三种外观的评审，尚未接入原生工作台。可以先切换浅色、深色和经典拟物，比较同一结构下的界面效果。</p>');
      break;
    case 'lock':
      showDialog('锁定空间', '<p>正式版的锁定入口会继续保留，外观随主题一起变化。</p><p>此处是设计预览，没有真实账户或空间，因此不会执行锁定。</p>');
      break;
    case 'tweaks': $('#tweaks').hidden = !$('#tweaks').hidden; break;
    case 'close-tweaks': $('#tweaks').hidden = true; $('[data-action="tweaks"]').focus(); break;
  }
});
$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); sendDraft(); });
draft.addEventListener('input', syncDraft);
draft.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendDraft();
  }
});
$('#material').addEventListener('change', (event) => { root.dataset.material = event.target.value; });
$('#type-scale').addEventListener('change', (event) => { root.dataset.type = event.target.value; });
$('#info-dialog').addEventListener('click', (event) => {
  if (event.target === $('#info-dialog')) {
    const rect = $('#info-dialog').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  }
});
$('#info-dialog').addEventListener('close', () => {
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#info-dialog').open) {
    if (!$('#tweaks').hidden) {
      $('#tweaks').hidden = true;
      $('[data-action="tweaks"]').focus();
    } else if (window.matchMedia('(max-width: 1100px)').matches && panelOpen) {
      setPanel(false);
      $('.header-panel-button').focus();
    }
  }
});
window.matchMedia('(max-width: 1100px)').addEventListener('change', (event) => setPanel(!event.matches));
setPanel(panelOpen);
selectPage('chat');
