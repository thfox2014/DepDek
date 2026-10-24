import { ArrowCounterClockwise, ArrowRight, BookmarkSimple, Check, CheckCircle, FileText, FolderSimple, LockKey, Package, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { DOCUMENT_SCENES, documentGroups, documentPacketDraft, type DocumentExamples, type DocumentScene } from "../lib/documentScenes";
import FileImportButton from "./FileImportButton";
import "./documents-panel.css";

type Props = {
  scene: DocumentScene; hidden?: boolean; examples?: DocumentExamples;
  initialState?: "ready" | "empty" | "error";
  onAsk: (text: string) => void; onProgress: (lines: string[]) => void;
  onOpenHome: () => void; onClose: () => void;
};

/** Outcome-first document canvas. Demo content must be explicitly injected. */
export default function DocumentsPanel({ scene, hidden, examples, initialState = "ready", onAsk, onProgress, onOpenHome, onClose }: Props) {
  const [state, setState] = useState(initialState), [original, setOriginal] = useState(false), [bookmarked, setBookmarked] = useState(false);
  const [organized, setOrganized] = useState(false), [compare, setCompare] = useState(false), [inbox, setInbox] = useState(false);
  const [packet, setPacket] = useState(false), [editing, setEditing] = useState(false), [missing, setMissing] = useState(false), [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState(() => examples?.prepare.items.filter((item) => item.source).map((item) => item.id) ?? []);
  const current = DOCUMENT_SCENES.find((item) => item.id === scene)!;
  const groups = examples ? documentGroups(examples.organize) : [];
  const draft = examples ? documentPacketDraft(examples.prepare, selected) : null;
  const missingItems = examples?.prepare.items.filter((item) => !item.source) ?? [];

  useEffect(() => {
    if (!examples) { onProgress([]); return; }
    if (state !== "ready") { onProgress([state === "error" ? "示例资料暂未载入，可重试" : "当前是空资料状态演示", "没有读取或修改真实文件"]); return; }
    const lines = scene === "find"
      ? ["示例演示 · 定位说明书中的相关段落", `来源：${examples.find.source.name} · ${examples.find.source.section}`, original ? "正在查看示例原文，不是模型生成的完整说明书" : "答案与原文一起呈现，可展开核对", bookmarked ? "已在本次预览中标为常用" : "未向模型或外部服务发送资料"]
      : scene === "organize"
        ? [`示例演示 · ${examples.organize.files.length} 份资料，${groups.length} 个主题`, "区分版本差异与相同内容副本", organized ? "整理方案已在预览中应用，可以撤销" : "先呈现整理建议，不自动改动文件", "原件保留；未执行移动、重命名或删除"]
        : [`示例演示 · 围绕「${examples.prepare.title}」准备资料`, `已选 ${draft?.references.length ?? 0} 份，${missingItems.length} 项尚缺`, saved ? "清单草稿已留在当前页内存" : "可核对来源、调整选项并查看缺项", "未生成 ZIP、未外发，也未创建真实任务"];
    onProgress(lines);
  }, [scene, examples, state, original, bookmarked, organized, saved, selected, onProgress]);

  const title = scene === "find" ? "答案，就在这一页。" : scene === "organize" ? (organized ? "收好了，也找得到了。" : "一摞资料，有了头绪。") : examples?.prepare.title ?? "围绕一件事，把资料备齐。";
  const toggleSelected = (id: string) => { setSaved(false); setSelected((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]); };
  const ready = Boolean(examples && state === "ready");

  return <aside className="treasure-panel documents-panel" aria-label="资料交互区" hidden={hidden} data-scene={scene}>
    <header className="documents-panel__header"><span>资料 <span>/ {current.title}</span></span><div><small>{examples ? "示例 · 交互原型" : "本机资料"}</small><button className="documents-panel__close" aria-label="返回聊天" onClick={onClose}><X size={19} /></button></div></header>
    <div className="documents-panel__scroll">
      {!examples ? <div className="documents-panel__empty"><FileText size={40} weight="light" /><h2>让资料，在需要时出现。</h2><p>添加资料，在本机保存并分类。现有文件仍可在工作台查看。</p><FileImportButton onProgress={onProgress} accept=".pdf,.doc,.docx,.txt,.md,.rtf,.xls,.xlsx,.ppt,.pptx,.csv" /><button onClick={onOpenHome}>到工作台管理资料<ArrowRight size={16} /></button><small>对话找答案、整理建议和资料包为本次场景原型，尚未接入真实文档理解。</small></div>
        : state !== "ready" ? <div className="documents-panel__empty" role={state === "error" ? "alert" : "status"}>{state === "error" ? <WarningCircle size={36} /> : <FolderSimple size={36} />}<h2>{state === "error" ? "这次没有打开资料。" : "资料放进来，事情就好找了。"}</h2><p>{state === "error" ? "这是连接失败的示例状态，没有改动任何文件。" : "这是空资料的示例状态。正式版可以添加资料后开始。"}</p><button onClick={() => setState("ready")}>{state === "error" ? "重试示例" : "载入示例资料"}<ArrowRight size={16} /></button></div>
          : <>
            <div className="documents-panel__intro"><span>{scene === "find" ? "01 / 找到，不止是文件" : scene === "organize" ? "02 / 你放进来，悟空理清楚" : "03 / 资料，是为了生活"}</span><h2>{title}</h2><p>{scene === "find" ? "不用记文件名。问你想知道的，答案带着出处回来。" : scene === "organize" ? "先看清归类、版本和重复，再决定怎样收好。" : examples.prepare.subtitle}</p></div>

            {scene === "find" && <section className="documents-find" aria-label="答案与原文">
              {!original && <div className="documents-find__answer"><small>从示例原文找到</small><p>{examples.find.answer}</p><span><CheckCircle size={14} />可核对 · {examples.find.source.section}</span></div>}
              <article className={`documents-source ${original ? "is-expanded" : ""}`}><header><FileText size={19} /><div><b>{examples.find.source.name}</b><span>{examples.find.source.path} · {examples.find.source.section}</span></div><small>示例文档</small></header><div className="documents-source__page"><div className="documents-source__eyebrow">使用与照料 <span>节选</span></div><h3>{examples.find.source.heading}</h3>{examples.find.source.paragraphs.map((paragraph, index) => <p key={index} className={paragraph.relevant ? "is-relevant" : ""}>{paragraph.text}</p>)}<footer>示例内容，仅用于展示答案与出处的关系。</footer></div></article>
              <p className="documents-panel__quiet">{bookmarked ? "已标为常用，仅本次预览有效。" : "不替你猜，也不藏起出处。原文始终在这里。"}</p>
            </section>}

            {scene === "organize" && <section className="documents-organize" aria-label="资料整理方案">
              <div className="documents-organize__scope"><span><FileText size={19} />{examples.organize.files.length} 份示例资料</span><ArrowRight size={18} /><span><FolderSimple size={19} />{groups.length} 个主题</span></div>
              {organized && <p className="documents-panel__feedback" role="status"><Check size={16} />方案已应用到预览 · 原文件未改动</p>}
              {compare ? <div className="documents-versions"><header><span>同一份报价，两次调整。</span><small>不是重复文件</small></header><div>{examples.organize.versions.map((version) => <article key={version.name}><small>{version.label}</small><h3>{version.name}</h3>{version.changes.map((change) => <p key={change}>{change}</p>)}</article>)}</div><p>建议以修订版为当前版本，旧版仍留在原处。只有内容完全相同的副本才标为重复。</p></div>
                : inbox ? <div className="documents-inbox"><h3>{organized ? "收纳前，是这样的。" : "先留在收件区，也没关系。"}</h3>{examples.organize.files.map((file) => <div key={file.id}><FileText size={17} /><span>{file.name}</span></div>)}<p>{organized ? "只是在查看原来的列表；已应用的示例方案仍然保留。" : "整理建议还在，准备好时再应用。"}</p></div>
                  : <div className="documents-groups">{groups.map((group, index) => <section key={group.title}><header><span>{String(index + 1).padStart(2, "0")}</span><h3>{group.title}</h3><small>{group.files.length} 份</small></header>{group.files.map((file) => <div className="documents-groups__file" key={file.id}><FileText size={17} /><div><b>{file.name}</b><small>{file.note}</small></div><em className={file.kind === "preferred" ? "is-current" : ""}>{file.kind === "preferred" ? "当前版" : file.kind === "duplicate" ? "相同副本" : file.kind === "original" ? "旧版保留" : "已归类"}</em></div>)}</section>)}</div>}
              <p className="documents-panel__quiet">不是一排新文件夹，而是你需要时找得回的关系。</p>
            </section>}

            {scene === "prepare" && <section className="documents-prepare" aria-label="事项资料包">
              <div className="documents-prepare__cover"><Package size={27} weight="light" /><div><span>{packet ? "资料包预览" : "周末 · 一家人的山野时光"}</span><b>{draft?.references.length} 份已选 · {missingItems.length} 项待补</b></div><small>草稿</small></div>
              <p className="documents-prepare__note">{editing ? "只带需要的。勾选后即可调整本次资料清单。" : "有的放在一起，缺的留一个位置。"}</p>
              <div className="documents-checklist">{examples.prepare.items.map((item) => <div key={item.id} className={!item.source ? "is-missing" : !selected.includes(item.id) ? "is-excluded" : ""}>{editing && item.source ? <input type="checkbox" aria-label={`加入资料包：${item.title}`} checked={selected.includes(item.id)} onChange={() => toggleSelected(item.id)} /> : item.source ? <CheckCircle size={20} weight={selected.includes(item.id) ? "fill" : "regular"} /> : <span className="documents-checklist__gap" />}<div><b>{item.title}</b><small>{item.source ?? "当前示例资料中尚未找到"}</small>{(packet || missing && !item.source) && <p>{item.detail}</p>}</div><span>{!item.source ? "待补" : selected.includes(item.id) ? "已备好" : "暂不带"}</span></div>)}</div>
              {missing && <p className="documents-panel__quiet">缺项来自这份示例清单，不代表已搜索你的全部文件。可以继续告诉悟空，去哪里找。</p>}
              {saved && <p className="documents-panel__feedback" role="status"><Check size={16} />示例清单已记下 · 仅当前页有效，未打包或外发</p>}
              <div className="documents-prepare__privacy"><LockKey size={14} /><span>先备齐，再决定要不要分享。<br />当前没有共享链接，也没有自动发送。</span></div>
            </section>}
          </>}
    </div>
    {ready && <footer className="documents-panel__footer"><div className="documents-panel__actions" role="group" aria-label="当前场景操作">
      {scene === "find" ? <><button className="is-primary" onClick={() => setOriginal((value) => !value)}><FileText size={16} />{original ? "返回答案" : "查看原文"}</button><button aria-pressed={bookmarked} onClick={() => setBookmarked((value) => !value)}><BookmarkSimple size={16} weight={bookmarked ? "fill" : "regular"} />{bookmarked ? "已收进常用" : "收进常用"}</button><button onClick={() => onAsk("这份说明书里，还有哪些日常保养的注意事项？")}>继续追问<ArrowRight size={15} /></button></>
        : scene === "organize" ? <><button className="is-primary" onClick={() => { setOrganized((value) => !value); setCompare(false); setInbox(false); }}>{organized ? <ArrowCounterClockwise size={16} /> : <Check size={16} />}{organized ? "撤销整理" : "应用整理方案"}</button><button onClick={() => { setCompare((value) => !value); setInbox(false); }}>{compare ? "返回整理方案" : "看看版本差异"}</button><button onClick={() => { setInbox((value) => !value); setCompare(false); }}>{inbox ? "返回整理方案" : organized ? "看看收纳前" : "先放这里"}</button></>
          : <><button className="is-primary" disabled={!draft?.references.length} onClick={() => { if (packet) { setSaved(true); setEditing(false); } else { setPacket(true); setEditing(false); } }}><Package size={16} />{packet ? saved ? "已记下清单" : "记下这份清单" : "预览资料包"}</button><button aria-pressed={editing} onClick={() => { setEditing((value) => !value); setSaved(false); }}>{editing ? "调整好了" : "调整内容"}</button><button aria-pressed={missing} onClick={() => setMissing((value) => !value)}>{missing ? "收起缺项" : "看看还缺什么"}</button></>}
    </div><small>{scene === "find" ? "答案有出处，资料有归处。" : scene === "organize" ? "可撤销，不删除原件。" : "资料留在这里，决定留给你。"}</small></footer>}
  </aside>;
}
