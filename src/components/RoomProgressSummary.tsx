import { Check, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ChatBlock } from "../App";

const TOOL_NAMES: Record<string, string> = { read_file: "读取资料", list_files: "查看目录", search_files: "检索资料", search_media: "查找照片", open_media: "预览照片", write_file: "保存资料", delete_file: "删除文件", compress: "归档资料" };

export default function RoomProgressSummary({ blocks, local = [], running }: { blocks: ChatBlock[]; local?: string[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null), following = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const localRevision = local.join("\n"), localVersion = useRef("");
  const localAnchor = useRef<number>();
  if (localVersion.current !== localRevision) { localVersion.current = localRevision; localAnchor.current = blocks[blocks.length - 1]?.id; }
  const latestUser = blocks.reduce((last, block, index) => block.kind === "user" ? index : last, 0);
  const runtime = blocks.slice(latestUser).flatMap((block) => {
    if (block.kind === "status") return [{ key: `s${block.id}`, id: block.id, text: block.text, state: "status" }];
    if (block.kind === "tool") return [{ key: `t${block.id}`, id: block.id, text: `${TOOL_NAMES[block.name] ?? block.name} · ${block.ok === undefined ? "进行中" : block.ok ? "已完成" : "未完成"}`, state: block.ok === false ? "error" : block.ok === undefined ? "running" : "done" }];
    return [];
  });
  const lines = [...runtime.filter((line) => line.id <= (localAnchor.current ?? 0)), ...local.map((text, index) => ({ key: `l${index}`, text, state: "status" })), ...runtime.filter((line) => line.id > (localAnchor.current ?? 0))].slice(-48);
  const revision = lines.map((line) => `${line.key}:${line.text}`).join("|");
  useEffect(() => {
    if (following.current && ref.current) { ref.current.scrollTop = ref.current.scrollHeight; setUnseen(false); }
    else setUnseen(true);
  }, [revision]);
  if (!lines.length && !running) return null;
  return <section className="treasure-progress" aria-label="处理摘要">
    <header><span>{running ? <CircleNotch size={13} className="room-spin" /> : <Check size={13} />}处理摘要</span>{unseen && <button onClick={() => { following.current = true; if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; setUnseen(false); }}>有新进度</button>}</header>
    <div ref={ref} className="treasure-progress__lines" role="log" aria-live="polite" tabIndex={0} onScroll={() => { const node = ref.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 12; }}>
      {lines.length ? lines.map((line) => <div key={line.key} title={line.text} className={line.state === "error" ? "is-error" : ""}>{line.state === "error" ? <WarningCircle size={12} /> : <span className="treasure-progress__dot" />}<span>{line.text}</span></div>) : <div><CircleNotch className="room-spin" size={12} /><span>悟空正在处理这次请求…</span></div>}
    </div>
  </section>;
}
