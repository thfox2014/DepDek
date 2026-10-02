import type { ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const token = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = token.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const value = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (value.startsWith("`")) nodes.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith("**")) nodes.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    else if (value.startsWith("~~")) nodes.push(<del key={key}>{value.slice(2, -2)}</del>);
    else if (value.startsWith("*")) nodes.push(<em key={key}>{value.slice(1, -1)}</em>);
    else nodes.push(<a key={key} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);
    cursor = match.index + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isBlockStart(line: string): boolean {
  return /^\s*(```|#{1,3}\s|[-*+]\s|\d+\.\s|>\s)/.test(line);
}

/** Small, safe Markdown subset for agent replies; raw HTML is always rendered as text. */
export default function Markdown({ children }: { children: string }) {
  const lines = children.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const key = `md-${index}`;
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Heading = `h${heading[1].length}` as "h1" | "h2" | "h3";
      blocks.push(<Heading key={key}>{inline(heading[2], key)}</Heading>);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{quote.map((row, rowIndex) => <p key={`${key}-${rowIndex}`}>{inline(row, `${key}-${rowIndex}`)}</p>)}</blockquote>);
      continue;
    }
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*+]\s/, ""));
      blocks.push(<ul key={key}>{items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+\.\s/, ""));
      blocks.push(<ol key={key}>{items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
    if (paragraph.length === 0) paragraph.push(lines[index++]);
    blocks.push(<p key={key}>{paragraph.map((row, rowIndex) => <span key={`${key}-${rowIndex}`}>{rowIndex > 0 && <br />}{inline(row, `${key}-${rowIndex}`)}</span>)}</p>);
  }
  return <div className="agent-markdown">{blocks}</div>;
}
