// In-memory UI fixture, not a model, persistence implementation or quality benchmark.
import type * as api from "../../src/api";
import { resolvedPhotoLabels } from "../../src/lib/photoClassification.ts";

export function photoClassificationExamples(photos: () => api.PhotoLibraryItem[], summary: api.FileIndexSummary, annotationGet: typeof api.contentAnnotationGet): typeof api.photoClassificationQuery {
  return async (input = {}) => {
    if (input.libraryId && input.libraryId !== summary.library_id) throw new Error("Home changed");
    const items: api.ClassifiedPhoto[] = [];
    const groups = new Map<string, api.PhotoClassificationGroup>();
    for (const photo of photos()) {
      const annotation = await annotationGet({ libraryId: summary.library_id ?? "", reference: { path: photo.file.path, sha256: photo.file.sha256 } });
      const labels = resolvedPhotoLabels(photo, annotation);
      const analyzed = annotation?.photo_labels !== undefined || annotation?.confirmed_photo_labels !== undefined;
      const needs_review = labels.some((item) => item.source === "ai" && item.confidence < 80) || analyzed && !labels.length && annotation?.confirmed_photo_labels === undefined;
      items.push({ ...photo, labels, analyzed, needs_review });
      for (const item of labels) {
        if (item.source === "ai" && item.confidence < 80 || input.dimension && item.dimension !== input.dimension) continue;
        const key = `${item.dimension}:${item.label}`, group = groups.get(key) ?? { dimension: item.dimension, label: item.label, total: 0, confirmed: 0, ai_suggested: 0, covers: [] };
        group.total++; if (item.source === "user") group.confirmed++; else group.ai_suggested++;
        if (group.covers.length < 3) group.covers.push(photo);
        groups.set(key, group);
      }
    }
    const ordered = [...groups.values()].sort((a,b) => b.confirmed - a.confirmed || b.total - a.total || a.label.localeCompare(b.label));
    const matched = items.filter((photo) => (input.status !== "unclassified" || !photo.analyzed) && (input.status !== "review" || photo.needs_review)
      && (!input.dimension || photo.labels.some((label) => label.dimension === input.dimension && (!input.label || label.label === input.label) && (label.source === "user" || label.confidence >= 80))));
    return structuredClone({ items: matched.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 12)), total: matched.length,
      groups: ordered.slice(input.groupOffset ?? 0, (input.groupOffset ?? 0) + 24), group_total: ordered.length,
      counts: { photos: items.length, annotated: items.filter((item) => item.analyzed).length, unclassified: items.filter((item) => !item.analyzed).length, review: items.filter((item) => item.needs_review).length }, summary });
  };
}
