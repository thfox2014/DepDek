import type * as api from "../api";

export type VideoScene = "memory" | "review" | "story";
export const VIDEO_SCENES = [
  { id: "memory", title: "找回一段", hint: "重温那个人、那一天", prompt: "找视频：海边" },
  { id: "review", title: "留下精彩", hint: "看过原片，记下你的选择", prompt: "帮我挑选值得保留的视频" },
  { id: "story", title: "串成故事", hint: "把几段原片排成故事清单", prompt: "把家人的视频串成一个故事" },
] as const;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_STORY_BYTES = 256 * 1024 * 1024;
export type VideoServices = Pick<typeof api, "videoLibraryQuery" | "videoPreview" | "videoTagsSet" | "videoStoryPut" | "fileIndexRefresh"> & Partial<Pick<typeof api, "fileLibraryImport" | "contentAnnotationGet" | "contentAnalyze" | "contentAnnotationUpdate" | "settingsGet">>;

/** A scene suggestion only, not permission to play, write or send content to a model. */
export function suggestVideoScene(text: string): VideoScene | null {
  const positive = text.slice(0, 4096).toLowerCase().replace(/(?:不要|别|不用|不想|不需要)[^，。！？!?\n]{0,24}/g, "");
  if (!/视频|录像|录影|原片|video|footage|clip/.test(positive)) return null;
  // Preserve the photo-story entry: making photos into a video is not browsing videos.
  if (/(?:照片|相片|图片|photos?).{0,24}(?:做成|串成|生成|制作).{0,12}(?:视频|影片|短片)/.test(positive)) return null;
  if (/串成|串联|故事|选片|合成|剪辑|制作|story|montage/.test(positive)) return "story";
  if (/挑选|保留|精彩|重复|去重|清理|最好|duplicate|keep/.test(positive)) return "review";
  return "memory";
}
export function videoQueryFromText(text: string): string | undefined {
  const match = text.slice(0, 4096).match(/(?:找视频|搜索视频|视频搜索|找录像)\s*[:：]\s*([^。！？\n]{1,120})/);
  if (match) return match[1].trim();
  if (/(找|搜索|查看).*(视频|录像)/.test(text)) return text.match(/[「“"]([^」”"\n]{1,120})[」”"]/)?.[1].trim();
  return undefined;
}
export const videoKey = (reference: api.VideoReference) => `${reference.path}:${reference.sha256}`;
export const videoRef = (item: api.VideoLibraryItem): api.VideoReference => ({ path: item.file.path, sha256: item.file.sha256 });
export function moveVideo(references: api.VideoReference[], index: number, delta: -1 | 1): api.VideoReference[] {
  const next = [...references], target = index + delta;
  if (index < 0 || target < 0 || index >= next.length || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
export function videoError(failure: unknown): string {
  const text = String(failure);
  if (/too.large|E32003/i.test(text)) return "超出当前处理限额：单段最多 64 MiB，故事最多 20 段 / 256 MiB，共可保存 100 个故事。原片未修改，大文件流式播放尚未接入。";
  if (/revision conflict/i.test(text)) return "记录已在别处更新。请重新打开视频列表，再保存你的修改。";
  if (/Home changed/i.test(text)) return "空间已切换，请重新打开视频。旧操作没有写入新空间。";
  if (/changed|not indexed/i.test(text)) return "原片或索引已变化，请更新 Home 索引后重新选择。";
  if (/unsupported video/i.test(text)) return "这个容器暂不能在这里播放或标注，原件未修改。";
  if (/E320|login|unauth|denied|escape/i.test(text)) return "无法访问这段原片，请确认已登录并检查来源。";
  return "视频服务暂未完成操作，请重试。原片保持原位。";
}
