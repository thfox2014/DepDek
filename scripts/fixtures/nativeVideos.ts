// Isolated memory fixture. The clip is a three-second still of an AI-generated sample photo.
// It is not a real family's recording, content understanding, or an exported story.
import type { PhotoTag, VideoLibraryItem, VideoStory } from "../../src/api";
import type { VideoServices } from "../../src/lib/videoLibrary";
export const DEMO_VIDEO_SHA = "81ad0ef445d4bd4afb3dfd6ccca9da9a293ebabfb3fcb93e33928214cdbec80d";
export function videoExamples(dataBase64: string, state: "ready" | "empty" | "error" = "ready"): VideoServices {
  const libraryId = "synthetic-video-library", bytes = atob(dataBase64).length;
  let clips: VideoLibraryItem[] = state === "empty" ? [] : ["海边的一天-示例.mp4", "海边副本-示例.mp4", "假日回忆-示例.mp4"].map((name, index) => ({
    file: { name, path: `videos/${name}`, original_path: `/demo/videos/${name}`, sha256: DEMO_VIDEO_SHA, category: "videos", detected_by: "signature", size: bytes, indexed_at_ms: 1792400000000, modified_ms: 1792400000000 },
    tags: [{ kind: "event", value: index < 2 ? "海边" : "假日" }, { kind: "note", value: "AI 示例照片的静帧片段，不是真实家庭录像" }], revision: 0,
  }));
  let stories: VideoStory[] = [];
  const summary = () => ({ library_id: libraryId, coverage: "imports" as const, indexed_at_ms: 1792400000000, total: clips.length, total_bytes: clips.length * bytes, skipped: 0, categories: { photos: 0, documents: 0, videos: clips.length, mail: 0, other: 0 } });
  const source = (library: string, reference: { path: string; sha256: string }) => {
    if (library !== libraryId) throw new Error("Home changed");
    const clip = clips.find((item) => item.file.path === reference.path && item.file.sha256 === reference.sha256);
    if (!clip) throw new Error("video changed");
    return clip;
  };
  return {
    videoLibraryQuery: async (filter = {}) => {
      if (state === "error") throw new Error("synthetic query failure");
      const needle = filter.query?.toLowerCase() ?? "";
      const items = clips.filter((item) => (!filter.sha256 || item.file.sha256 === filter.sha256) && `${item.file.path} ${item.file.sha256} ${item.tags.map((tag) => tag.value).join(" ")}`.toLowerCase().includes(needle));
      return structuredClone({ items: items.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 12)), total: items.length, summary: summary(), stories });
    },
    videoPreview: async ({ libraryId: library, reference }) => { const clip = source(library, reference); return { data_base64: dataBase64, mime: "video/mp4", size: clip.file.size, sha256: clip.file.sha256 }; },
    videoTagsSet: async ({ libraryId: library, reference, tags, expectedRevision }) => {
      const clip = source(library, reference);
      if (clip.revision !== expectedRevision) throw new Error("revision conflict");
      clips = clips.map((item) => item.file.path === reference.path ? { ...item, tags: structuredClone(tags as PhotoTag[]), revision: expectedRevision + 1 } : item);
      return { path: reference.path, sha256: reference.sha256, tags: structuredClone(tags), revision: expectedRevision + 1, updated_at_ms: Date.now() };
    },
    videoStoryPut: async ({ libraryId: library, id, title, references, expectedRevision }) => {
      references.forEach((reference) => source(library, reference));
      if (new Set(references.map((reference) => reference.path)).size !== references.length || !references.length || references.length > 20) throw new Error("invalid references");
      const old = stories.find((story) => story.id === id);
      if ((old?.revision ?? 0) !== expectedRevision) throw new Error("revision conflict");
      const saved = structuredClone({ id, title, references, revision: expectedRevision + 1, updated_at_ms: Date.now() });
      stories = [saved, ...stories.filter((story) => story.id !== id)];
      return saved;
    },
    fileIndexRefresh: async () => summary(),
  };
}
