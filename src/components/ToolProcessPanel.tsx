import { useEffect, useRef } from "react";
import type { ChatBlock } from "../App";

interface Props {
  blocks: Extract<ChatBlock, { kind: "tool" }>[];
  compact?: boolean;
}

const labels: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  delete_file: "删除文件",
  list_files: "查看目录",
  search_files: "搜索文件",
  fetch_mail: "收取邮件",
  compress: "压缩归档",
};

function targetFor(block: Extract<ChatBlock, { kind: "tool" }>): string {
  const args = block.args && typeof block.args === "object" ? block.args as Record<string, unknown> : {};
  if (block.name === "compress" && typeof args.path === "string") {
    return typeof args.archive_path === "string" ? `${args.path} → ${args.archive_path}` : args.path;
  }
  if (typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return `搜索“${args.query}”`;
  if (typeof args.account === "string") return `账户：${args.account}`;
  if (block.preview) {
    const first = block.preview.split("\n").map((line) => line.trim()).find(Boolean);
    if (first) return first.length > 82 ? `${first.slice(0, 82)}…` : first;
  }
  return "本地数据";
}

export default function ToolProcessPanel({ blocks, compact = false }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const running = blocks.some((block) => block.ok === undefined);
  const failed = blocks.filter((block) => block.ok === false).length;

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [blocks.length, blocks[blocks.length - 1]?.ok, blocks[blocks.length - 1]?.preview]);

  return (
    <section className={`dd-tool-process${compact ? " dd-tool-process--compact" : ""}`} aria-label="工具处理过程">
      <header className="dd-tool-process__head">
        <span className="dd-tool-process__title"><i className={running ? "is-running" : failed ? "is-failed" : ""} />工具处理过程</span>
        <span className="dd-tool-process__summary">{running ? "处理中" : failed ? `${failed} 步失败` : `${blocks.length} 步完成`}</span>
      </header>
      <div className="dd-tool-process__log" ref={logRef}>
        {blocks.map((block) => (
          <div key={block.id} className={`dd-tool-process__line${block.ok === false ? " is-failed" : ""}`}>
            <span className={`dd-tool-process__dot${block.ok === undefined ? " is-running" : block.ok === false ? " is-failed" : ""}`} />
            <span className="dd-tool-process__action">{labels[block.name] ?? block.name}</span>
            <code title={targetFor(block)}>{targetFor(block)}</code>
            <span className="dd-tool-process__status">{block.ok === undefined ? "进行中" : block.ok === false ? "失败" : "完成"}</span>
            {block.ok === false && block.preview && <span className="dd-tool-process__detail" title={block.preview}>{block.preview}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
