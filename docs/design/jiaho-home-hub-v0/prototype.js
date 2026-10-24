/* Isolated design fixture. No fetch, device, microphone, camera or account API. */
(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    house:'<path d="m3 10 9-7 9 7v10H3Zm6 10v-7h6v7"/>',
    leaf:'<path d="M20 3C8 2 3 7 4 13s7 9 12 3c3-4 4-9 4-13Z"/><path d="m3 22 12-12"/>',
    folder:'<path d="M3 6h7l2 3h9v11H3Z"/><path d="M3 6V4h7l2 2h7v3"/>',
    shield:'<path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5Z"/><path d="m8 11 3 3 5-6"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    back:'<path d="m14 5-7 7 7 7"/>',
    arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    'camera-off':'<path d="m3 3 18 18M10 5h5l2 3h4v11M17 19H3V8h3l1-2M10 11a4 4 0 0 0 5 5"/>',
    camera:'<path d="M3 8h4l2-3h6l2 3h4v12H3Z"/><circle cx="12" cy="13" r="4"/>',
    moon:'<path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
    panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v4m-4 0h8"/>',
    up:'<path d="M12 20V4m-6 6 6-6 6 6"/>',
    glasses:'<circle cx="6" cy="14" r="4"/><circle cx="18" cy="14" r="4"/><path d="M10 14h4M2 14l2-9h3m15 9-2-9h-3"/>',
    bulb:'<path d="M8 16c0-4-3-4-3-8a7 7 0 0 1 14 0c0 4-3 4-3 8Zm0 3h8m-6 3h4"/>',
    check:'<path d="m5 12 5 5L20 6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    book:'<path d="M12 5v16M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-6-2-10 1Z"/>',
    document:'<path d="M5 2h9l5 5v15H5Zm9 0v6h5M8 12h8m-8 4h8"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 5 5 3-3 5 5"/>',
    video:'<rect x="2" y="5" width="20" height="15" rx="2"/><path d="m10 9 6 4-6 4ZM2 9h20"/>',
    search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    radar:'<circle cx="12" cy="12" r="8"/><path d="m12 12 6-6M7 12a5 5 0 0 1 5-5"/><circle cx="12" cy="12" r="1"/>',
    cloud:'<path d="M6 18a5 5 0 1 1 1-10 6 6 0 0 1 11 1 4 4 0 0 1 0 9Z"/>',
    wifi:'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r="1"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    x:'<path d="m5 5 14 14M5 19 19 5"/>',
    thermometer:'<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0ZM12 7v10"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
  const paintIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
  const avatar = '<img src="assets/jiaho-brand/wukong.svg" alt="悟空">';
  const baseFiles = [
    {id:'invoice',title:'洗衣机购买凭证.pdf',type:'documents',kind:'PDF 文档',location:'我的资料 / 家电 / 洗衣机',note:'用于查找购买凭证。保修期限尚未确认。',source:'用户导入 · 示例 PDF',size:'860 KB',icon:'document'},
    {id:'warranty',title:'洗衣机保修条款.pdf',type:'documents',kind:'PDF 文档',location:'我的资料 / 家电 / 洗衣机',note:'可与购买凭证一起使用，具体条款应核对原文。',source:'用户导入 · 示例 PDF',size:'1.2 MB',icon:'document'},
    {id:'photo',title:'客厅的一个午后.jpg',type:'photos',kind:'照片',location:'我的资料 / 照片 / 日常',note:'一张客厅照片。人物、时间和地点均未确认。',source:'手机导入 · 示例照片',size:'3.4 MB',icon:'image'},
    {id:'video',title:'第一次学会骑车.mp4',type:'videos',kind:'视频',location:'我的资料 / 视频 / 片刻',note:'一段视频的整理场景示例，不含可播放的真实原片。',source:'用户导入 · 示例视频',size:'28 MB',icon:'video'},
  ];
  const createState = () => ({view:'wukong',panel:'overview',panelOpen:true,theme:'light',layout:'standard',shutter:'closed',offline:false,localMissing:false,deviceFailure:false,empty:false,cloudAllowed:false,wakeword:false,light:42,deviceActual:42,pendingLight:65,lightRevision:1,receipt:null,pendingResult:null,deviceBusy:false,habitPending:true,habitCreated:false,habitEnabled:false,habitTime:'23:00',habitLevel:20,memoryFilter:'all',memoryId:'brief',forgotten:new Set(),fileFilter:'all',fileQuery:'',fileId:'invoice',files:structuredClone(baseFiles),annotated:new Set(),draft:'',messages:[],busy:false,selectedRoom:'living',editHabit:false,pendingCloud:false});
  let state = createState(), generation = 0, toastTimer = 0;
  const rooms = {study:['书房','灯光已调暗','bulb'],bedroom:['卧室','没有人员信息','moon'],living:['客厅','有人 · 雷达','radar'],kitchen:['厨房','温度 24° · 示例','thermometer']};
  const toast = (text, undo) => {
    window.clearTimeout(toastTimer); const node = $('#toast'); node.replaceChildren(document.createTextNode(text));
    if (undo) { const button = document.createElement('button'); button.textContent = '撤销'; button.onclick = () => { undo(); node.hidden = true; }; node.append(button); }
    node.hidden = false; toastTimer = window.setTimeout(() => { node.hidden = true; }, 6000);
  };
  const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const tag = (text, warm = false) => `<span class="tag${warm ? ' warm' : ''}">${escape(text)}</span>`;
  const button = (text, action, kind = 'primary', extra = '') => `<button class="button ${kind}" data-action="${action}" ${extra}>${text}</button>`;
  const contextHead = (title, back = false) => `${back ? `<button class="context-back" data-action="overview">${icon('back')}家里此刻</button>` : ''}<div class="context-header"><h2>${title}</h2><button class="icon-button close-context" data-action="close-panel" aria-label="返回聊天">${icon('x')}</button></div>`;
  const sourceList = () => '<ul class="evidence-list"><li><time>10 月 21 日 · 23:04 · 示例</time>书房灯从 70% 调至 20%<small>来源：登记的灯光设备状态回读</small></li><li><time>10 月 20 日 · 23:02 · 示例</time>书房灯从 65% 调至 20%<small>来源：登记的灯光设备状态回读</small></li><li><time>10 月 19 日 · 23:08 · 示例</time>书房灯从 70% 调至 20%<small>只有三次线索，尚不代表固定习惯</small></li></ul>';
  function floorplan(large = false) {
    return `<div class="floorplan${large ? ' large' : ''}" role="group" aria-label="示例房间状态示意，非实测平面图">${Object.entries(rooms).map(([id, [label, subtitle, glyph]]) => `<button class="room${state.selectedRoom === id && state.panel === 'room' ? ' is-selected' : ''}" data-action="room" data-room="${id}"><span>${label}</span>${icon(glyph)}<small>${id === 'living' ? '<i class="dot"></i>' : ''}${subtitle}</small></button>`).join('')}</div><div class="plan-foot"><span>示例空间 · 非实测平面图</span><span>点房间看详情 ↗</span></div>`;
  }
  function composer() {
    return `<div class="composer-wrap"><form class="composer" id="composer"><textarea id="chat-input" rows="2" aria-label="和悟空说说话" placeholder="有什么事，慢慢说…">${escape(state.draft)}</textarea><button class="icon-button" type="button" data-action="voice" aria-label="体验语音输入，使用示例文字">${icon('mic')}</button><button class="icon-button send" type="submit" aria-label="发送演示对话" ${state.busy ? 'disabled' : ''}>${icon('up')}</button></form><div class="composer-note"><span>${icon('lock')}原型在本页演示，不发送任何内容</span><span>Enter 发送 · Shift + Enter 换行</span></div></div>`;
  }
  function renderChat() {
    return state.messages.length ? `<div class="chat-history">${state.messages.map((message) => message.role === 'user' ? `<article class="message user"><p>${escape(message.text)}</p></article>` : `<article class="message agent">${avatar}<div><small>悟空 · 示例回复</small><p>${escape(message.text)}</p>${message.action ? `<button class="inline-action" data-action="${message.action}">${escape(message.link)}${icon('chevron')}</button>` : ''}</div></article>`).join('')}${state.busy ? `<div class="typing" role="status">正在演示处理<i></i><i></i><i></i></div>` : ''}</div>${composer()}` : `<div class="hero-chat"><div class="companion">${avatar}<span><b>悟空在。</b>东西有归处，事情有着落。</span></div><h1>家里的事，<br>慢慢说。</h1><p>找一件东西，让灯光柔和一点，<br>或留下一件值得记住的小事。</p><div class="starters"><button data-prompt="我的眼镜放哪儿了？">${icon('glasses')}<span>我的眼镜放哪儿了？</span><span>↗</span></button><button data-prompt="把客厅灯调到适合阅读的亮度">${icon('bulb')}<span>把客厅调到适合阅读</span><span>↗</span></button><button data-prompt="看看你发现的睡前习惯">${icon('leaf')}<span>看看你发现的睡前习惯</span><span>↗</span></button></div></div>${composer()}`;
  }
  function renderHome() {
    return `<div class="page"><div class="page-head"><div><h1>家里，此刻。</h1><p>知道哪些是确定的，也知道哪里还不清楚。</p></div>${tag('示例状态')}</div>${floorplan(true)}<div class="room-overview"><div class="room-line">${icon('radar')}<strong>客厅有人</strong><small>毫米波存在感应 · 无身份识别</small></div><div class="room-line">${icon('bulb')}<strong>客厅灯 ${state.light}%</strong><small>${state.pendingResult ? '有一项执行结果待核实' : '设备回读 · 示例'}</small></div><div class="room-line">${icon('camera-off')}<strong>${shutterLabel()}</strong><small>${state.shutter === 'open' ? '只在本机处理' : '视觉线索不会继续更新'}</small></div></div><p class="context-copy" style="margin-top:23px">一台设备只了解它覆盖的空间；没有传感器的房间显示未知。</p></div>`;
  }
  const habitSummary = () => `工作日 ${state.habitTime}，书房灯调至 ${state.habitLevel}%。`;
  function renderMemory() {
    const candidate = state.habitPending && state.memoryFilter !== 'confirmed';
    const confirmed = state.memoryFilter !== 'pending';
    const cards = [];
    if (candidate) cards.push(`<button class="memory-row proposed" data-action="habit">${tag('发现一个可能的习惯',true)}<div class="memory-title">晚上 11 点，书房的灯会暗下来。${icon('chevron')}</div><p>最近三晚有相似的灯光变化，想问问你是否有意这样安排。</p><small>三个设备记录 · 未认定为你的偏好</small></button>`);
    const preferences = [
      ['brief','你亲口说的','回答简单一点，先给结论。','以后交流，我会优先把重点讲清楚。','示例：来自你的“请记住” · 可忘记'],
      ['archive','你确认过的','重要资料，先保留原件。','整理只生成分组或副本，不自动移动原始文件。','示例：你在初始配置中选择的整理偏好'],
    ];
    if (confirmed) for (const [id,label,title,description,source] of preferences) {
      if (!state.forgotten.has(id)) cards.push(`<button class="memory-row" data-action="memory-detail" data-id="${id}">${tag(label)}<div class="memory-title">${title}${icon('chevron')}</div><p>${description}</p><small>${source}</small></button>`);
    }
    if (confirmed && state.habitCreated) cards.push(`<button class="memory-row" data-action="habit">${tag(state.habitEnabled ? '已启用，可撤回' : '已暂停，可恢复')}<div class="memory-title">${habitSummary()}${icon('chevron')}</div><p>只调整书房灯，保留手动覆盖和暂停。</p></button>`);
    const tabs = [['all','全部'],['confirmed','已记住'],['pending','待你核对']].map(([id,label]) => `<button role="tab" aria-selected="${state.memoryFilter === id}" data-action="memory-filter" data-filter="${id}">${label}</button>`).join('');
    return `<div class="page"><div class="page-head"><div><h1>慢慢，记住重要的。</h1><p>每条记忆有来处，也可以随时忘记。</p></div>${tag('仅你可见')}</div><div class="tabs" role="tablist" aria-label="记忆分类">${tabs}</div>${cards.length ? cards.join('') : '<div class="quiet-empty">这里暂时没有记忆或待核对的事。<br><small>悟空会安静一点。</small></div>'}</div>`;
  }
  function renderFiles() {
    const visible = state.empty ? [] : state.files.filter((file) => (state.fileFilter === 'all' || file.type === state.fileFilter) && `${file.title} ${file.location}`.includes(state.fileQuery));
    return `<div class="page"><div class="page-head"><div><h1>东西，都有归处。</h1><p>原件、识别结果与记忆，分别保存。</p></div><button class="icon-button" data-action="import-example" aria-label="体验添加示例资料">${icon('plus')}</button></div><label class="file-search">${icon('search')}<input id="file-query" aria-label="查找示例资料" value="${escape(state.fileQuery)}" placeholder="找文件、照片、视频…"></label><div class="tabs" role="tablist" aria-label="资料分类">${[['all','全部'],['documents','文档'],['photos','相册'],['videos','视频']].map(([id,label]) => `<button role="tab" aria-selected="${state.fileFilter === id}" data-action="file-filter" data-filter="${id}">${label}</button>`).join('')}</div><div id="file-results">${visible.length ? visible.map((file) => `<button class="file-row" data-action="file" data-id="${file.id}"><span>${icon(file.icon)}</span><span><b>${escape(file.title)}</b><small>${escape(file.location)}</small></span><small>${file.size}</small></button>`).join('') : `<div class="quiet-empty"><span data-icon="folder"></span><div>${state.fileQuery ? '没有找到匹配的示例资料。' : '把第一份资料，安放在这里。'}</div><small>${state.empty ? '当前为空资料库演示，添加按钮只生成示例。' : '试试另一个词。'}</small></div>`}</div><p class="context-copy" style="margin-top:25px">本稿不包含真实文件。添加、标注和修正均为当前页面内的演示。</p></div>`;
  }
  function shutterLabel() { return state.shutter === 'closed' ? '镜头已物理关闭' : state.shutter === 'fault' ? '镜头状态异常 · 保持关闭' : '视觉已开启 · 仅本机'; }
  function renderSettings() {
    return `<div class="page"><div class="page-head"><div><h1>安心，把选择留给你。</h1><p>常用的照看好，重要的由你决定。</p></div></div><div class="privacy-hero">${icon(state.shutter === 'open' ? 'camera' : 'camera-off')}<h3>${shutterLabel()}</h3><p>这是模拟的硬件回报。软件不能越过已合上的遮光罩；打开镜头，需要你在机身操作。</p></div><section class="setting-section"><h2>感知，有分寸。</h2><p>关上镜头，不会替你打开其他传感器。</p><div class="setting-row"><span>说话方式<small>${state.wakeword ? '演示：本机唤醒词，仅唤醒后转写' : '默认按住说话；原型不实际录音'}</small></span><span class="tag">${state.wakeword ? '本机唤醒' : '按住说话'}</span></div><label class="setting-row"><span>使用本机唤醒词<small>开启表示同意端侧持续检测唤醒词</small></span><input type="checkbox" role="switch" data-setting="wakeword" ${state.wakeword ? 'checked' : ''}></label><div class="setting-row"><span>声纹和人脸<small>未登记，不会自动识别家人身份</small></span><span class="tag">关闭</span></div><div class="setting-row"><span>房间存在感应<small>只知道“有人”，不知道“是谁”</small></span><span class="tag">示例已允许</span></div></section><section class="setting-section"><h2>聪明，也知道边界。</h2><label class="setting-row"><span>一般问题可使用云端<small>例如公开知识与菜谱；家庭文件不随之上传</small></span><input type="checkbox" role="switch" data-setting="cloudAllowed" ${state.cloudAllowed ? 'checked' : ''}></label><div class="setting-row"><span>家庭资料与感知记录<small>默认在本机处理，新增外发范围按任务说明</small></span><span class="tag">本机</span></div><button class="quiet-link" data-action="model">查看处理方式与失效状态</button></section><section class="setting-section"><h2>带得走，也能忘记。</h2><p>记忆可以逐条查看、修正和删除。备份需要恢复验证；本原型不生成真实备份。</p><button class="button secondary" data-action="open-memory">看看悟空记得什么${icon('arrow')}</button></section></div>`;
  }
  function renderContext() {
    let html = '';
    if (state.panel === 'overview') html = `${contextHead('家里此刻')}<div class="status-line"><span class="dot"></span>只展示当前可见的示例状态</div><div style="margin-top:21px">${floorplan()}</div><div class="section-label"><span>感知与隐私</span><button class="quiet-link" data-action="privacy">查看</button></div><div class="status-line">${icon(state.shutter === 'open' ? 'camera' : 'camera-off')}${shutterLabel()}</div><p style="font-size:10px;margin:8px 0 0">${state.shutter === 'open' ? '示例画面只在端侧短暂处理。' : '雷达可感知有人，不会推断是谁。'}</p>${state.habitPending ? `<section class="suggestion">${tag('有个习惯，想和你核对',true)}<h3>晚上 11 点，<br>书房的灯会暗下来。</h3><p>三晚相似的设备记录，是否有意这样安排？</p>${button('看看这个习惯 ' + icon('arrow'),'habit','secondary')}</section>` : `<div class="divider"></div><p>${state.habitEnabled ? '睡前柔光已启用。你可以随时暂停。' : '暂时没有需要你处理的事。'}</p>`}`;
    if (state.panel === 'room') {
      const room = rooms[state.selectedRoom];
      html = `${contextHead(room[0],true)}${tag('设备状态 · 示例')}<div class="big-state"><span>${state.selectedRoom === 'living' ? '灯光亮度' : room[1]}</span>${state.selectedRoom === 'living' ? `<b>${state.light}<small>%</small></b>` : icon(room[2])}</div>${state.selectedRoom === 'living' ? lightControls() : `<p>${state.selectedRoom === 'bedroom' ? '没有开启这个房间的人员感知。未知不会被当成“无人”。' : '此处只显示已登记传感器的状态，不据此推断家人行为。'}</p>`}<div class="divider"></div><h3>这些信息从哪里来</h3><dl class="detail-grid"><dt>状态来源</dt><dd>${state.selectedRoom === 'living' ? '登记的灯光设备 / 存在雷达' : '房间内已登记的设备'}</dd><dt>人员身份</dt><dd>未知，未做身份识别</dd><dt>可见范围</dt><dd>示例空间 · 当前成员</dd></dl>`;
    }
    if (state.panel === 'light') html = `${contextHead('让灯光，刚刚好。',true)}${tag('客厅 · 示例灯光')}<div class="big-state"><span>当前亮度</span><b>${state.light}<small>%</small></b></div>${lightControls()}<div class="divider"></div><p>普通灯光调整直接执行并核对回读。语音方向或声纹不能解锁私人资料，也不能打开门锁。</p>`;
    if (state.panel === 'search') html = `${contextHead('找到一条线索',true)}${tag('最后看到 · 非实时定位',true)}<div class="asset-preview">${icon('glasses')}<div><h3>可能在客厅边柜</h3><p>这是结构化文字线索，没有保存现场照片。</p></div></div><ul class="evidence-list"><li><time>示例 · 今天 19:12</time>在客厅边柜附近检测到一副眼镜<small>来源：当时获准的端侧视觉 · 物品类别候选</small></li><li><time>当前</time>${escape(shutterLabel())}<small>关闭期间不会生成新的视觉位置线索。</small></li></ul><p style="margin-top:18px">不能确定是不是你的那副，也不能确认现在仍在那里。</p>${button('我去看看','found','secondary')}`;
    if (state.panel === 'habit') html = `${contextHead(state.habitCreated ? '睡前柔光' : '要替你记住吗？',true)}${tag(state.habitCreated ? state.habitEnabled ? '你已启用 · 演示' : '你已暂停 · 演示' : '由设备记录推测',!state.habitCreated)}<h3 style="margin-top:20px;font-size:19px;line-height:1.7">工作日 ${state.habitTime}，<br>书房灯调至 ${state.habitLevel}%。</h3><p>仅调整书房这一盏灯。手动调光后当晚不再打扰；不会控制卧室、门锁或其他电器。</p>${state.editHabit ? `<label class="input-field">时间<input id="habit-time" type="time" value="${state.habitTime}"></label><label class="input-field">亮度<input id="habit-level" type="number" min="1" max="100" value="${state.habitLevel}"></label>` : ''}${state.habitEnabled ? `<div class="receipt"><strong>${icon('check')}已启用（仅演示）</strong><p>来源：你刚才的明确选择。可以随时暂停。</p></div>${button('暂停这个习惯','pause-habit','secondary')}` : state.habitCreated ? `<div class="inline-warning">已暂停未来自动执行，原来的选择和依据仍可查看。</div>${button('重新启用睡前柔光','enable-habit','secondary')}` : state.habitPending ? `${button('启用睡前柔光','enable-habit')}<div class="button-row">${button(state.editHabit ? '恢复建议' : '改一改','edit-habit','text')}${button('先不记住','ignore-habit','text')}</div>` : '<div class="inline-warning">这条建议已忽略，不会根据相同三条记录再次生成。</div>'}<div class="divider"></div><h3>为什么这样建议</h3>${sourceList()}`;
    if (state.panel === 'memory') {
      const brief = state.memoryId === 'brief';
      html = `${contextHead('你让我记住的',true)}${tag('明确偏好 · 示例')}<h3 style="margin-top:23px;font-size:20px;line-height:1.7">${brief ? '回答简单一点，先给结论。' : '重要资料，先保留原件。'}</h3><p>${brief ? '来源：你说“请记住，以后回答简单一点，先给结论”。' : '来源：你在初始配置中选择“不移动原件，只生成分组或副本”。'}</p><dl class="detail-grid"><dt>谁能看到</dt><dd>我的私人空间</dd><dt>如何使用</dt><dd>调整交流方式 / 资料整理默认值</dd><dt>来源类型</dt><dd>用户明确选择，不是模型猜测</dd></dl>${button('忘记这条','forget-memory','secondary')}<p style="margin-top:15px;font-size:10px">忘记后停止召回，阻止同一来源自动重新生成。原始资料的删除是另一项选择。</p>`;
    }
    if (state.panel === 'privacy') html = `${contextHead('此刻，怎样感知。',true)}<div class="privacy-hero">${icon(state.shutter === 'open' ? 'camera' : 'camera-off')}<h3>${shutterLabel()}</h3><p>${state.shutter === 'fault' ? '遮光罩信号与电源回读不一致，演示系统按关闭处理，并暂停云台。' : state.shutter === 'open' ? '演示：你已在机身打开遮光罩。视觉仅在本机做短暂分析。' : '演示：机身遮光罩已合上，摄像头供电已断开。软件无法远程打开。'}</p></div><dl class="detail-grid"><dt>视觉原始数据</dt><dd>设计上限 3 秒内存窗口；不保存历史画面</dd><dt>麦克风</dt><dd>${state.wakeword ? '本机唤醒词 · 示例已选择' : '按住说话 · 默认'}</dd><dt>声纹 / 人脸</dt><dd>未开启，不推断成员身份</dd><dt>雷达</dt><dd>示例已允许，仅房间存在状态</dd><dt>关闭镜头后</dt><dd>不会自动开启麦克风或声纹</dd></dl>${button('管理安心设置','open-settings','secondary')}`;
    if (state.panel === 'model') html = `${contextHead('聪明，知道边界。',true)}<dl class="detail-grid"><dt>本地模型</dt><dd>${state.localMissing ? '不可用 · 演示' : '就绪 · 演示'}</dd><dt>公网连接</dt><dd>${state.offline ? '已断开 · 演示' : '可用 · 演示'}</dd><dt>一般问题上云</dt><dd>${state.cloudAllowed ? '你已允许' : '尚未开启'}</dd><dt>家庭感知数据</dt><dd>默认只在本机</dd></dl><p>灯光等明确指令优先走确定规则。复杂生成由模型处理；涉及身份、住址和家庭记录时，先检查内容范围，不把“去姓名”当作匿名保证。</p>${state.localMissing && (!state.cloudAllowed || state.offline) ? '<div class="inline-warning">当前没有可用的对话模型。仍可查已授权资料、查看设备状态并执行固定灯光命令。</div>' : ''}${button('查看处理偏好','open-settings','secondary')}`;
    if (state.panel === 'cloud') html = `${contextHead('这次，云端帮什么？',true)}${tag(state.offline ? '网络不可用' : state.cloudAllowed ? '已允许一般问题' : '先看处理范围',true)}<h3 style="margin-top:24px">周末素食菜单</h3><p>本演示只展示下面这句话，不附带聊天历史、家庭成员、设备记录或文件。</p><div class="inline-warning">生成两人份周末素食菜单，不使用任何家庭资料。</div><dl class="detail-grid"><dt>处理方</dt><dd>你配置的云端模型（概念位）</dd><dt>本次内容</dt><dd>上方公开任务文字</dd><dt>个人资料</dt><dd>不包含</dd></dl>${!state.cloudAllowed ? button('允许一般问题使用云端','allow-cloud', 'primary', state.offline ? 'disabled' : '') : '<p>此类一般问题后续沿用选择，不重复询问。家庭资料外发仍需说明具体范围。</p>'}${state.offline ? '<p>恢复网络后由你重新发起，系统不会自动发送。</p>' : ''}`;
    if (state.panel === 'file') {
      const file = state.files.find((item) => item.id === state.fileId) || state.files[0];
      const annotation = file.type === 'photos' ? '演示标注：客厅陈设与日常片刻。地点、人物和拍摄时间仍需来源确认。' : file.type === 'videos' ? '演示标注：户外骑车片段。人物和具体时间未确认；标题不被单独作为识别证据。' : '演示标注：这份材料可能用于资料或家电维修准备；重要日期与条款应核对原文。';
      html = `${contextHead('资料与来处',true)}${tag(file.kind)}<div class="asset-preview">${icon(file.icon)}<div><strong style="font-size:13px">${escape(file.title)}</strong><p>原型没有加载真实原件</p></div></div><p>${escape(file.note)}</p><dl class="detail-grid"><dt>当前位置</dt><dd>${escape(file.location)}</dd><dt>来源</dt><dd>${escape(file.source)}</dd><dt>大小</dt><dd>${file.size} · 示例</dd><dt>内容校验</dt><dd>正式系统复验 SHA；本稿没有虚构哈希</dd></dl>${state.annotated.has(file.id) ? `<div class="receipt"><strong>${icon('leaf')}AI 描述候选 · 示例</strong><p>${annotation}</p></div><label class="input-field">修正名称<input id="file-title" value="${escape(file.title)}" maxlength="80"></label>${button('保存我的修正','correct-file','secondary')}` : button('体验 AI 自动标注','annotate-file','secondary')}<p style="margin-top:14px;font-size:10px">标注写入派生记录，原件不修改。正式版本使用已登记的 AI Content Agent。</p>`;
    }
    $('#context').innerHTML = html; paintIcons($('#context'));
  }
  function lightControls() {
    return `<label class="input-field">调整到 <span id="light-value">${state.pendingLight}%</span><input class="range" id="light-range" type="range" min="0" max="100" value="${state.pendingLight}" ${state.deviceBusy || state.pendingResult ? 'disabled' : ''}></label><div class="range-label"><span>关灯</span><span>明亮</span></div>${button(state.deviceBusy ? '等待设备回读…' : state.pendingResult ? '先核实结果' : '调整灯光','apply-light','primary',state.deviceBusy || state.pendingResult ? 'disabled' : '')}${state.pendingResult ? `<div class="receipt unknown"><strong>${icon('clock')}结果暂不确定</strong><p>指令已提交，但回读丢失。不要重复点击；先核实实际亮度。</p>${button('重新核实设备状态','recheck-light','text')}</div>` : state.receipt ? `<div class="receipt"><strong>${icon('check')}已回读 ${state.light}% · 演示</strong><p>实际状态与目标一致；可以恢复到上次的 ${state.receipt.before}%。</p>${button('恢复上次亮度','undo-light','text')}</div>` : '<p style="font-size:10px;margin-top:12px">你的明确操作直接执行，不再多弹一次确认。</p>'}`;
  }
  function render() {
    document.body.dataset.theme = state.theme; document.body.dataset.layout = state.layout;
    $('.main').classList.toggle('is-panel-hidden', !state.panelOpen);
    $('#navigation').querySelectorAll('[data-view]').forEach((node) => { const active = node.dataset.view === state.view; node.classList.toggle('is-selected', active); active ? node.setAttribute('aria-current','page') : node.removeAttribute('aria-current'); });
    $('#memory-dot').hidden = !state.habitPending;
    $('#breadcrumb').innerHTML = `${({wukong:'悟空',home:'我的家',memory:'家的记忆',files:'我的资料',settings:'安心与设置'})[state.view]} <span>/</span> 在家`;
    $('#privacy-label').textContent = shutterLabel(); $('#privacy-status [data-icon]').dataset.icon = state.shutter === 'open' ? 'camera' : 'camera-off';
    const route = state.localMissing ? !state.offline && state.cloudAllowed ? '云端可用 · 示例' : '模型待配置' : state.offline ? '离线 · 本机可用' : '本机优先';
    $('#route-status>span:last-child').textContent = route; $('#route-status .dot').classList.toggle('is-muted', state.localMissing && (state.offline || !state.cloudAllowed));
    $('#theme-toggle').setAttribute('aria-label',state.theme === 'light' ? '切换深色模式' : '切换浅色模式'); $('#theme-toggle [data-icon]').dataset.icon = state.theme === 'light' ? 'moon' : 'sun';
    $('#panel-toggle').setAttribute('aria-expanded',String(state.panelOpen));
    $('#stage').innerHTML = ({wukong:renderChat,home:renderHome,memory:renderMemory,files:renderFiles,settings:renderSettings})[state.view]();
    renderContext(); paintIcons();
    if (state.view === 'wukong' && state.messages.length) $('#stage').scrollTop = $('#stage').scrollHeight;
  }
  function showPanel(panel) { state.panel = panel; state.panelOpen = true; render(); $('.main').classList.add('is-mobile-panel'); }
  async function runLight(target) {
    if (state.deviceBusy || state.pendingResult) return false;
    const currentGeneration = generation, before = state.light;
    state.pendingLight = target; state.deviceBusy = true; renderContext(); await delay(650);
    if (currentGeneration !== generation) return false;
    state.deviceBusy = false; state.deviceActual = target;
    if (state.deviceFailure) { state.pendingResult = {before,target}; state.receipt = null; render(); return false; }
    state.light = target; state.lightRevision++; state.receipt = {before,revision:state.lightRevision}; render(); return true;
  }
  async function send(text = state.draft) {
    text = text.trim(); if (!text || state.busy) return;
    const turn = generation; state.draft = ''; state.messages.push({role:'user',text}); state.busy = true; render(); await delay(550);
    if (turn !== generation) return;
    let answer;
    if (/习惯|睡前|23:00/.test(text)) { state.panel = 'habit'; answer = {text:'最近三晚，书房灯都在 23 点左右调暗了。这只是一个可能的习惯。你可以看看依据，再决定要不要启用睡前柔光。',action:'habit',link:'看看建议和依据'}; }
    else if (/灯|阅读|亮度/.test(text)) { state.panel = 'light'; const ok = await runLight(65); if (turn !== generation) return; answer = {text:ok ? '客厅灯已调到 65%，设备状态也已回读一致。觉得太亮，可以直接调低或恢复上次亮度。' : '灯光指令已提交，但没有取得状态回读。我暂时不能说已经调好；先核实，不重复发送。',action:'light',link:ok ? '查看结果或撤销' : '核实设备状态'}; }
    else if (/眼镜|钥匙|放哪/.test(text)) { state.panel = 'search'; answer = {text:'找到一条之前的线索：19:12，客厅边柜附近检测到一副眼镜。不能确定是你的那副，也不能确认现在还在那里。\n镜头现在已关闭，期间不会更新视觉线索。',action:'search',link:'看看这条线索'}; }
    else if (/菜单|菜谱|素食/.test(text)) { state.panel = 'cloud'; state.pendingCloud = !state.cloudAllowed; answer = {text:state.offline ? '现在没有联网。你仍可以控制本地灯光、查找本机资料；云端菜单生成要等恢复网络后重新发起。' : state.cloudAllowed ? '可以。演示菜单：周六做番茄豆腐配时蔬；周日做菌菇杂粮饭。这里只用了公开任务文字，没有加入家庭资料。' : '这类一般问题可以交给你配置的云端模型。我会先展示处理范围；开启后，同类公开问题不再反复问你。',action:'cloud',link:'查看这次的处理范围'}; }
    else if (/文件|发票|凭证|洗衣机|资料/.test(text)) { state.panel = 'file'; state.fileId = 'invoice'; answer = {text:'在示例资料中找到了“洗衣机购买凭证.pdf”，放在“我的资料 / 家电 / 洗衣机”。保修期还没有确认，不能只凭文件名推算。',action:'invoice',link:'查看资料与来处'}; }
    else answer = {text:'我在。这个概念稿可以体验找物线索、灯光调整、记忆核对和资料标注。所有回复都是预设示例，没有连接真实模型。'};
    state.messages.push({role:'agent',...answer}); state.busy = false; state.panelOpen = true; render();
  }
  const actions = {
    overview:() => showPanel('overview'),privacy:() => showPanel('privacy'),model:() => showPanel('model'),search:() => showPanel('search'),light:() => showPanel('light'),cloud:() => showPanel('cloud'),habit:() => showPanel('habit'),
    'close-panel':() => { $('.main').classList.remove('is-mobile-panel'); state.panelOpen = false; render(); },
    room:(node) => { state.selectedRoom = node.dataset.room; showPanel('room'); },
    found:() => toast('这只是最后线索，找到后可由你补充确认。'),
    voice:() => { state.draft = '我的眼镜放哪儿了？'; render(); $('#chat-input').focus(); toast('已填入示例语音草稿，未使用麦克风。'); },
    'apply-light':async() => { const ok = await runLight(state.pendingLight); if (ok) toast('灯光状态已回读一致（演示）。'); },
    'undo-light':() => { if (!state.receipt || state.receipt.revision !== state.lightRevision) return toast('设备状态已变化，请重新检查。'); state.light = state.deviceActual = state.receipt.before; state.pendingLight = state.light; state.lightRevision++; state.receipt = null; render(); toast('已恢复上次亮度（演示）。'); },
    'recheck-light':() => { if (state.deviceFailure) return toast('仍未取得回读，没有重复发送指令。'); if (!state.pendingResult) return; const pending = state.pendingResult; state.light = state.deviceActual; state.lightRevision++; state.receipt = {before:pending.before,revision:state.lightRevision}; state.pendingResult = null; render(); toast('已核实设备实际亮度（演示）。'); },
    'enable-habit':() => { if (state.editHabit) { const time = $('#habit-time').value, level = Number($('#habit-level').value); if (!time || !Number.isFinite(level) || level < 1 || level > 100) return toast('请填写时间和 1–100 的亮度。'); state.habitTime = time; state.habitLevel = level; } state.habitPending = false; state.habitCreated = true; state.habitEnabled = true; state.editHabit = false; render(); toast(`已启用 ${state.habitTime} / ${state.habitLevel}%（演示）。`); },
    'edit-habit':() => { state.editHabit = !state.editHabit; renderContext(); },
    'ignore-habit':() => { state.habitPending = false; render(); toast('已忽略，同一组线索不再提醒。',() => { state.habitPending = true; render(); }); },
    'pause-habit':() => { state.habitEnabled = false; render(); toast('已暂停自动执行，手动调光仍可使用。'); },
    'memory-filter':(node) => { state.memoryFilter = node.dataset.filter; render(); },
    'memory-detail':(node) => { state.memoryId = node.dataset.id; showPanel('memory'); },
    'forget-memory':() => { const id = state.memoryId; state.forgotten.add(id); state.panel = 'overview'; render(); toast('已停止召回这条记忆（演示）。',() => { state.forgotten.delete(id); render(); }); },
    'open-memory':() => { state.view = 'memory'; state.panel = 'overview'; render(); $('.main').classList.remove('is-mobile-panel'); },
    'open-settings':() => { state.view = 'settings'; render(); $('.main').classList.remove('is-mobile-panel'); },
    'file-filter':(node) => { state.fileFilter = node.dataset.filter; render(); },
    file:(node) => { state.fileId = node.dataset.id; showPanel('file'); },invoice:() => { state.fileId = 'invoice'; showPanel('file'); },
    'annotate-file':async(node) => { const id = state.fileId, turn = generation; node.disabled = true; node.textContent = '正在演示内容分析…'; await delay(650); if (turn !== generation) return; state.annotated.add(id); if (state.fileId === id && state.panel === 'file') renderContext(); toast('示例标注已生成，作为可修正的候选保存。'); },
    'correct-file':() => { const title = $('#file-title').value.trim(); if (!title) return toast('请填写名称。'); const file = state.files.find((item) => item.id === state.fileId); file.title = title; render(); toast('已保存描述修正，未改动原件（演示）。'); },
    'import-example':() => { state.empty = false; if (!state.files.find((file) => file.id === 'added')) state.files.push({id:'added',title:'新加入的示例资料.txt',type:'documents',kind:'文本',location:'我的资料 / 待整理',note:'仅用于演示接入、分类和人工修正。',source:'原型添加 · 无真实上传',size:'1 KB',icon:'document'}); render(); toast('已添加一份示例资料，没有读取你的文件。'); },
    'allow-cloud':() => { state.cloudAllowed = true; if (state.pendingCloud) { state.messages.push({role:'agent',text:'一般问题的云端处理偏好已开启（演示）。示例菜单：番茄豆腐、时蔬与菌菇杂粮饭。没有发出真实模型请求。'}); state.pendingCloud = false; } render(); toast('已开启一般问题的云端偏好（演示）。'); },
  };
  document.addEventListener('click',(event) => {
    if (event.target.closest('.brand')) { event.preventDefault(); state.view = 'wukong'; state.panel = 'overview'; render(); return; }
    const view = event.target.closest('[data-view]');
    if (view) { state.view = view.dataset.view; if (state.view === 'memory') state.panel = state.habitPending || state.habitCreated ? 'habit' : 'overview'; if (state.view === 'home') state.panel = 'room'; if (state.view === 'settings') state.panel = 'privacy'; if (state.view === 'files') state.panel = 'overview'; render(); $('.main').classList.remove('is-mobile-panel'); return; }
    const prompt = event.target.closest('[data-prompt]'); if (prompt) { void send(prompt.dataset.prompt); return; }
    const action = event.target.closest('[data-action]'); if (action && !action.disabled) void actions[action.dataset.action]?.(action);
    const close = event.target.closest('[data-close]'); if (close) document.getElementById(close.dataset.close).close();
  });
  document.addEventListener('submit',(event) => { if (event.target.id === 'composer') { event.preventDefault(); void send(); } });
  document.addEventListener('input',(event) => {
    if (event.target.id === 'chat-input') state.draft = event.target.value;
    if (event.target.id === 'light-range') { state.pendingLight = Number(event.target.value); $('#light-value').textContent = `${state.pendingLight}%`; }
    if (event.target.id === 'file-query') { state.fileQuery = event.target.value; const start = event.target.selectionStart; $('#stage').innerHTML = renderFiles(); paintIcons($('#stage')); $('#file-query').focus(); $('#file-query').setSelectionRange(start,start); }
  });
  document.addEventListener('keydown',(event) => { if (event.target.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } if (event.key === 'Escape') $('.main').classList.remove('is-mobile-panel'); });
  document.addEventListener('change',(event) => { if (event.target.dataset.setting) { state[event.target.dataset.setting] = event.target.checked; render(); toast('已更新当前页演示偏好。'); } });
  $('#privacy-status').onclick = () => showPanel('privacy'); $('#route-status').onclick = () => showPanel('model');
  $('#theme-toggle').onclick = () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; render(); };
  $('#panel-toggle').onclick = () => { if (window.innerWidth <= 960) { state.panelOpen = true; render(); $('.main').classList.toggle('is-mobile-panel'); } else { state.panelOpen = !state.panelOpen; render(); } };
  $('#tweaks-open').onclick = () => $('#tweaks').showModal();
  $('#layout-select').onchange = (event) => { state.layout = event.target.value; state.theme = state.layout === 'night' ? 'dark' : 'light'; render(); };
  $('#shutter-select').onchange = (event) => { state.shutter = event.target.value; render(); };
  [['offline-switch','offline'],['local-missing-switch','localMissing'],['device-failure-switch','deviceFailure'],['empty-switch','empty']].forEach(([id,key]) => { document.getElementById(id).onchange = (event) => { state[key] = event.target.checked; render(); }; });
  $('#reset-demo').onclick = () => { generation++; state = createState(); $('#layout-select').value = 'standard'; $('#shutter-select').value = 'closed'; ['offline-switch','local-missing-switch','device-failure-switch','empty-switch'].forEach((id) => { document.getElementById(id).checked = false; }); $('#tweaks').close(); $('.main').classList.remove('is-mobile-panel'); render(); toast('演示已重置。'); };
  let lastFocus;
  $('#profile').onclick = () => { lastFocus = document.activeElement; $('#workspace').inert = true; $('#login-dialog').showModal(); };
  $('#login-dialog').addEventListener('cancel',(event) => event.preventDefault());
  $('#demo-login').onclick = async() => { const node = $('#demo-login'); node.disabled = true; node.textContent = '正在解锁演示…'; await delay(450); $('#login-dialog').close(); $('#workspace').inert = false; node.disabled = false; node.innerHTML = `模拟登录并继续${icon('arrow')}`; lastFocus?.focus(); toast('已回到刚才的页面和草稿，未自动重放操作。'); };
  render();
})();
