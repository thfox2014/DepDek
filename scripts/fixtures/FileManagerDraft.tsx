// Layout-only draft. No Tauri, filesystem, credentials or model calls.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowClockwise, CaretRight, Check, Database, File, FileText, FolderSimple, GearSix, HardDrives, Image, Info, MagnifyingGlass, EnvelopeSimple, ShieldCheck, SidebarSimple, VideoCamera, X } from "@phosphor-icons/react";
import logo from "../../src/assets/jiaho-boot-logo.png";
import "./file-manager-draft.css";

const categories = [
  { id: "all", label: "全部文件", icon: FolderSimple },
  { id: "photos", label: "照片", icon: Image },
  { id: "documents", label: "文档", icon: FileText },
  { id: "videos", label: "视频", icon: VideoCamera },
  { id: "mail", label: "邮件", icon: EnvelopeSimple },
  { id: "other", label: "其他", icon: File },
];

function FileManagerDraft() {
  const [category, setCategory] = useState("all"), [details, setDetails] = useState(true), [compact, setCompact] = useState(false), [tweaks, setTweaks] = useState(false), [selected, setSelected] = useState<number | null>(0), [notice, setNotice] = useState("");
  const active = categories.find((item) => item.id === category)!;
  return <main className={`jiaho-files-draft ${compact ? "is-compact" : ""} ${details ? "has-details" : ""}`}>
    <div className="jfd-preview"><span>布局稿 v0 · 占位内容，不读取你的文件</span><span>家合 / 文件管理</span></div>
    <header className="jfd-header"><div className="jfd-brand"><img src={logo} alt="家合 Jiaho" /><span>家合<small>家庭 AI 中心</small></span><i /><strong>文件</strong></div><div className="jfd-local"><ShieldCheck size={15} />原件留在本机<span>AI-OS</span></div></header>
    <div className="jfd-layout">
      <aside className="jfd-rail"><div className="jfd-home"><span><HardDrives size={19} /></span><div><b>我的 Home</b><small>本地文件空间</small></div></div><p className="jfd-kicker">文件分类</p>
        <nav aria-label="文件分类">{categories.map(({ id, label, icon: Icon }) => <button key={id} aria-current={category === id ? "page" : undefined} onClick={() => {setCategory(id); setNotice("");}}><Icon size={20} weight={category === id ? "fill" : "regular"} /><span>{label}</span><small>—</small></button>)}</nav>
        <div className="jfd-secondary"><p className="jfd-kicker">按你的方式查看</p><button onClick={() => setNotice("正式版会保留现有目录浏览与预览，不会搬动原文件。 ")}><FolderSimple size={18} />目录浏览<CaretRight size={13} /></button><button onClick={() => setNotice("正式版保留原有个人资料编辑入口。 ")}><Info size={18} />个人资料<CaretRight size={13} /></button></div>
        <div className="jfd-rail-note"><Database size={18} /><b>每份文件，都有出处。</b><p>路径找到原件，<br />SHA-256 验证内容。</p></div>
      </aside>
      <section className="jfd-collection" aria-label="文件列表布局稿"><header className="jfd-collection-head"><div><p className="jfd-kicker">YOUR FILES, AT HOME</p><h1>{active.label}</h1><p>分类不搬家，文件仍在原来的位置。</p></div><button className="jfd-refresh" onClick={() => setNotice("这是布局稿。确认后会接入真实 KV 扫描，并在执行前说明 Home 范围。 ")}><ArrowClockwise size={17} /><span>建立文件索引</span></button></header>
        <div className="jfd-toolbar"><label><MagnifyingGlass size={18} /><input aria-label="搜索文件布局预览" placeholder="搜索文件名、路径或 SHA…" onChange={() => setNotice("搜索框为布局预览，尚未连接真实索引。 ")} /></label><button aria-label={details ? "收起文件详情" : "显示文件详情"} aria-pressed={details} onClick={() => setDetails(!details)}><SidebarSimple size={20} /></button></div>
        <div className="jfd-snapshot"><span><span className="jfd-dot" />索引尚未建立</span><small>文件数量 —<i />仅展示布局，不使用真实数据</small></div>
        {notice && <div className="jfd-notice" role="status"><Info size={16} /><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
        <div className="jfd-table-scroll"><div className="jfd-table-labels"><span>文件 / 所在位置</span><span>类别</span><span>大小</span><span>修改时间</span></div>
          {[0, 1, 2, 3, 4].map((item) => <button key={item} className={`jfd-placeholder-row ${item === selected ? "is-selected" : ""}`} onClick={() => {setSelected(item === selected ? null : item); setDetails(true);}} aria-label={`选择占位文件 ${item + 1}`}><span className="jfd-file-cell"><span className="jfd-file-icon"><FileText size={23} weight="light" /></span><span><b>[文件名]</b><small>[Home 内相对路径]</small></span></span><span>[类别]</span><span>—</span><span>—</span></button>)}
          <div className="jfd-draft-note"><Database size={19} /><p>文件表将来自本机 KV 索引。<small>建立索引后，照片、文档、视频与邮件会自动归类。</small></p></div>
        </div>
        <footer className="jfd-collection-footer"><ShieldCheck size={15} /><span>不移动原件 · 不自动删除重复文件</span><small>路径主键 / SHA 索引 / 分类索引</small></footer>
      </section>
      {details && <aside className="jfd-details" aria-label="文件详情布局稿"><header><span>文件详情</span><button aria-label="关闭文件详情" onClick={() => setDetails(false)}><X size={18} /></button></header><div className="jfd-details-scroll">
        <div className="jfd-detail-hero"><span><FileText size={36} weight="light" /></span><h2>{selected !== null ? "[文件名]" : "选择一份文件"}</h2><p>{selected !== null ? "[类别] · [大小]" : "在这里查看来源与内容指纹"}</p></div>
        <div className="jfd-detail-section"><h3>来源与位置</h3><dl><dt>原始路径</dt><dd>[首次索引时的完整来源路径]</dd><dt>当前路径</dt><dd>[Home 内当前相对路径]</dd></dl></div>
        <div className="jfd-detail-section"><h3>内容指纹 <span>SHA-256</span></h3><div className="jfd-sha">[完整 64 位 SHA-256]<small>同内容文件可通过哈希关联</small></div><button className="jfd-same" disabled>查找相同内容<CaretRight size={14} /></button></div>
        <div className="jfd-detail-section"><h3>识别与索引</h3><dl className="jfd-meta"><dt>识别依据</dt><dd>[格式 / 扩展名]</dd><dt>修改时间</dt><dd>—</dd><dt>索引时间</dt><dd>—</dd></dl></div>
        <div className="jfd-evidence"><Check size={17} /><p>分类只是索引视图。<small>你的文件，不会被移动或改写。</small></p></div>
      </div></aside>}
    </div>
    <button className="jfd-tweaks-toggle" aria-label="打开布局调节" onClick={() => setTweaks(!tweaks)}><GearSix size={18} /></button>
    {tweaks && <section className="jfd-tweaks" aria-label="Tweaks"><header><b>Tweaks</b><button aria-label="关闭布局调节" onClick={() => setTweaks(false)}><X size={16} /></button></header><label>列表密度<select value={compact ? "compact" : "comfortable"} onChange={(event) => setCompact(event.target.value === "compact")}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><label>右侧详情<input type="checkbox" checked={details} onChange={(event) => setDetails(event.target.checked)} /></label><small>只调整预览，不保存业务配置。</small></section>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<FileManagerDraft />);
