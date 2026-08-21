import type { ReactNode } from "react";

interface Props {
  markdown: string;
  className?: string;
  compact?: boolean;
}

function inlineMarkdown(text: string): ReactNode[] {
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s]+)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[2] && match[3]) {
      nodes.push(<a key={`link-${key++}`} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);
    } else if (match[4]) {
      nodes.push(<a key={`url-${key++}`} href={match[4]} target="_blank" rel="noreferrer">{match[4]}</a>);
    } else if (match[6]) {
      nodes.push(<strong key={`strong-${key++}`}>{match[6]}</strong>);
    } else if (match[8]) {
      nodes.push(<strong key={`strong-${key++}`}>{match[8]}</strong>);
    } else if (match[10]) {
      nodes.push(<em key={`em-${key++}`}>{match[10]}</em>);
    } else if (match[12]) {
      nodes.push(<code key={`code-${key++}`}>{match[12]}</code>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isBlockStart(line: string): boolean {
  return /^(#{1,6})\s+/.test(line) || /^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line) || /^>\s?/.test(line) || /^```/.test(line) || /^---+$/.test(line);
}

/** Small, safe Markdown renderer for Agent output. It intentionally supports
 * the common response grammar without injecting model output as HTML. */
export default function MarkdownText({ markdown, className = "", compact = false }: Props) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-block-${key++}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      const Heading = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Heading key={`heading-${key++}`}>{inlineMarkdown(heading[2])}</Heading>);
      index += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={`rule-${key++}`} />);
      index += 1;
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*+]\s+/, ""));
      blocks.push(<ul key={`list-${key++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+[.)]\s+/, ""));
      blocks.push(<ol key={`ordered-${key++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={`quote-${key++}`}>{quote.map((item, itemIndex) => <div key={itemIndex}>{inlineMarkdown(item)}</div>)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={`paragraph-${key++}`}>{paragraph.map((item, itemIndex) => <span key={itemIndex}>{itemIndex > 0 && <br />}{inlineMarkdown(item)}</span>)}</p>);
  }

  return <div className={`markdown-text${compact ? " markdown-text--compact" : ""}${className ? ` ${className}` : ""}`}>{blocks.length ? blocks : <p>…</p>}</div>;
}
