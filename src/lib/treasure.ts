import type { PhotoLibraryItem, PhotoTag } from "../api";

export type TreasureScene = "memory" | "review" | "story" | "classify";
export const TREASURE_SCENES = [
  { id: "memory", title: "找回回忆", hint: "找到那个人、那一天" },
  { id: "review", title: "留下最好", hint: "比较照片，记下你的选择" },
  { id: "story", title: "成长影片", hint: "把照片串成故事草稿" },
  { id: "classify", title: "照片分类", hint: "人物、事件、景点，像翻开一副照片牌" },
] as const;

/** A local suggestion only: never an authorization to change files or contact a model. */
export function suggestTreasureScene(text: string): TreasureScene | null {
  const source = text.slice(0, 4096).toLowerCase();
  const positive = source.replace(/(?:不要|别|不用|不想|不需要)[^，。！？!?\n]{0,24}/g, "");
  if (/(成长|0\s*[到至—\-~～]\s*18|串成|做成|制作|生成).{0,18}(影片|视频|短片|故事)|成长影片|成长记录|memory film|slideshow/.test(positive)) return "story";
  if (/照片|相片|图片|相册|photo|picture|album/.test(positive) && /分类|归类|标注|标签|按人物|按事件|按景点/.test(positive)) return "classify";
  if (/照片|相片|图片|相册|连拍|宝箱|photo|picture|album/.test(positive)
    && /重复|去重|连拍|模糊|垃圾|无用|清理|最好|挑选|挑一|保留|duplicate|clean/.test(positive)) return "review";
  if (/照片|相片|图片|相册|宝箱|看海|photo|picture|album/.test(positive)) return "memory";
  return null;
}

export function photoQueryFromText(text: string): string | undefined {
  const explicit = text.match(/(?:找照片|搜索照片|找相片|照片搜索)\s*[:：]\s*([^。！？\n]{1,120})/);
  if (explicit) return explicit[1].trim();
  if (/(找|搜索|看看|查看).*(照片|相片|图片)/.test(text)) return text.match(/[「“"]([^」”"\n]{1,120})[」”"]/)?.[1].trim();
  return undefined;
}

export const tagValue = (photo: PhotoLibraryItem | undefined, kind: PhotoTag["kind"]) => photo?.tags.find((tag) => tag.kind === kind)?.value ?? "";
export const photoKey = (photo: PhotoLibraryItem) => `${photo.file.path}:${photo.file.sha256}`;

/** Explicit, editable user annotations only; no inference about a face or identity. */
export function photoTagsFromText(text: string): Partial<Record<"person" | "place" | "event" | "captured_date" | "note", string>> | null {
  const fields: Partial<Record<"person" | "place" | "event" | "captured_date" | "note", string>> = {};
  const labels = { person: "人物|姓名", place: "地点|位置", event: "事件|主题", captured_date: "拍摄日期|拍摄时间", note: "备注|想记住的话" } as const;
  for (const [key, label] of Object.entries(labels)) {
    const match = text.slice(0, 4096).match(new RegExp(`(?:${label})(?:是|叫|为|[:：])\\s*[「“\"]?([^，。；;\\n」”\"]{1,120})`));
    if (match && !/^(不要|不是|未知|不知道)/.test(match[1])) {
      const value = match[1].trim();
      if (key !== "captured_date" || validDate(value)) fields[key as keyof typeof fields] = value;
    }
  }
  return Object.keys(fields).length ? fields : null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function photoAge(captured: string, birthday: string): number | null {
  if (!validDate(captured) || !validDate(birthday) || captured < birthday) return null;
  return Number(captured.slice(0, 4)) - Number(birthday.slice(0, 4)) - Number(captured.slice(5) < birthday.slice(5));
}

export function storyFrames(photos: PhotoLibraryItem[], birthday: string) {
  return photos.map((photo) => ({ photo, captured: tagValue(photo, "captured_date"), age: photoAge(tagValue(photo, "captured_date"), birthday) }))
    .sort((a, b) => (a.captured || "9999").localeCompare(b.captured || "9999") || a.photo.file.path.localeCompare(b.photo.file.path));
}

export function missingStoryAges(photos: PhotoLibraryItem[], birthday: string): number[] {
  if (!validDate(birthday)) return [];
  const present = new Set(storyFrames(photos, birthday).map((frame) => frame.age));
  return Array.from({ length: 19 }, (_, age) => age).filter((age) => !present.has(age));
}

export function storyDraft(photos: PhotoLibraryItem[], title: string, birthday: string) {
  return {
    schema: "jiaho.photo-story.v1", title: title.trim() || "我们的成长故事", birthday: birthday || null,
    status: "selection_draft", created_at: new Date().toISOString(),
    frames: storyFrames(photos, birthday).map(({ photo, captured, age }) => ({ path: photo.file.path, sha256: photo.file.sha256, captured_date: captured || null, age, duration_seconds: 4 })),
    missing_ages: missingStoryAges(photos, birthday), output: null,
  };
}
