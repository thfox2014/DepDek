/** One-line voice for a teammate. Built-in roles get a specific line; everyone else gets a short introduction. */
export function personaLine(label: string): string {
  const name = label.trim();
  const key = name.toLowerCase();
  if (key === "tanvis") return "你说事，我先给结论。";
  if (name.includes("文档")) return "文件丢过来，我翻完告诉你。";
  if (name.includes("照片")) return "照片我先看，该留的标出来。";
  if (name.includes("邮件")) return "草稿我写。发出去之前一定问你。";
  if (name.includes("记忆")) return "我只提议。记不记，你说了算。";
  if (name.includes("音乐") || name.includes("视频")) return "找到就放。要删的话我会先问你。";
  return name ? `我是 ${name}。直接说你要什么。` : "直接说你要什么。";
}

const ASK_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?待确认[:：]\s*(.+?)\s*$/;

/** Pull `待确认：` lines out of an assistant reply so the chat can show them apart from the answer. */
export function splitPendingAsks(markdown: string): { body: string; asks: string[] } {
  const asks: string[] = [];
  const kept: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = ASK_LINE.exec(line);
    if (!match?.[1]) {
      kept.push(line);
      continue;
    }
    const ask = match[1].replace(/\*\*/g, "").trim();
    if (ask) asks.push(ask);
  }
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), asks };
}
