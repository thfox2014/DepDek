export type DocumentScene = "find" | "organize" | "prepare";

export const DOCUMENT_SCENES = [
  { id: "find", title: "找一份", hint: "一句话，找到答案和出处", prompt: "洗碗机的滤网怎么清洗？帮我找一下说明书。" },
  { id: "organize", title: "理一摞", hint: "归类、重复、版本，一次理清", prompt: "刚放进来的装修资料，帮我理一理。" },
  { id: "prepare", title: "办一件事", hint: "围绕一件事，把资料备齐", prompt: "周末去露营，帮我把要用的资料准备好。" },
] as const;

/** Local routing hint only. Never grants file access or authorizes an operation. */
export function suggestDocumentScene(text: string): DocumentScene | null {
  const positive = text.slice(0, 4096).toLowerCase().replace(/(?:不要|别|不用|不想|不需要)[^，。！？!?\n]{0,24}/g, "");
  if (!/资料|文档|文件|说明书|发票|报价|合同|材料|document|paperwork/.test(positive)) return null;
  if (/资料包|材料包|备齐|准备|清单|缺[了哪什么]|办一件事|出行|露营|入学|打包/.test(positive)) return "prepare";
  if (/整理|理一理|理一摞|收好|收纳|归类|分类|重复|去重|版本|一堆|一摞|organize/.test(positive)) return "organize";
  if (/找|查|哪里|在哪|怎么|如何|哪一|搜索|是什么|find|search/.test(positive)) return "find";
  return null;
}

// Example content is supplied by the isolated preview, never loaded from Home.
export interface DocumentExamples {
  find: {
    answer: string;
    source: { name: string; path: string; section: string; heading: string; paragraphs: { text: string; relevant?: boolean }[] };
  };
  organize: {
    title: string;
    files: { id: string; name: string; group: string; note: string; kind: "original" | "preferred" | "duplicate" | "normal" }[];
    versions: { label: string; name: string; changes: string[] }[];
  };
  prepare: {
    title: string;
    subtitle: string;
    items: { id: string; title: string; source?: string; detail: string }[];
  };
}

export function documentGroups(examples: DocumentExamples["organize"]) {
  return [...new Set(examples.files.map((file) => file.group))].map((title) => ({ title, files: examples.files.filter((file) => file.group === title) }));
}

/** A preview checklist contains references only; it is not an exported bundle. */
export function documentPacketDraft(examples: DocumentExamples["prepare"], selected: readonly string[]) {
  const ids = new Set(selected);
  return {
    status: "preview_only" as const,
    title: examples.title,
    references: examples.items.filter((item) => item.source && ids.has(item.id)).map((item) => ({ title: item.title, source: item.source })),
    missing: examples.items.filter((item) => !item.source).map((item) => item.title),
    output: null,
    shared: false,
  };
}
