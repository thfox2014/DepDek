import type * as api from "../api";
import { contentAgentError, prepareContentEvidence, type ContentAgentServices } from "./contentEvidence.ts";
import { isLocalProvider, providerAllowedForMode } from "./aiOsSetup.ts";

export const PHOTO_BATCH_LIMIT = 12;
export const PHOTO_DIMENSIONS = [
  { id: "people", title: "人物", hint: "你确认的人，与画面中的人物" },
  { id: "event", title: "事件", hint: "生日、旅行与值得留下的日常" },
  { id: "place", title: "景点", hint: "海边、山野与去过的地方" },
  { id: "subject", title: "内容", hint: "宠物、美食与生活里的小事" },
] as const;
export const dimensionTitle = (value: api.PhotoDimension) => PHOTO_DIMENSIONS.find((item) => item.id === value)?.title ?? value;

/** Human labels win per dimension; an explicit empty correction suppresses AI labels. */
export function resolvedPhotoLabels(photo: api.PhotoLibraryItem, annotation?: api.ContentAnnotation | null): api.ClassifiedPhoto["labels"] {
  const dimensions = { person: "people", event: "event", place: "place" } as const;
  const manual = photo.tags.flatMap((tag) => tag.kind in dimensions ? [{ dimension: dimensions[tag.kind as keyof typeof dimensions], label: tag.value, confidence: 100, evidence: "用户标注", source: "user" as const }] : []);
  const corrected = annotation?.confirmed_photo_labels !== undefined;
  const inferred = (annotation?.confirmed_photo_labels ?? annotation?.photo_labels ?? [])
    .filter((item) => !manual.some((tag) => tag.dimension === item.dimension))
    .map((item) => ({ ...item, source: corrected ? "user" as const : "ai" as const }));
  return [...new Map([...inferred, ...manual].map((item) => [`${item.dimension}:${item.label}`, item])).values()];
}

export function photoLabelCorrections(photo: api.PhotoLibraryItem, fields: Record<api.PhotoDimension, string>): api.PhotoLabel[] {
  const manual = { people: "person", event: "event", place: "place", subject: "" };
  // Existing human tags have their own 120-character contract and edit surface.
  // Never copy/shorten them into the smaller AI-classification schema.
  const labels = PHOTO_DIMENSIONS.flatMap(({ id }) => photo.tags.some((tag) => tag.kind === manual[id]) ? []
    : [...new Set(fields[id].split(/[,，\n]/).map((value) => value.trim()).filter(Boolean))]
      .map((label) => ({ dimension: id, label, confidence: 100, evidence: "用户确认" })));
  if (labels.length > 12 || labels.some((item) => [...item.label].length > 60 || /[\u0000-\u001f\u007f]/.test(item.label))) throw new Error("invalid photo classification corrections");
  return labels;
}
export type PhotoBatchProgress = { total: number; completed: number; skipped: number; failed: number; stopped: boolean; failures: { path: string; message: string }[] };
type BatchOptions = {
  photos: api.PhotoLibraryItem[]; libraryId: string; providerName: string; provider: api.ProviderConfig;
  mode: api.AiOsConnectionMode; allowRemote: boolean; services: Partial<ContentAgentServices>;
  active: () => boolean; onProgress: (progress: PhotoBatchProgress) => void;
  prepare?: typeof prepareContentEvidence;
};
/** One explicit bounded job, one image per request. No automatic retry or chat history. */
export async function classifyPhotoBatch(options: BatchOptions): Promise<PhotoBatchProgress> {
  const { photos, libraryId, providerName, provider, services, active, onProgress } = options;
  if (!libraryId || !providerName || !provider || !photos.length || photos.length > PHOTO_BATCH_LIMIT
      || photos.some((item) => item.file.category !== "photos")
      || new Set(photos.map((item) => `${item.file.path}:${item.file.sha256}`)).size !== photos.length) throw new Error("CONTENT_INVALID_BATCH");
  if (!providerAllowedForMode(provider, options.mode)) throw new Error("本地模式不能使用远端模型");
  if (!isLocalProvider(provider) && !options.allowRemote) throw new Error("CONTENT_BATCH_CONSENT_REQUIRED");
  if (!services.contentAnnotationGet || !services.contentAnalyze) throw new Error("CONTENT_SERVICE_UNAVAILABLE");
  const result: PhotoBatchProgress = { total: photos.length, completed: 0, skipped: 0, failed: 0, stopped: false, failures: [] };
  const report = () => { if (active()) onProgress({ ...result, failures: [...result.failures] }); };
  report();
  for (const photo of photos) {
    if (!active()) { result.stopped = true; break; }
    try {
      const reference = { path: photo.file.path, sha256: photo.file.sha256 };
      const old = await services.contentAnnotationGet({ libraryId, reference });
      if (!active()) { result.stopped = true; break; }
      if (old && (old.photo_labels !== undefined || old.confirmed_photo_labels !== undefined)) { result.skipped++; report(); continue; }
      const evidence = await (options.prepare ?? prepareContentEvidence)(photo.file, libraryId, services, () => {});
      if (!active()) { result.stopped = true; break; }
      if (evidence.images.length !== 1 || evidence.text.length) throw new Error("CONTENT_INVALID_PHOTO_EVIDENCE");
      const saved = await services.contentAnalyze({ libraryId, reference, providerName, evidence, expectedRevision: old?.revision ?? 0 });
      if (saved.path !== reference.path || saved.sha256 !== reference.sha256 || !Array.isArray(saved.photo_labels)) throw new Error("CONTENT_INVALID_RESULT");
      result.completed++;
    } catch (error) {
      result.failed++; result.failures.push({ path: photo.file.path, message: contentAgentError(error) });
      // A changed/locked source invalidates the batch, not just one photo.
      if (/Home changed|E32006|login required|CONTENT_(?:VISION_MODEL_REQUIRED|PROVIDER_REQUIRED|MODEL_FAILED|MODEL_TIMEOUT|AGENT_BUSY)/.test(String(error))) { result.stopped = true; report(); break; }
    }
    report();
  }
  if (!active() && result.completed + result.skipped + result.failed < result.total) result.stopped = true;
  return result;
}
