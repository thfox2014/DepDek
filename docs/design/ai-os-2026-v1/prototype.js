// An isolated, in-memory interface study. No model, file, microphone or account API.
const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const shell = $('#shell');
const draft = $('#draft');
const glyph = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
const pages = {
  chat: {
    greeting: '今天，想做点什么？', placeholder: '把想做的事，交给悟空…',
    chips: [['photos','找照片','找回上次海边旅行的照片'], ['folder','理资料','帮我准备空调维修资料'], ['list','做计划','帮我理清今天最重要的三件事']],
    demo: '帮我准备空调维修资料',
  },
  photos: {
    greeting: '想重温，哪一刻？', placeholder: '描述一张照片，或一段回忆…',
    chips: [['sun','海边','找回上次海边旅行的照片'], ['cake','生日','整理孩子生日的照片'], ['clock','成长','把孩子的照片串成成长故事']],
    demo: '整理上次海边旅行的照片',
  },
  videos: {
    greeting: '让时光，再放一遍。', placeholder: '想找哪一段，或留下什么…',
    chips: [['video','找录像','找回孩子第一次学走路的录像'], ['sparkle','挑精彩','挑出生日录像里的精彩片段'], ['play','串故事','把这次旅行的片段串成故事']],
    demo: '整理孩子生日那天的录像',
  },
  documents: {
    greeting: '找得到，也收得好。', placeholder: '找一份资料，或交代一件事…',
    chips: [['search','找文件','找空调的保修资料'], ['folder','做分类','把这些家庭资料按用途归类'], ['list','资料包','准备一份空调维修资料包']],
    demo: '准备一份空调维修资料包',
  },
};
const histories = {};
const drafts = {};
const attachments = {};
let currentPage = 'chat';
let panelOpen = false;
let currentArtifact;
let artifactSequence = 0;
let toastTimer;
let dialogFocus;

function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2800);
}

function syncDraft() {
  drafts[currentPage] = draft.value;
  $('#send').disabled = !draft.value.trim();
  draft.style.height = '64px';
  draft.style.height = `${Math.min(160, Math.max(64, draft.scrollHeight))}px`;
}

function fillDraft(text) {
  draft.value = text;
  syncDraft();
  draft.focus();
}

function closeAppearance(restoreFocus = false) {
  $('#appearance').hidden = true;
  $('#appearance-button').setAttribute('aria-expanded','false');
  if (restoreFocus) $('#appearance-button').focus();
}

function setPanel(open, artifact = currentArtifact, returnFocus = false) {
  if (artifact) currentArtifact = artifact;
  panelOpen = open;
  shell.classList.toggle('has-drawer', open);
  $('#context-drawer').hidden = !open;
  $('#drawer-scrim').hidden = !open;
  $('.panel-toggle').setAttribute('aria-expanded', String(open));
  $('.panel-toggle').setAttribute('aria-label', open ? '关闭清单' : '打开清单');
  if (open) {
    closeAppearance();
    renderDrawer();
    $('#context-drawer [data-action="close-panel"]').focus();
  } else if (returnFocus) $('.panel-toggle').focus();
}

function showDialog(title, html) {
  dialogFocus = document.activeElement;
  closeAppearance();
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  $('#info-dialog').showModal();
}

function setTheme(theme) {
  root.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
}

