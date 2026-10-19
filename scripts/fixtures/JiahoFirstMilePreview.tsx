// Interactive v0 only. Everything lives in page memory. No native/API imports.
import React, { useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowUp, ArrowUpRight, Brain, Check, ChatCircle, FileText, Folder, GearSix, LockKey, Microphone, Moon, SlidersHorizontal, Sun, Trash, X } from "@phosphor-icons/react";
import WukongHead from "../../src/components/WukongHead";
import logo from "../../src/assets/jiaho-boot-logo.png";
import { canDemoSend, DEMO_FILE, demoInitial, demoReducer, rememberedGreeting } from "./jiaho-first-mile-state";
import "./jiaho-first-mile.css";

function Preview() {
  const [state, dispatch] = useReducer(demoReducer, undefined, demoInitial);
  const [draft, setDraft] = useState("");
  const [memoryDraft, setMemoryDraft] = useState("");
  const [forgetting, setForgetting] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [tweaks, setTweaks] = useState(false);
  const [layout, setLayout] = useState("center");
  const [large, setLarge] = useState(false);
  const [voiceDemo, setVoiceDemo] = useState(false);
  const [clearAsked, setClearAsked] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const remembered = rememberedGreeting(state);
  const shownMemory = state.panel === "consent" ? state.candidate : state.memory ?? state.candidate;
  const hasMessages = state.messages.length > 0;

  useEffect(() => { setMemoryDraft(shownMemory?.text ?? ""); setForgetting(false); }, [shownMemory]);
  useEffect(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, [state.messages]);
  useEffect(() => {
    if (!state.panel) return;
    opener.current = document.activeElement as HTMLElement;
    panelRef.current?.focus();
    return () => { opener.current?.isConnected && opener.current.focus(); };
  }, [state.panel]);
  const fill = (text: string) => { setDraft(text); dispatch({ type: "consent", allowed: false }); input.current?.focus(); };
  const closePanel = () => dispatch({ type: "panel", panel: null });
  const reset = () => { dispatch({ type: "reset" }); setDraft(""); setMemoryDraft(""); setClearAsked(false); setVoiceDemo(false); };
  const send = () => {
    if (!draft.trim()) return;
    dispatch({ type: "send", text: draft });
    if (canDemoSend(state, draft)) setDraft("");
  };
  const panelTitles = { files: "先选一点资料", file: "核对原文", memory: "悟空记得什么", consent: "留下一点偏好", privacy: "你的资料，你掌握" };

  return <div className={`first-mile layout-${layout} ${large ? "is-large" : ""}`} data-theme={theme}>
    <aside className="fm-rail" aria-label="家合导航">
      <a className="fm-brand" href="#" onClick={(event) => { event.preventDefault(); closePanel(); }} aria-label="家合首页"><img src={logo} alt="家合 Jiaho" /><span>家合<small>一个安稳的地方</small></span></a>
      <nav>
        <button aria-label="和悟空聊天" className={!state.panel || state.panel === "consent" || state.panel === "file" ? "is-current" : ""} aria-current={!state.panel ? "page" : undefined} onClick={closePanel}><span className="fm-small-head" aria-hidden="true"><WukongHead /></span><span>悟空<small>慢慢说，我在。</small></span></button>
        <button aria-label="我的资料" className={state.panel === "files" ? "is-current" : ""} onClick={() => dispatch({ type: "panel", panel: "files" })}><Folder size={21} /><span>我的资料</span></button>
      </nav>
      <div className="fm-rail-foot">
        <button aria-label="悟空记得什么" onClick={() => dispatch({ type: "panel", panel: "memory" })}><Brain size={18} /><span>悟空记得什么</span></button>
        <button aria-label="隐私与数据" onClick={() => dispatch({ type: "panel", panel: "privacy" })}><LockKey size={18} /><span>隐私与数据</span></button>
        <div className="fm-bottom"><button aria-label="打开预览设置" title="预览设置；不修改应用配置" aria-expanded={tweaks} onClick={() => setTweaks(!tweaks)}><GearSix size={19} /></button><span>Jiaho <span>v{__APP_VERSION__}</span></span><button aria-label={theme === "light" ? "切换深色预览" : "切换浅色预览"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button></div>
      </div>
    </aside>

    <main className={`fm-main ${hasMessages ? "has-messages" : ""}`}>
      <header className="fm-top"><span>我的空间</span><button onClick={() => dispatch({ type: "panel", panel: "privacy" })}><LockKey size={14} />{state.mode === "local" ? "本机处理 · 演示" : "云端授权 · 演示"}</button></header>
      <div className="fm-stream" ref={stream}>
        {!hasMessages ? <section className="fm-welcome" aria-label="悟空欢迎你"><div className="fm-hero-head"><WukongHead /></div><h1>{state.returned ? "又见面了。" : "悟空在，慢慢说。"}</h1><p>{remembered ? `记得你的偏好：「${remembered}」` : "找一份资料，或者聊聊眼前的事。"}</p>{remembered && <button className="fm-memory-caption" onClick={() => dispatch({ type: "panel", panel: "memory" })}><Check size={14} />来自你确认的偏好 · 查看</button>}</section> : <div className="fm-messages" aria-label="示例对话">{state.messages.map((message) => <article className={`fm-message is-${message.role}`} key={message.id}><small>{message.role === "user" ? "你" : "悟空"}</small><p>{message.text}</p>{message.file && <button className="fm-result" onClick={() => dispatch({ type: "panel", panel: "file" })}><FileText size={27} /><span><b>{DEMO_FILE.name}</b><small>文档 · 示例资料/家电</small></span><ArrowUpRight size={18} /></button>}</article>)}</div>}
      </div>

      <section className="fm-compose-area" aria-label="和悟空说话">
        {state.notice && <p className="fm-notice" role="status">{state.notice}</p>}
        {voiceDemo && <div className="fm-voice-help" role="status"><span>这里只演示“语音先成为草稿”，不会打开麦克风。</span><button onClick={() => { fill("帮我找一下洗衣机的购买凭证"); setVoiceDemo(false); }}>填入示例识别文字</button><button aria-label="关闭语音说明" onClick={() => setVoiceDemo(false)}><X size={16} /></button></div>}
        <div className="fm-composer"><textarea ref={input} aria-label="和悟空说说话" placeholder="说说你想做什么，也可以只是聊聊…" rows={2} maxLength={2000} value={draft} onChange={(event) => { setDraft(event.target.value); dispatch({ type: "consent", allowed: false }); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} /><div className="fm-input-tools"><button className={voiceDemo ? "fm-voice is-active" : "fm-voice"} onClick={() => setVoiceDemo(!voiceDemo)} aria-label="体验语音草稿流程" aria-expanded={voiceDemo}><Microphone size={21} /><span>说话</span></button><button className="fm-send" aria-label="发送示例消息" disabled={!draft.trim()} onClick={send}><ArrowUp size={21} weight="bold" /></button></div></div>
        {state.mode === "cloud" && <label className="fm-consent"><input type="checkbox" checked={state.cloudConsent} onChange={(event) => dispatch({ type: "consent", allowed: event.target.checked })} />允许本次发送当前文字与最近对话<span>（仅演示，不实际发送）</span></label>}
        {!hasMessages && <div className="fm-starts"><button onClick={() => dispatch({ type: "panel", panel: "files" })}><Folder size={17} />找一份资料</button><button onClick={() => fill("今天不想干活")}><ChatCircle size={18} />先聊聊</button></div>}
        <button className="fm-scope" onClick={() => dispatch({ type: "panel", panel: "privacy" })}>{state.mode === "local" ? "本页不联网、不读取私人文件" : "发送之前，先看清处理范围"}<span>查看范围</span></button>
      </section>
      <footer className="fm-demo-label">交互设计 v0 · 示例资料与预设回复 · 输入只留在本页，刷新清空</footer>
    </main>

    {state.panel && <aside className="fm-panel" ref={panelRef} tabIndex={-1} aria-label={panelTitles[state.panel]} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
      <header><span>{panelTitles[state.panel]}</span><button onClick={closePanel} aria-label="收起右侧面板"><X size={20} /></button></header>
      <div className="fm-panel-content">
        {state.panel === "files" && <><span className="fm-eyebrow">从少量开始</span><h2>不用一次，<br />交给我所有东西。</h2><p>先选一个小文件夹。只建立查找视图，原件不动。</p><div className="fm-folder"><Folder size={30} /><div><b>家电凭证</b><small>演示资料 · 不读取你的电脑</small></div></div>{state.library ? <><div className="fm-ok"><Check size={16} />演示资料已就绪</div><button className="fm-primary" onClick={() => { closePanel(); fill("帮我找一下洗衣机的购买凭证"); }}>试着找一份凭证<ArrowUpRight size={18} /></button><button className="fm-plain" onClick={() => { closePanel(); fill("帮我找一张旅行照片"); }}>试试没有结果的情况</button></> : <button className="fm-primary" onClick={() => { dispatch({ type: "library" }); fill("帮我找一下洗衣机的购买凭证"); }}>使用这份演示资料<ArrowUpRight size={18} /></button>}<small className="fm-limit">正式版会由你选择并确认真实文件夹范围。这里不会请求磁盘权限或上传文件。</small></>}

        {state.panel === "file" && <><span className="fm-eyebrow">找到之后，看得清楚</span><h2>资料在这里。</h2><div className="fm-file-title"><FileText size={24} /><b>{DEMO_FILE.name}</b></div><pre className="fm-document">{DEMO_FILE.content}</pre><dl className="fm-provenance"><dt>来源位置</dt><dd>{DEMO_FILE.path}</dd><dt>本次处理</dt><dd>仅展示预置文本，没有移动、改名或上传。</dd></dl><button className="fm-plain" onClick={() => dispatch({ type: "panel", panel: "files" })}><ArrowLeft size={16} />查看查找范围</button></>}

        {(state.panel === "consent" || state.panel === "memory") && (shownMemory ? <>
          <span className="fm-eyebrow">{shownMemory.confirmed ? "经过你的确认" : "只有你点头，才留下"}</span>
          <h2>{shownMemory.confirmed ? "记得的，都能改。" : "要我以后\n也记住吗？"}</h2>
          <label className="fm-field">{shownMemory.confirmed ? "这条示例偏好" : "准备留下的偏好"}
            <textarea aria-label="记忆内容" maxLength={300} value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} rows={3} />
          </label>
          <p className="fm-small">仅用于你的回答偏好。此预览只保存在当前页面，不写入正式记忆库。</p>
          <details className="fm-source"><summary>来自哪句话</summary><p>{shownMemory.source}</p><small>来源：本次示例对话</small></details>
          <button className="fm-primary" disabled={!memoryDraft.trim()} onClick={() => dispatch({ type: "confirm", text: memoryDraft, target: shownMemory.confirmed ? "memory" : "candidate" })}>
            {shownMemory.confirmed ? "保存修改（演示）" : "确认记住（演示）"}<Check size={18} />
          </button>
          {!shownMemory.confirmed ? <button className="fm-plain" onClick={() => dispatch({ type: "skip" })}>这次就好</button> : forgetting ? <div className="fm-forget">
            <p>移除这条偏好后，欢迎语不再使用它。对话原文仍然保留。</p>
            <button onClick={() => dispatch({ type: "forget" })}>确认忘记（演示）</button><button onClick={() => setForgetting(false)}>取消</button>
          </div> : <button className="fm-plain" onClick={() => setForgetting(true)}><Trash size={16} />忘记这条</button>}
          <small className="fm-limit">正式版须验证：同一身份重新登录后仍准确记得；拒绝和忘记后不会再被召回。</small>
        </> : <>
          <span className="fm-eyebrow">从空白开始，也很好</span><h2>还没有<br />留下任何偏好。</h2>
          <p>不需要先介绍自己。想让我记住什么时，再告诉我。</p>
          <button className="fm-primary" onClick={() => { closePanel(); fill("以后回答简单一点，先说重点"); }}>试试确认一条记忆<ArrowUpRight size={18} /></button>
          <small className="fm-limit">没有授权的记忆，不会用来假装认识你。</small>
        </>)}

        {state.panel === "privacy" && <><span className="fm-eyebrow">说清楚，才安心</span><h2>什么留下，<br />什么发出去。</h2><dl className="fm-privacy-list"><dt>这版预览保存什么？</dt><dd>仅当前页面内存中的输入和示例记忆。刷新后清空，不使用浏览器持久化存储。</dd><dt>会读取我的文件吗？</dt><dd>不会。所有文件、原文和回复都是明确标记的演示内容。</dd><dt>会发给云端吗？</dt><dd>不会。即使切换云端授权演示，也不会连接任何模型；正式版要显示真实接收方和待发内容。</dd><dt>“忘记”包含什么？</dt><dd>本页记忆移除后不再用于欢迎语；不等于清除了对话、审计和备份。正式版需要分别管理。</dd></dl>{state.mode === "cloud" && <div className="fm-cloud-scope"><b>本次发送范围（示例）</b><p>接收方：待配置的云端模型，非真实连接。</p><p>当前草稿与本页最近对话；不含文件原件、文件片段或已存记忆。未确认，不发送。</p><details><summary>查看当前文字与对话</summary><pre>{[...state.messages.map((item) => `${item.role === "user" ? "你" : "悟空"}：${item.text}`), `当前草稿：${draft || "（空）"}`].join("\n\n")}</pre></details></div>}<div className="fm-forget">{clearAsked ? <><p>清除当前页的示例对话、偏好和资料连接。不会删除电脑上的任何文件。</p><button onClick={reset}>确认清除本页内容</button><button onClick={() => setClearAsked(false)}>取消</button></> : <button onClick={() => setClearAsked(true)}><Trash size={16} />清除本页演示内容</button>}</div></>}
      </div>
      <footer>交互示例 · 尚未接入真实业务服务</footer>
    </aside>}

    {tweaks && <section className="fm-tweaks" role="dialog" aria-label="Tweaks 预览参数" onKeyDown={(event) => { if (event.key === "Escape") setTweaks(false); }}><header><b>Tweaks</b><button aria-label="关闭预览参数" onClick={() => setTweaks(false)}><X size={18} /></button></header><label>布局方案<select value={layout} onChange={(event) => setLayout(event.target.value)}><option value="center">居中相见 · 默认</option><option value="left">留白靠左</option><option value="bottom">输入常驻底部</option></select></label><label className="fm-check"><input type="checkbox" checked={large} onChange={(event) => setLarge(event.target.checked)} />大一点的文字</label><label>处理方式（仅演示）<select value={state.mode} onChange={(event) => dispatch({ type: "mode", mode: event.target.value as "local" | "cloud" })}><option value="local">本机处理</option><option value="cloud">云端授权流程</option></select></label><button className="fm-plain" onClick={() => { dispatch({ type: "return" }); setTweaks(false); }}><ArrowUpRight size={16} />模拟再次回来</button><small>仅已确认记忆会出现在欢迎中。</small><button className="fm-plain" onClick={() => { reset(); setTweaks(false); }}>从第一次打开重新开始</button></section>}
    <button className="fm-preview-control" aria-label="打开布局预览参数" aria-expanded={tweaks} onClick={() => setTweaks(!tweaks)}><SlidersHorizontal size={18} /></button>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
