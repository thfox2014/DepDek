// Explicit UI-only model fixture. Real media extraction runs; model outputs are synthetic.
import type { ContentAnnotation, PhotoLabel } from "../../src/api";
import type { ContentAgentServices } from "../../src/lib/contentEvidence";
export function contentAgentExamples(photoLabels?: (path: string) => PhotoLabel[]): Pick<ContentAgentServices, "contentAnnotationGet" | "contentAnalyze" | "contentAnnotationUpdate" | "settingsGet"> {
  const records = new Map<string, ContentAnnotation>();
  return {
    settingsGet: async () => ({ providers: { "内容分析示例": { kind: "openai-compatible", model: "synthetic-vision", base_url: "http://127.0.0.1:11434/v1" } }, agents: [] }),
    contentAnnotationGet: async ({ reference }) => records.get(`${reference.path}:${reference.sha256}`) ?? null,
    contentAnalyze: async (input) => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const record: ContentAnnotation = { ...input.reference, title: "示例：留在海边的一刻", description: `这是界面测试标注，未调用模型。实际提取了 ${input.evidence.images.length} 个画面和 ${input.evidence.text.length} 字文本。`, tags: ["示例标签", "海边", "家庭回忆"], observations: [{ label: "证据范围", value: input.evidence.coverage }], uncertainties: ["这是假模型结果，不代表真实内容识别。"], coverage: input.evidence.coverage, provider_name: input.providerName, model: "synthetic-vision", source: "ai", total_tokens: 45, revision: input.expectedRevision + 1, created_at_ms: Date.now(), updated_at_ms: Date.now() };
      const old = records.get(`${input.reference.path}:${input.reference.sha256}`);
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new Error("content revision conflict");
      if (input.reference.path.startsWith("photos/")) record.photo_labels = photoLabels?.(input.reference.path) ?? [{ dimension: "place", label: "海边", confidence: 90, evidence: "仅用于交互测试的合成结果，未调用视觉模型" }];
      if (old?.confirmed_photo_labels !== undefined) record.confirmed_photo_labels = old.confirmed_photo_labels;
      records.set(`${input.reference.path}:${input.reference.sha256}`, record); return record;
    },
    contentAnnotationUpdate: async (input) => {
      const key = `${input.reference.path}:${input.reference.sha256}`, old = records.get(key);
      if (!old || old.revision !== input.expectedRevision) throw new Error("content revision conflict");
      const next = { ...old, title: input.title, description: input.description, tags: input.tags, ...(input.photoLabels !== undefined ? { confirmed_photo_labels: input.photoLabels } : {}), source: "user_corrected" as const, revision: old.revision + 1 };
      records.set(key, next); return next;
    },
  };
}
