/* Standalone interaction fixture. No fetch, real file access, account API or media capture. */
(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="assets/icons.svg#${name}"></use></svg>`;
  const head = '<img src="assets/jiaho-brand/wukong.svg" alt="悟空">';
  const button = (label, action, kind = 'primary', extra = '') => `<button class="button ${kind}" data-action="${action}" ${extra}>${label}</button>`;
  const initialFiles = [
    {id:'invoice',name:'洗衣机购买凭证.pdf',kind:'文档',glyph:'pdf',path:'我的资料 / 家电 / 洗衣机',source:'手动导入 · 示例原件',note:'记载购买日期 2025-06-10；保修期尚待条款确认。'},
    {id:'warranty',name:'洗衣机保修登记.pdf',kind:'文档',glyph:'pdf',path:'我的资料 / 家电 / 洗衣机',source:'手动导入 · 示例原件',note:'登记日期 2025-06-12，不一定就是购买日期。'},
    {id:'afternoon',name:'客厅的一个午后.jpg',kind:'照片',glyph:'image',path:'我的资料 / 照片 / 日常',source:'手机备份 · 示例原件',note:'描述候选：客厅陈设。没有确认人物、身份或地点。'},
    {id:'bicycle',name:'第一次学会骑车.mp4',kind:'视频',glyph:'video',path:'我的资料 / 视频 / 片刻',source:'手动导入 · 示例原件',note:'描述候选：户外骑车片段。没有真实视频、转写或关键帧。'},
  ];
  function initialState() {
    return {draft:'',messages:[],tasks:[],nextId:1,panel:null,theme:'light',layout:'everyday',motion:true,voice:false,voiceRevision:0,empty:false,failure:false,modelMissing:false,quiet:false,light:42,lightBefore:42,pendingLight:65,lightUnknown:false,lightBusy:false,lightReceipt:false,actualLight:42,fileQuery:'',category:'全部',dateChoice:'',memories:[{id:'brief',text:'回答简单一点，先给结论。',source:'示例原话：“以后先给结论，细节需要时我再问。”'}],annotated:new Set()};
  }
  let state = initialState(), epoch = 0, toastTimer, panelOpener;
  const timers = new Set();
  function later(fn, ms) {
    const capturedEpoch = epoch;
    const handle = window.setTimeout(() => { timers.delete(handle); if (capturedEpoch === epoch) fn(); }, ms);
    timers.add(handle); return handle;
  }
  function announce(text) { $('#announcer').textContent = text; }
  function toast(text) {
    window.clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
    toastTimer = window.setTimeout(() => { $('#toast').hidden = true; }, 5000);
  }
  function message(text, extra = {}) {
    state.messages.push({role:'agent',text,...extra}); render(); announce(text);
  }
  const files = () => state.empty ? [] : initialFiles;
  const statusLabel = (task) => ({running:'正在办',waiting:'需要你选一下',done:'已准备好',cancelled:'已停止后续步骤'})[task.status];
  const taskById = (id) => state.tasks.find((task) => task.id === id);
  const taskPhases = {
    organize:['核对这几份示例资料','生成分类与描述候选','形成分组视图，保留原件引用'],
    repair:['找到购买凭证和保修登记','核对日期与缺失材料','准备维修资料清单'],
  };
  function taskCard(task) {
    const phases = taskPhases[task.kind];
    const glyph = task.status === 'done' ? 'check-circle' : task.status === 'waiting' ? 'warning' : task.status === 'cancelled' ? 'stop' : 'clock';
    return `<div class="task-card ${task.status === 'waiting' ? 'needs-input' : ''}"><div class="task-card-header"><div class="task-symbol">${icon(glyph,task.status === 'running' ? 'spin' : '')}</div><div><div class="task-title">${esc(task.title)}</div><div class="task-state">${statusLabel(task)} · 演示</div></div>${task.status === 'running' ? `<button class="icon-button" data-action="stop-task" data-id="${task.id}" aria-label="停止${esc(task.title)}">${icon('stop')}</button>` : ''}</div><p class="task-stage">${task.status === 'running' ? esc(phases[task.stage]) : task.status === 'waiting' ? '两份材料中的日期含义不同，需要核对。' : task.status === 'done' ? task.kind === 'organize' ? '照片、视频、文档已形成示例分组。原件未改动。' : '两份已有材料，一项待补充。没有对外发送。' : '没有继续处理；已产生的示例结果不会被说成全部撤销。'}</p>${task.status === 'running' ? `<div class="task-progress" aria-label="正在演示第 ${task.stage + 1} 个阶段，共 3 个"><i style="width:${(task.stage + 1) * 100 / 3}%"></i></div>` : ''}<button class="chat-link" data-action="task-detail" data-id="${task.id}">${task.status === 'waiting' ? '核对一下' : '看看进展与结果'}${icon('chevron')}</button></div>`;
  }
  function renderWelcome() {
    return `<div class="welcome"><div class="welcome-figure">${head}</div><div class="welcome-label">悟空在 · 你的家庭管家</div><h1>我在，慢慢说。<br>家里的事，交给我。</h1><p>收好一份资料，找回一个片刻，<br>或把一件没空处理的小事交给我。</p><div class="start-label">不妨从一件小事开始</div><div class="starters"><button class="starter" data-prompt="帮我整理照片、视频和文档">${icon('folder')}整理这些资料</button><button class="starter" data-prompt="帮我准备洗衣机维修资料">${icon('pdf')}准备维修资料</button><button class="starter" data-prompt="把客厅灯调亮一点">${icon('bulb')}让灯光刚刚好</button></div></div>`;
  }
  function renderTranscript() {
    if (!state.messages.length) return renderWelcome();
    return `<div class="messages"><div class="welcome-label">持续主对话 · 以下均为交互示例</div>${state.messages.map((item) => {
      if (item.role === 'user') return `<article class="message user"><div class="bubble">${esc(item.text)}</div></article>`;
      const task = item.taskId && taskById(item.taskId);
      return `<article class="message agent">${head}<div class="message-content"><div class="speaker">悟空</div>${item.text ? `<div class="bubble">${esc(item.text)}</div>` : ''}${task ? taskCard(task) : ''}${item.action ? `<button class="chat-link" data-action="${item.action}">${esc(item.link)}${icon('chevron')}</button>` : ''}</div></article>`;
    }).join('')}</div>`;
  }
  function renderComposer() {
    return `<div class="composer-region"><div class="composer-inner"><form class="composer" id="composer">${state.voice ? `<div class="listening" role="status"><div class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div>演示：悟空在听<small>未使用麦克风，随后填入示例草稿。</small></div></div>` : `<textarea id="composer-text" rows="2" aria-label="和悟空说话" placeholder="交给我吧，或者说一句…">${esc(state.draft)}</textarea>`}<div class="composer-footer"><button class="icon-button" type="button" data-action="${state.voice ? 'cancel-voice' : 'voice'}" aria-label="${state.voice ? '取消语音演示' : '体验语音输入，不使用麦克风'}">${icon(state.voice ? 'stop' : 'mic')}</button><button class="icon-button" type="button" data-action="keyboard" aria-label="使用键盘输入">${icon('keyboard')}</button><span class="composer-help">${state.tasks.some((task) => task.status === 'running') ? '我继续办，你可以接着说。' : '语音或文字，都可以。'}</span><button class="icon-button send-button" type="submit" aria-label="发送" ${!state.draft.trim() || state.voice ? 'disabled' : ''}>${icon('up')}</button></div></form><div class="composer-footnote"><span>${icon('lock')}本页示例，不发送你的内容。</span><span>Enter 发送 · Shift + Enter 换行</span></div></div></div>`;
  }
  function panelHeader(title, subtitle = '交给悟空 · 按需展开') {
    return `<div class="panel-head"><div><div class="eyebrow">${esc(subtitle)}</div><h2>${esc(title)}</h2></div><button class="icon-button" data-action="close-panel" aria-label="收起操作面板，返回聊天">${icon('x')}</button></div>`;
  }
  function fileRows(list) {
    return list.map((file) => `<button class="file-row" data-action="file" data-id="${file.id}">${icon(file.glyph)}<span><b>${esc(file.name)}</b><small>${esc(file.path)}</small></span>${icon('chevron','chevron')}</button>`).join('');
  }
  function taskPanel(task) {
    if (!task) return `${panelHeader('这件事已不在当前演示中')}<p>原型刷新或重置后，不保留任务。</p>`;
    const prefix = `${panelHeader(task.title)}<span class="tag ${task.status === 'waiting' ? 'warm' : ''}">${statusLabel(task)} · 示例</span>`;
    if (task.status === 'running') return `${prefix}<div class="panel-section"><h3>${esc(taskPhases[task.kind][task.stage])}</h3><p>你不必等在这里，可以接着聊天。只在完成或确实需要你时提醒。</p><ol class="evidence">${taskPhases[task.kind].map((text,index) => `<li>${index < task.stage ? '已演示 · ' : index === task.stage ? '进行中 · ' : '接下来 · '}${esc(text)}</li>`).join('')}</ol>${button('停止后续处理','stop-task','secondary',`data-id="${task.id}"`)}</div><p class="annotation">这里只演示异步状态，不读取文件、不调用真实 Agent。</p>`;
    if (task.status === 'cancelled') return `${prefix}<p>已停止后续步骤。已执行过的动作和结果应保留回执，不能一概声称“全部回滚”。</p>${button('重新发起这件事','restart-task','secondary',`data-kind="${task.kind}"`)}`;
    if (task.status === 'waiting') return `${prefix}<p>购买凭证写的是 6 月 10 日，保修登记是 6 月 12 日。后者可能只是登记时间，我不会悄悄替你选一个。</p><h3>这次资料包采用哪个日期？</h3><label class="choice"><input type="radio" name="purchase-date" value="2025-06-10" ${state.dateChoice === '2025-06-10' ? 'checked' : ''}><span>2025 年 6 月 10 日<small>购买凭证，第 1 页 · 示例</small></span></label><label class="choice"><input type="radio" name="purchase-date" value="unknown" ${state.dateChoice === 'unknown' ? 'checked' : ''}><span>我还不确定<small>标记待核实，仍可准备其余资料。</small></span></label>${button('继续准备','confirm-date','primary',`data-id="${task.id}" ${state.dateChoice ? '' : 'disabled'}`)}<div class="panel-section"><h3>原始材料都保留</h3>${fileRows(initialFiles.slice(0,2))}</div><p class="annotation">本次选择只用于这份示例清单，不覆盖两条原始证据，也不自动认定长期家庭事实。</p>`;
    if (task.kind === 'organize') return `${prefix}<h3 style="margin-top:24px">东西有归处，原件还在。</h3><p>这四份示例资料已形成分类视图，描述仍可修正。没有移动、改名或删除原件。</p><ul class="checklist"><li>${icon('check')}照片 · 日常片刻</li><li>${icon('check')}视频 · 骑车片段</li><li>${icon('check')}文档 · 洗衣机凭证与登记</li></ul>${fileRows(files())}<div class="panel-section"><h3>有一处值得留意</h3><p>购买日期与登记日期不能直接合并。准备维修材料时再一起核对，不为每份文件弹一次窗。</p>${button('接着准备维修资料','start-repair','secondary')}</div><p class="annotation">分类与说明为派生视图。本稿只有虚构资料，不具备真实识别能力。</p>`;
    return `${prefix}<h3 style="margin-top:24px">维修要用的，先备在这里。</h3><ul class="checklist"><li>${icon('check')}购买凭证</li><li>${icon('check')}保修登记</li><li>${icon('warning')}故障说明，还等你补一句</li></ul><dl class="detail-list"><div><dt>购买日期</dt><dd>${task.date === 'unknown' ? '待核实' : '2025 年 6 月 10 日'}</dd></div><div><dt>收录范围</dt><dd>两份家电材料，不含证件</dd></div><div><dt>对外发送</dt><dd>没有发送</dd></div></dl>${button(`${icon('download')}下载示例清单`,'download-list','primary',`data-id="${task.id}"`)}${button('看看来源材料','show-files','text')}<div class="callout">这里只生成清单，不声称已合并 PDF 或发送售后。将来发送前只核对一次接收方和实际材料。</div>`;
  }
  function panelContent() {
    const panel = state.panel;
    if (!panel) return '';
    if (panel.type === 'task') return taskPanel(taskById(panel.id));
    if (panel.type === 'tasks') return `${panelHeader('交给我的事','同一个悟空 · 一起跟进')}<p>不用追问“办到哪儿了”。进展和结果都在这里。</p>${state.tasks.length ? state.tasks.slice().reverse().map((task) => `<button class="task-list-button" data-action="task-detail" data-id="${task.id}"><strong>${esc(task.title)}</strong><small>${statusLabel(task)} · ${task.status === 'running' ? esc(taskPhases[task.kind][task.stage]) : '点开查看'} · 示例</small></button>`).join('') : `<div class="empty">${icon('check-circle')}<h3>还没有交接的事。</h3><p>先挑一件小事，交给悟空试试。</p></div>${button('整理这些资料','start-organize','secondary')}`}`;
    if (panel.type === 'home') return `${panelHeader('家里此刻','家是背景，不是监控台')}<div class="home-line">${icon('bulb')}<span>客厅灯 · ${state.lightUnknown ? '结果待核实' : state.light + '%'}<small>虚构设备回读，不连接真实家电</small></span></div><div class="home-line">${icon('camera-slash')}<span>镜头物理关闭 · 示例<small>真实产品须由硬件回报，不能靠软件猜测</small></span></div><div class="home-line">${icon('house')}<span>其他房间 · 未知<small>没有状态，不当成“没有人”</small></span></div>${button('让客厅灯刚刚好','show-light','secondary')}<div class="panel-section"><h3>主动，但不过分。</h3><p>只把值得注意的事带给你，不分析家人的情绪、亲密关系或“是否幸福”。</p></div>`;
    if (panel.type === 'memory') return `${panelHeader('我记住的，由你决定。','明确来源 · 私人空间')}<p>这不是偷偷生成的全家档案。只留能帮上忙、你允许记住的事。</p>${state.memories.length ? state.memories.map((memory) => `<div class="panel-card"><span class="tag">已明确表达 · 示例</span><h3 style="margin-top:12px">${esc(memory.text)}</h3><p>${esc(memory.source)}</p><button class="chat-link memory-delete" data-action="forget" data-id="${memory.id}">${icon('undo')}忘记这条</button></div>`).join('') : `<div class="empty">${icon('leaf')}<h3>现在没有保留的偏好。</h3><p>你可以直接说“请记住，回答简单一点”。</p></div>`}<p class="annotation">原型记忆只留本页。忘记后停止在演示回复中使用；正式系统还需同步阻断索引、缓存和上下文召回。</p>`;
    if (panel.type === 'files') {
      const query = state.fileQuery.trim().toLowerCase();
      const visible = files().filter((file) => (state.category === '全部' || file.kind === state.category) && `${file.name} ${file.path}`.toLowerCase().includes(query));
      return `${panelHeader('东西，都有归处。','我的资料 · 示例资料柜')}<input class="search-input" id="file-query" aria-label="搜索示例资料" placeholder="找名字，或记得的一点线索…" value="${esc(state.fileQuery)}"><div class="category-tabs">${['全部','照片','视频','文档'].map((category) => `<button class="${state.category === category ? 'selected' : ''}" data-action="category" data-category="${category}" aria-pressed="${state.category === category}">${category}</button>`).join('')}</div>${visible.length ? fileRows(visible) : `<div class="empty">${icon('folder')}<h3>${state.empty ? '还没有放进资料。' : '没有找到这份资料。'}</h3><p>${state.empty ? '正式版沿用“添加资料”，先保存副本，再在本机分类。' : '试试文件名或路径中的另一个词。'}</p></div>`}${button('体验自动整理','start-organize','secondary')}<p class="annotation">不读取你的磁盘，也不虚构真实 SHA、缩略图或文件内容。</p>`;
    }
    if (panel.type === 'file') {
      const file = files().find((item) => item.id === panel.id);
      if (!file) return `${panelHeader('这份示例资料暂不可见')}<p>资料库为空，或当前范围没有这份材料。不会退回另一份真实文件。</p>`;
      return `${panelHeader(file.name,'原件与描述，分别保存')}<span class="tag">${file.kind} · 虚构示例</span><dl class="detail-list"><div><dt>当前位置</dt><dd>${esc(file.path)}</dd></div><div><dt>来源</dt><dd>${esc(file.source)}</dd></div><div><dt>内容哈希</dt><dd>本稿无真实文件，不生成假 SHA</dd></div></dl><h3>内容线索</h3><p>${esc(file.note)}</p>${state.annotated.has(file.id) ? '<div class="callout">AI 描述候选：用于家庭整理与检索。关键日期、人物和条款仍以原文或人工核对为准。<br>这是预设演示，不是模型实际识别。</div>' : button('体验 AI 自动标注','annotate','secondary',`data-id="${file.id}"`)}${button('回到资料柜','show-files','text')}`;
    }
    if (panel.type === 'light') return `${panelHeader('让灯光，刚刚好。','客厅 · 低风险明确指令')}<span class="tag">设备状态 · 示例</span><div class="light-value">${state.lightUnknown ? '待核实' : state.light}<small>${state.lightUnknown ? '' : '%'}</small></div><p>这次只调整客厅这一盏灯。</p><label><small>目标亮度 <span id="light-target">${state.pendingLight}%</span></small><input class="range" id="light-range" type="range" min="0" max="100" value="${state.pendingLight}" ${state.lightUnknown || state.lightBusy ? 'disabled' : ''}></label>${state.lightUnknown ? `<div class="callout warning">${icon('warning')}指令已提交，但回读丢失。还不能说已经完成，也不会重复发送。</div>${button('只核实，不重复执行','recheck-light','secondary')}` : `${button(state.lightBusy ? '等待回读…' : '调整灯光','apply-light','primary',state.lightBusy ? 'disabled' : '')}${state.lightReceipt ? `<div class="callout">${icon('check-circle')}示例回读与目标一致。${button('恢复上次亮度','undo-light','text')}</div>` : ''}`}<p class="annotation">明确灯光指令直接执行，不再问一次“是否确定”。门锁、账户、付款不沿用此默认值。</p>`;
    if (panel.type === 'privacy') return `${panelHeader('照看好，也守得住。','感知与隐私 · 设计边界')}<div class="callout">${icon('camera-slash')}镜头关闭 · 模拟硬件状态<br>真正的物理关断必须经电源回读验证。</div><dl class="detail-list"><div><dt>麦克风</dt><dd>本稿未启用</dd></div><div><dt>人脸 / 声纹身份</dt><dd>默认关闭</dd></div><div><dt>家庭资料</dt><dd>只使用虚构样本</dd></div><div><dt>模型请求</dt><dd>本稿未发送</dd></div><div><dt>长期存储</dt><dd>本页不持久化</dd></div></dl><p>正式产品在本机保存授权资料；如果需要把家庭材料交给云端，会说明实际发送范围。联网不等于允许上传一切。</p>${button('看看悟空记住了什么','show-memory','secondary')}`;
    if (panel.type === 'model') return `${panelHeader('聪明，也有分寸。','模型与执行方式 · 概念展示')}<dl class="detail-list"><div><dt>本机模型</dt><dd>${state.modelMissing ? '不可用 · 模拟' : '就绪 · 模拟'}</dd></div><div><dt>云端模型</dt><dd>本稿未连接</dd></div><div><dt>固定动作</dt><dd>可演示，不依赖 LLM</dd></div><div><dt>执行器</dt><dd>设计上兼容 Pi / Harness</dd></div></dl>${state.modelMissing ? '<div class="callout warning">本机模型不可用，不会假装回答，也不偷偷把家庭内容改送云端。固定流程仍可以演示。</div>' : ''}<p>正式版沿用现有管理员 Provider 配置与安全存储，不在聊天里收密钥。模型配置和 Key 不属于悟空的聊天记忆。</p>${button('安心与设置','show-settings','secondary')}`;
    return `${panelHeader('安心，把选择留给你。','设置，不打断日常')}<label class="toggle-row"><span>安静一点<small>示例：只提示完成与必要决定</small></span><input type="checkbox" id="quiet-setting" role="switch" ${state.quiet ? 'checked' : ''}></label><button class="file-row" data-action="privacy">${icon('lock')}<span><b>感知与隐私</b><small>知道哪些在本机，哪些可能上云</small></span>${icon('chevron','chevron')}</button><button class="file-row" data-action="model">${icon('sliders')}<span><b>大模型与执行器</b><small>技术配置收在这里，不要求每天选择</small></span>${icon('chevron','chevron')}</button><button class="file-row" data-action="show-memory">${icon('leaf')}<span><b>管理记忆</b><small>看来源、修正、忘记</small></span>${icon('chevron','chevron')}</button><p class="annotation">悟空是一位软件管家，不是家人的替代品。你可以不聊天，只让它把事情做好。</p>`;
  }
  function renderPanel() {
    const node = $('#panel'); node.hidden = !state.panel;
    node.innerHTML = panelContent(); $('#workspace').classList.toggle('has-panel',Boolean(state.panel));
    $('#panel-toggle').setAttribute('aria-expanded',String(Boolean(state.panel)));
    $('#panel-toggle').setAttribute('aria-label',state.panel ? '收起操作面板' : '展开操作面板');
    const section = state.panel?.type === 'task' ? 'tasks' : state.panel?.type === 'file' ? 'files' : state.panel?.type;
    document.querySelectorAll('[data-nav]').forEach((node) => { const selected = node.dataset.nav === 'chat' ? !state.panel : node.dataset.nav === section; node.classList.toggle('selected',selected); node.setAttribute('aria-pressed',String(selected)); });
  }
  function render() {
    const transcript = $('#transcript');
    const oldScroll = transcript.scrollTop, follow = transcript.scrollHeight - oldScroll - transcript.clientHeight < 90;
    const active = document.activeElement, editing = active?.id === 'composer-text';
    const selection = editing ? [active.selectionStart,active.selectionEnd] : null;
    document.body.dataset.theme = state.theme; document.body.dataset.layout = state.layout;
    document.body.classList.toggle('no-motion',!state.motion);
    transcript.innerHTML = renderTranscript(); $('#composer-region').innerHTML = renderComposer();
    const activeTasks = state.tasks.filter((task) => task.status === 'running' || task.status === 'waiting');
    $('#task-count').textContent = String(activeTasks.length); $('#task-count').hidden = !activeTasks.length;
    $('#sidebar-work').innerHTML = activeTasks.length ? `<div class="section-label">正在照看的事 · 示例</div>${activeTasks.slice(0,3).map((task) => `<button class="mini-task" data-action="task-detail" data-id="${task.id}">${icon(task.status === 'waiting' ? 'warning' : 'clock')}<span>${esc(task.title)}</span></button>`).join('')}` : '';
    $('#presence-text').textContent = state.voice ? '演示：我在听。' : activeTasks.some((task) => task.status === 'waiting') ? '有一件事，想听听你的意思。' : activeTasks.length ? '我继续办，你可以接着说。' : '在家，随时可以说。';
    $('#route-label').textContent = state.modelMissing ? '本机模型不可用 · 示例' : '本机模型 · 示例'; $('.route-pill').classList.toggle('unavailable',state.modelMissing);
    $('#theme-toggle').innerHTML = icon(state.theme === 'light' ? 'moon' : 'sun'); $('#theme-toggle').setAttribute('aria-label',state.theme === 'light' ? '切换深色模式' : '切换浅色模式');
    renderPanel();
    transcript.scrollTop = follow ? transcript.scrollHeight : oldScroll;
    $('#new-message').hidden = follow || transcript.scrollHeight <= transcript.clientHeight;
    if (editing && $('#composer-text')) { $('#composer-text').focus({preventScroll:true}); $('#composer-text').setSelectionRange(...selection); }
  }
  function openPanel(type,id) {
    panelOpener = document.activeElement; state.panel = {type,id}; renderPanel();
    if (window.innerWidth <= 940) $('#panel .panel-head button')?.focus({preventScroll:true});
  }
  function closePanel() { state.panel = null; render(); if (panelOpener?.isConnected) panelOpener.focus({preventScroll:true}); else $('#composer-text')?.focus({preventScroll:true}); }
  function startTask(kind) {
    const existing = state.tasks.find((task) => task.kind === kind && ['running','waiting'].includes(task.status));
    if (existing) { openPanel('task',existing.id); toast('这件事已经在办，没有重复创建。'); return; }
    if (!files().length) { message('现在的示例资料库是空的，不能声称已经整理或找到材料。你可以在演示设置恢复样本，再试一遍。',{action:'show-files',link:'看看资料库'}); return; }
    const task = {id:`task-${state.nextId++}`,kind,title:kind === 'organize' ? '整理照片、视频和文档' : '准备洗衣机维修资料',stage:0,status:'running',date:null};
    state.tasks.push(task);
    message(kind === 'organize' ? '好。我先按照片、视频和文档收成分组，原件不动。你可以继续说别的事。' : '好。我把凭证和登记先备好；发现需要你核对的地方，再一起问你。',{taskId:task.id});
    if (state.layout === 'focus') openPanel('task',task.id);
    [1700,3600,5400].forEach((ms,index) => later(() => {
      if (task.status !== 'running') return;
      if (index < 2) { task.stage = index + 1; render(); return; }
      task.status = kind === 'repair' ? 'waiting' : 'done';
      if (kind === 'repair') { state.dateChoice = ''; openPanel('task',task.id); message('两份材料的日期不一样：一个是购买日期，一个可能是登记日期。右边一起核对一下，其余材料我已经备好。'); }
      else { message('这几份示例资料已经有了归处。照片、视频和文档分别收好，原件没动；描述可以随时改。',{action:'latest-organize',link:'看看整理结果'}); if (state.layout === 'focus') openPanel('task',task.id); }
    }, ms));
  }
  function runLight(target) {
    if (state.lightBusy || state.lightUnknown) { openPanel('light'); toast('先取得回读，不重复发送指令。'); return; }
    state.lightBefore = state.light; state.pendingLight = target; state.lightBusy = true; state.lightReceipt = false; render();
    later(() => { state.actualLight = target; state.lightBusy = false;
      if (state.failure) { state.lightUnknown = true; message('灯光指令已提交，但没有取得回读。我先核实，不会重复发送。',{action:'show-light',link:'核实设备状态'}); openPanel('light'); }
      else { state.light = target; state.lightReceipt = true; message(`客厅灯已调到 ${target}%，示例设备回读一致。觉得不合适，可以恢复上次亮度。`,{action:'show-light',link:'看看结果，或恢复'}); }
    },700);
  }
  function send(text = state.draft) {
    const value = text.trim(); if (!value || state.voice) return;
    state.draft = ''; state.messages.push({role:'user',text:value}); render();
    if (/记住/.test(value) && /简单|简短|结论/.test(value)) {
      const preference = {id:'brief',text:'回答简单一点，先给结论。',source:`本页明确原话：“${value}”`};
      state.memories = [...state.memories.filter((item) => item.id !== 'brief'),preference];
      message('记住了：先给结论，细节你需要时再说。这条只影响交流方式，可以随时让我忘记。',{action:'show-memory',link:'查看或忘记这条偏好'}); return;
    }
    if (/整理|分类|收好/.test(value)) { startTask('organize'); return; }
    if (/维修|保修|资料包/.test(value)) { startTask('repair'); return; }
    if (/灯|亮度/.test(value)) { runLight(/暗|低/.test(value) ? 25 : 65); return; }
    if (/记忆|记得|忘记/.test(value)) { message(state.memories.length ? '这里是你明确允许记住的偏好，来源和“忘记”放在一起。' : '目前没有保留的偏好。我不会再把已忘记的内容当作记忆使用。',{action:'show-memory',link:'看看记忆与来源'}); openPanel('memory'); return; }
    if (/文件|发票|凭证|照片|视频|资料/.test(value)) { message(files().length ? '这些示例资料在右边。你可以按名字、类别或路径找，也可以让我准备成一份资料清单。' : '当前示例资料库为空，没有可查找的材料。',{action:'show-files',link:'打开资料柜'}); openPanel('files'); return; }
    message(state.modelMissing ? '本机模型当前不可用，我不会假装听懂并执行。这里仍可以体验固定的资料整理、维修清单和灯光流程。' : state.memories.some((item) => item.id === 'brief') ? '我在。这个原型先体验三件事：整理资料、准备维修清单、调好灯光。正式对话还需接入模型。' : '我在。这是交互原型，回复是预设的，不是实际大模型回答。你可以试着把整理资料、准备维修清单或调节灯光交给我。');
  }
  const actions = {
    'close-panel':closePanel,
    'task-detail':(node) => openPanel('task',node.dataset.id),
    'start-organize':() => send('帮我整理照片、视频和文档'),
    'start-repair':() => send('帮我准备洗衣机维修资料'),
    'latest-organize':() => { const task = state.tasks.findLast((item) => item.kind === 'organize'); if (task) openPanel('task',task.id); },
    'stop-task':(node) => { const task = taskById(node.dataset.id); if (task?.status !== 'running') return; task.status = 'cancelled'; render(); toast('已停止后续演示步骤，没有声称撤销已完成动作。'); },
    'restart-task':(node) => startTask(node.dataset.kind),
    'confirm-date':(node) => { const task = taskById(node.dataset.id); if (!task || task.status !== 'waiting' || !state.dateChoice) return; task.date = state.dateChoice; task.status = 'running'; task.stage = 2; render(); later(() => { if (task.status !== 'running') return; task.status = 'done'; message(task.date === 'unknown' ? '清单准备好了，购买日期保留“待核实”。没有覆盖原始材料，也没有对外发送。' : '清单准备好了。这次采用购买凭证上的日期，登记日期仍原样保留；没有对外发送。'); openPanel('task',task.id); },900); },
    'download-list':(node) => { const task = taskById(node.dataset.id); if (!task || task.status !== 'done' || task.kind !== 'repair') return; const content = `家合 Jiaho · 虚构示例维修清单\n\n这不是实际家庭资料，不含真实文件。\n\n物品：示例洗衣机\n购买日期：${task.date === 'unknown' ? '待核实' : task.date}\n材料：洗衣机购买凭证.pdf；洗衣机保修登记.pdf（均为虚构引用）\n缺项：故障说明\n未发送给任何人。\n`; const url = URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'})); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '家合-虚构示例维修清单.txt'; document.body.append(anchor); anchor.click(); anchor.remove(); later(() => URL.revokeObjectURL(url),1000); toast('已下载明确标注的示例文本，不含真实原件。'); },
    'show-files':() => openPanel('files'),'show-memory':() => openPanel('memory'),'show-settings':() => openPanel('settings'),'show-light':() => openPanel('light'),privacy:() => openPanel('privacy'),model:() => openPanel('model'),
    file:(node) => openPanel('file',node.dataset.id),
    category:(node) => { state.category = node.dataset.category; renderPanel(); },
    forget:(node) => { const id = node.dataset.id; state.memories = state.memories.filter((item) => item.id !== id); renderPanel(); toast('本页已停止使用这条记忆，不根据旧来源自动恢复。'); },
    annotate:(node) => { const id = node.dataset.id; node.disabled = true; node.textContent = '正在演示内容分析…'; later(() => { state.annotated.add(id); if (state.panel?.type === 'file' && state.panel.id === id) renderPanel(); toast('已生成预设的描述候选，没有实际调用模型。'); },700); },
    'apply-light':() => runLight(state.pendingLight),
    'undo-light':() => { if (!state.lightReceipt || state.lightBusy || state.lightUnknown) return; const target = state.lightBefore; state.lightReceipt = false; runLight(target); },
    'recheck-light':() => { if (!state.lightUnknown) return; if (state.failure) return toast('仍未取得回读，请在演示设置关闭“回执丢失”后再核实。'); state.light = state.actualLight; state.lightUnknown = false; state.lightReceipt = true; render(); toast('只读取了模拟设备状态，没有重复执行。'); },
    voice:() => { if (state.voice) return; if (state.draft.trim()) return toast('先保留当前草稿；发送或清空后，再体验示例语音。'); state.voice = true; const revision = ++state.voiceRevision; render(); later(() => { if (!state.voice || revision !== state.voiceRevision) return; state.voice = false; state.draft = '帮我准备洗衣机维修资料'; render(); $('#composer-text')?.focus({preventScroll:true}); toast('已填入示例语音草稿，由你确认发送；没有录音。'); },1900); },
    'cancel-voice':() => { state.voice = false; state.voiceRevision++; render(); $('#composer-text')?.focus({preventScroll:true}); },
    keyboard:() => { state.voice = false; state.voiceRevision++; render(); $('#composer-text')?.focus({preventScroll:true}); },
  };
  document.addEventListener('click',(event) => {
    if (event.target.closest('.brand')) { event.preventDefault(); closePanel(); return; }
    const nav = event.target.closest('[data-nav]'); if (nav) { if (nav.dataset.nav === 'chat') closePanel(); else openPanel(nav.dataset.nav); return; }
    const prompt = event.target.closest('[data-prompt]'); if (prompt) { send(prompt.dataset.prompt); return; }
    const action = event.target.closest('[data-action]'); if (action && !action.disabled) actions[action.dataset.action]?.(action);
    const close = event.target.closest('[data-close]'); if (close) document.getElementById(close.dataset.close)?.close();
  });
  document.addEventListener('submit',(event) => { if (event.target.id === 'composer') { event.preventDefault(); send(); } });
  document.addEventListener('input',(event) => {
    if (event.target.id === 'composer-text') { state.draft = event.target.value; $('.send-button').disabled = !state.draft.trim(); }
    if (event.target.id === 'light-range') { state.pendingLight = Number(event.target.value); $('#light-target').textContent = `${state.pendingLight}%`; }
    if (event.target.id === 'file-query') { state.fileQuery = event.target.value; const selection = [event.target.selectionStart,event.target.selectionEnd]; renderPanel(); $('#file-query').focus({preventScroll:true}); $('#file-query').setSelectionRange(...selection); }
  });
  document.addEventListener('change',(event) => {
    if (event.target.name === 'purchase-date') { state.dateChoice = event.target.value; const node = $('#panel [data-action="confirm-date"]'); if (node) node.disabled = false; }
    if (event.target.id === 'quiet-setting') { state.quiet = event.target.checked; toast('已切换本页演示偏好；本稿本来就只提示完成与必要决定。'); }
  });
  document.addEventListener('keydown',(event) => {
    if (event.target.id === 'composer-text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && state.panel) { event.preventDefault(); closePanel(); }
  });
  $('#theme-toggle').onclick = () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; render(); };
  $('#panel-toggle').onclick = () => state.panel ? closePanel() : openPanel('tasks');
  $('#open-tweaks').onclick = () => $('#tweaks').showModal();
  $('#layout-choice').onchange = (event) => { state.layout = event.target.value; if (state.layout === 'focus' && !state.panel) state.panel = {type:'tasks'}; if (state.layout === 'companion') state.panel = null; render(); };
  $('#motion-toggle').onchange = (event) => { state.motion = event.target.checked; render(); };
  [['empty-toggle','empty'],['failure-toggle','failure'],['model-toggle','modelMissing']].forEach(([id,key]) => { document.getElementById(id).onchange = (event) => { state[key] = event.target.checked; render(); }; });
  $('#reset').onclick = () => { epoch++; timers.forEach((handle) => window.clearTimeout(handle)); timers.clear(); state = initialState(); $('#layout-choice').value = 'everyday'; $('#motion-toggle').checked = true; ['empty-toggle','failure-toggle','model-toggle'].forEach((id) => { document.getElementById(id).checked = false; }); $('#tweaks').close(); render(); toast('当前页演示已重置。'); };
  $('#new-message').onclick = () => { const node = $('#transcript'); node.scrollTop = node.scrollHeight; $('#new-message').hidden = true; };
  $('#transcript').addEventListener('scroll',() => { const node = $('#transcript'); if (node.scrollHeight - node.scrollTop - node.clientHeight < 90) $('#new-message').hidden = true; },{passive:true});
  window.addEventListener('pagehide',() => { timers.forEach((handle) => window.clearTimeout(handle)); timers.clear(); window.clearTimeout(toastTimer); });
  render();
})();