function setStyle(style) {
  root.dataset.style = style;
  document.querySelectorAll('[data-style-choice]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.styleChoice === style)));
}

function makeReply(text) {
  let title, reply, items;
  if (currentPage === 'photos' || /照片|相册|成长/.test(text)) {
    title = /生日/.test(text) ? '生日相册' : /成长/.test(text) ? '成长故事' : '海边相册';
    reply = '把想留下的时刻，先排成一个小故事。';
    items = ['选出最喜欢的画面', '按时间排好顺序', '加一句想留下的话'];
  } else if (currentPage === 'videos' || /录像|视频|片段/.test(text)) {
    title = /旅行/.test(text) ? '旅行短片' : '生日录像';
    reply = '先留住这几个片段，再慢慢串起来。';
    items = ['开场与家人的笑脸', '最想重看的精彩时刻', '留作结尾的一句话'];
  } else if (/今天|计划|步骤|重要/.test(text)) {
    title = '今日安排';
    reply = '先留三件事，给今天一点余地。';
    items = ['定下最重要的一件事', '为它留一段专注时间', '收尾时看一眼进展'];
  } else if (/分类|归类|理一摞/.test(text)) {
    title = '资料分类';
    reply = '按用途分三组，找起来更顺手。';
    items = ['家电与居家资料', '票据与购买凭证', '待处理的事项资料'];
  } else {
    title = '维修资料';
    reply = '先备齐这三份，预约时就从容了。';
    items = ['型号与购买日期', '发票和保修条款', '过往维修记录'];
  }
  return { role: 'assistant', text: reply, artifact: { id: ++artifactSequence, title, items: items.map((label) => ({label, done:false})) } };
}

function renderDrawer() {
  const area = $('#drawer-content');
  area.replaceChildren();
  if (!currentArtifact) {
    area.innerHTML = `<div class="drawer-empty">${glyph('list')}<p>暂时没有待办</p></div>`;
    return;
  }
  const completed = currentArtifact.items.filter((item) => item.done).length;
  area.innerHTML = `<section class="drawer-checklist"><h3></h3><p>内置示例</p><div class="checklist-items"></div><footer class="checklist-footer"><span>${completed} / ${currentArtifact.items.length}</span><button class="text-button" data-action="reset-list">重新勾选</button></footer></section>`;
  area.querySelector('h3').textContent = currentArtifact.title;
  currentArtifact.items.forEach((item, index) => {
    const label = document.createElement('label');
    label.className = 'checklist-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = item.done;
    input.dataset.checklistIndex = String(index);
    const span = document.createElement('span');
    span.textContent = item.label;
    label.append(input, span);
    area.querySelector('.checklist-items').append(label);
  });
}

function renderMessages(scrollToEnd = false) {
  const history = histories[currentPage] || [];
  const hasMessages = history.length > 0;
  shell.classList.toggle('has-conversation', hasMessages);
  $('#welcome').hidden = hasMessages;
  $('#messages').hidden = !hasMessages;
  $('#messages').replaceChildren();
  const demoButton = $('[data-action="demo"]');
  demoButton.setAttribute('aria-label', hasMessages ? '新对话' : '体验示例');
  demoButton.dataset.tip = hasMessages ? '新对话' : '体验示例';
  demoButton.innerHTML = glyph(hasMessages ? 'plus' : 'play');
  history.forEach((item) => {
    const article = document.createElement('article');
    article.className = `message is-${item.role}`;
    if (item.role === 'user') {
      const copy = document.createElement('p');
      copy.textContent = item.text;
      article.append(copy);
    } else {
      article.innerHTML = `<header class="message-heading"><img src="assets/jiaho-brand/wukong.svg" alt=""><span>悟空</span><span class="example-label">示例</span></header><div class="message-body"><p></p><button class="artifact" data-artifact="${item.artifact.id}"><span class="artifact-icon">${glyph('list')}</span><span class="artifact-copy"><b></b><small>${item.artifact.items.length} 项</small></span>${glyph('arrow-up-right')}</button></div>`;
      article.querySelector('.message-body > p').textContent = item.text;
      article.querySelector('.artifact b').textContent = item.artifact.title;
    }
    $('#messages').append(article);
  });
  $('.unread-dot').hidden = !history.some((item) => item.artifact);
  if (scrollToEnd) $('#messages').scrollTop = $('#messages').scrollHeight;
}

function selectPage(page) {
  drafts[currentPage] = draft.value;
  currentPage = page;
  setPanel(false);
  closeAppearance();
  const config = pages[page];
  document.querySelectorAll('[data-page]').forEach((button) => {
    const selected = button.dataset.page === page;
    button.classList.toggle('is-selected',selected);
    if (selected) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  $('#greeting').textContent = config.greeting;
  draft.placeholder = config.placeholder;
  draft.value = drafts[page] || '';
  $('#attachment-chip').hidden = !attachments[page];
  $('#quick-actions').innerHTML = config.chips.map(([icon,label,prompt]) => `<button data-prompt="${prompt}">${glyph(icon)}<span>${label}</span></button>`).join('');
  currentArtifact = [...(histories[page] || [])].reverse().find((item) => item.artifact)?.artifact;
  syncDraft();
  renderMessages(true);
}

function appendExchange(text) {
  const reply = makeReply(text);
  histories[currentPage] ||= [];
  histories[currentPage].push({role:'user',text}, reply);
  currentArtifact = reply.artifact;
  renderMessages(true);
  if (panelOpen) renderDrawer();
}

function send() {
  const text = draft.value.trim();
  if (!text) return;
  appendExchange(text);
  draft.value = '';
  syncDraft();
  attachments[currentPage] = false;
  $('#attachment-chip').hidden = true;
  draft.focus();
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest('.popover-anchor') && !$('#appearance').hidden) closeAppearance();
  const button = event.target.closest('button, a[data-action]');
  if (!button) return;
  if (button.dataset.page) return selectPage(button.dataset.page);
  if (button.dataset.prompt) return fillDraft(button.dataset.prompt);
  if (button.dataset.themeChoice) return setTheme(button.dataset.themeChoice);
  if (button.dataset.styleChoice) return setStyle(button.dataset.styleChoice);
  if (button.dataset.artifact) {
    const artifact = (histories[currentPage] || []).find((item) => item.artifact?.id === Number(button.dataset.artifact))?.artifact;
    if (artifact) setPanel(true,artifact);
    return;
  }
  switch (button.dataset.action) {
    case 'home': event.preventDefault(); selectPage('chat'); break;
    case 'appearance': {
      const open = $('#appearance').hidden;
      $('#appearance').hidden = !open;
      $('#appearance-button').setAttribute('aria-expanded',String(open));
      if (open) setPanel(false);
      break;
    }
    case 'close-appearance': closeAppearance(true); break;
    case 'panel': setPanel(!panelOpen, currentArtifact, panelOpen); break;
    case 'close-panel': setPanel(false,currentArtifact,true); break;
    case 'demo':
      if ((histories[currentPage] || []).length) {
        histories[currentPage] = [];
        currentArtifact = undefined;
        setPanel(false);
        renderMessages();
      } else appendExchange(pages[currentPage].demo);
      break;
    case 'attach':
      attachments[currentPage] = true;
      $('#attachment-chip').hidden = false;
      toast('已加入示例附件');
      draft.focus();
      break;
    case 'remove-attachment':
      attachments[currentPage] = false;
      $('#attachment-chip').hidden = true;
      break;
    case 'voice': fillDraft(pages[currentPage].demo); toast('示例语音已填入'); break;
    case 'reset-list':
      if (currentArtifact) currentArtifact.items.forEach((item) => { item.done = false; });
      renderDrawer();
      break;
    case 'about':
      showDialog('轻一点，少一点。', '<p>参考 2026 年更新的 Liquid Glass、Material 3 Expressive，以及内容优先的 AI 界面。保留家合的温度，把文字和控件留到需要时。</p><p>这是独立设计稿。对话、附件与清单均为内置示例，不连接真实资料、模型、麦克风或账户。</p><div class="research-links"><a href="https://developer.apple.com/news/?id=e2lxw9l1" target="_blank" rel="noreferrer">Apple · 2026</a><a href="https://m3.material.io/" target="_blank" rel="noreferrer">Google · Material</a><a href="https://microsoft.design/articles/when-outputs-are-the-experience/" target="_blank" rel="noreferrer">Microsoft · 2026</a></div>');
      break;
    case 'privacy': showDialog('仅供预览', '<p>交互只留在当前页面内存。刷新后恢复初始状态。</p><p>本页不连接模型、不读写家庭资料、不启用麦克风，也不配置真实账户。</p>'); break;
    case 'model':
    case 'settings': showDialog('模型与设置', '<p>本机助手 · 界面示意</p><p>正式版在这里管理模型与执行器。本稿没有连接模型，不需要填写密钥。</p>'); break;
    case 'workbench': showDialog('工作台', '<p>正式版保留 AI-OS 与 DepDek 工作台之间的入口。</p><p>当前为独立 HTML 外观稿，尚未接入原生工作台。</p>'); break;
    case 'lock': showDialog('锁定空间', '<p>本稿没有真实账户或空间，不执行锁定。正式界面保留此入口。</p>'); break;
    case 'close-dialog': $('#info-dialog').close(); break;
  }
});
document.addEventListener('change', (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (event.target.id === 'large-type') root.dataset.type = event.target.checked ? 'large' : 'normal';
  if (event.target.dataset.checklistIndex !== undefined && currentArtifact) {
    currentArtifact.items[Number(event.target.dataset.checklistIndex)].done = event.target.checked;
    const count = currentArtifact.items.filter((item) => item.done).length;
    $('.checklist-footer > span').textContent = `${count} / ${currentArtifact.items.length}`;
  }
});
$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); send(); });
draft.addEventListener('input', syncDraft);
draft.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('#info-dialog').open) return;
  if (!$('#appearance').hidden) closeAppearance(true);
  else if (panelOpen) setPanel(false,currentArtifact,true);
});
$('#info-dialog').addEventListener('close', () => { if (dialogFocus instanceof HTMLElement) dialogFocus.focus(); });
$('#info-dialog').addEventListener('click', (event) => {
  if (event.target !== $('#info-dialog')) return;
  const r = $('#info-dialog').getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#info-dialog').close();
});
selectPage('chat');
