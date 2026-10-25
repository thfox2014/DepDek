import type * as api from "../api";

export type ContentTarget = api.ContentReference & { category: api.FileCategory };
export type ContentAgentServices = Pick<typeof api, "contentAnnotationGet" | "contentAnalyze" | "contentAnnotationUpdate" | "settingsGet" | "photoPreview" | "videoPreview" | "documentPreview">;
const TEXT_LIMIT = 24_000;
const chars = (text: string, limit = TEXT_LIMIT) => Array.from(text).slice(0, limit).join("");

function bytes(result: api.ReadBinaryResult, sha: string): Uint8Array {
  if (result.sha256.toLowerCase() !== sha.toLowerCase()) throw new Error("content changed");
  const value = Uint8Array.from(atob(result.data_base64), (char) => char.charCodeAt(0));
  if (value.length !== result.size) throw new Error("content changed");
  return value;
}
function jpeg(canvas: HTMLCanvasElement, label: string): api.ContentEvidence["images"][number] {
  const data = canvas.toDataURL("image/jpeg", .78).split(",")[1];
  if (!data || data.length > 1_398_104) throw new Error("CONTENT_FRAME_TOO_LARGE");
  return { data, mimeType: "image/jpeg", label };
}
function frame(source: CanvasImageSource, width: number, height: number, label: string) {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width * height > 100_000_000) throw new Error("CONTENT_DECODE_FAILED");
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d"); if (!context) throw new Error("CONTENT_DECODE_FAILED");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return jpeg(canvas, label);
}
function mediaEvent(target: EventTarget, event: string, action: () => void, timeout = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = () => { window.clearTimeout(timer); target.removeEventListener(event, done); target.removeEventListener("error", failed); };
    const done = () => { clear(); resolve(); }, failed = () => { clear(); reject(new Error("CONTENT_DECODE_FAILED")); };
    const timer = window.setTimeout(() => { clear(); reject(new Error("CONTENT_DECODE_TIMEOUT")); }, timeout);
    target.addEventListener(event, done, { once: true }); target.addEventListener("error", failed, { once: true });
    try { action(); } catch { failed(); }
  });
}
async function imageEvidence(result: api.ReadBinaryResult, sha: string): Promise<api.ContentEvidence> {
  const url = URL.createObjectURL(new Blob([bytes(result, sha)], { type: result.mime })), image = new Image();
  try {
    await mediaEvent(image, "load", () => { image.src = url; });
    return { text: "", images: [frame(image, image.naturalWidth, image.naturalHeight, "当前图片的完整画面（已缩放）")], coverage: "图片完整画面 · 本机缩放后分析；人物身份与拍摄时间未推断" };
  } finally { image.src = ""; URL.revokeObjectURL(url); }
}
async function videoEvidence(result: api.ReadBinaryResult, sha: string, progress: (value: string) => void): Promise<api.ContentEvidence> {
  const url = URL.createObjectURL(new Blob([bytes(result, sha)], { type: result.mime })), video = document.createElement("video");
  video.preload = "auto"; video.muted = true; video.playsInline = true;
  try {
    await mediaEvent(video, "loadeddata", () => { video.src = url; video.load(); });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("CONTENT_DECODE_FAILED");
    const count = Math.min(6, Math.max(2, Math.ceil(duration / 12)));
    const times = Array.from({ length: count }, (_, i) => Math.min(Math.max(0, duration - .15), duration * i / Math.max(1, count - 1)));
    const images: api.ContentEvidence["images"] = [];
    for (const time of times) {
      progress(`正在读取视频画面 ${images.length + 1} / ${count}…`);
      if (Math.abs(video.currentTime - time) > .01) await mediaEvent(video, "seeked", () => { video.currentTime = time; });
      images.push(frame(video, video.videoWidth, video.videoHeight, `视频 ${time.toFixed(1)} 秒处画面，全片 ${duration.toFixed(1)} 秒`));
    }
    return { text: "仅提供抽样视频画面，没有音轨或转写，不得声称听到了声音。", images, coverage: `视频 ${duration.toFixed(1)} 秒 · 抽取 ${count} 帧（${times.map((time) => time.toFixed(1)).join(" / ")} 秒）· 未分析声音` };
  } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
async function pdfEvidence(data: string, progress: (value: string) => void): Promise<api.ContentEvidence> {
  const pdfjs = await import("pdfjs-dist");
  const worker = new Worker(new URL("../workers/documentPdf.ts", import.meta.url), { type: "module" });
  const pdfWorker = pdfjs.PDFWorker.create({ port: worker });
  const task = pdfjs.getDocument({ data: Uint8Array.from(atob(data), (char) => char.charCodeAt(0)), worker: pdfWorker,
    enableXfa: false, useWorkerFetch: false, useWasm: false, useSystemFonts: true, disableFontFace: true, maxImageSize: 4_000_000, canvasMaxAreaInBytes: 16_000_000 });
  const timeout = window.setTimeout(() => { void task.destroy().catch(() => {}); worker.terminate(); }, 30_000);
  try {
    const pdf = await task.promise, limit = Math.min(8, pdf.numPages), parts: string[] = [];
    for (let page = 1; page <= limit; page++) {
      progress(`正在读取 PDF 正文 ${page} / ${limit} 页…`);
      const content = await (await pdf.getPage(page)).getTextContent();
      parts.push(`第 ${page} 页：\n${content.items.map((item) => "str" in item ? item.str : "").join(" ")}`);
    }
    const text = chars(parts.join("\n\n"));
    if (text.replace(/第 \d+ 页：/g, "").trim().length > 80) return { text, images: [], coverage: `PDF 前 ${limit} / ${pdf.numPages} 页正文 · 最多 ${TEXT_LIMIT} 字；未进行页面图像分析` };
    const images: api.ContentEvidence["images"] = [], pages = Math.min(4, pdf.numPages);
    for (let page = 1; page <= pages; page++) {
      progress(`正在读取扫描页 ${page} / ${pages}…`);
      const source = await pdf.getPage(page), base = source.getViewport({ scale: 1 });
      const scale = Math.min(1.8, 1280 / Math.max(base.width, base.height)), view = source.getViewport({ scale });
      if (!Number.isFinite(view.width * view.height) || view.width <= 0 || view.height <= 0) throw new Error("CONTENT_DECODE_FAILED");
      const canvas = document.createElement("canvas"); canvas.width = Math.ceil(view.width); canvas.height = Math.ceil(view.height);
      await source.render({ canvas, viewport: view, annotationMode: 0 }).promise;
      images.push(jpeg(canvas, `PDF 第 ${page} 页，共 ${pdf.numPages} 页`));
    }
    return { text, images, coverage: `扫描 PDF 前 ${pages} / ${pdf.numPages} 页画面；正文只提取前 ${limit} 页` };
  } finally { window.clearTimeout(timeout); await task.destroy().catch(() => {}); worker.terminate(); }
}

export async function prepareContentEvidence(file: ContentTarget, libraryId: string, service: Partial<ContentAgentServices>, progress: (value: string) => void): Promise<api.ContentEvidence> {
  progress("正在校验并读取当前文件…");
  const reference = { path: file.path, sha256: file.sha256 };
  if (file.category === "photos" && service.photoPreview) return imageEvidence(await service.photoPreview(file.path, file.sha256), file.sha256);
  if (file.category === "videos" && service.videoPreview) return videoEvidence(await service.videoPreview({ libraryId, reference }), file.sha256, progress);
  if (file.category === "documents" && service.documentPreview) {
    const result = await service.documentPreview({ libraryId, reference });
    if (result.sha256.toLowerCase() !== file.sha256.toLowerCase()) throw new Error("content changed");
    if (result.kind === "text" && result.content?.trim()) return { text: chars(result.content), images: [], coverage: `文档正文 · 最多 ${TEXT_LIMIT} 字${result.truncated || Array.from(result.content).length > TEXT_LIMIT ? "（已截取）" : ""}` };
    if (result.kind === "pdf" && result.data_base64) return pdfEvidence(result.data_base64, progress);
    throw new Error("CONTENT_DOCUMENT_UNSUPPORTED");
  }
  throw new Error("CONTENT_SERVICE_UNAVAILABLE");
}

export function contentAgentError(failure: unknown): string {
  const text = String(failure);
  if (/VISION_MODEL/.test(text)) return "当前模型不支持画面分析。请在下面选择支持图片输入的模型，再试一次。";
  if (/PROVIDER_REQUIRED/.test(text)) return "先为悟空配置一个模型，再使用 AI 自动标注。";
  if (/DOCUMENT_UNSUPPORTED/.test(text)) return "这份文档暂不能提取正文。目前支持 UTF-8 文本和 PDF。";
  if (/DECODE/.test(text)) return "当前系统未能解码这份画面。请确认原件能在本机打开。";
  if (/TIMEOUT/.test(text)) return "本次分析等待超时，尚未保存新标注，可以重试。";
  if (/AGENT_BUSY/.test(text)) return "AI Content Agent 正在分析另一份文件，请稍后重试。";
  if (/revision conflict/.test(text)) return "标注已被更新，已保留最新版本。请重新选择这份文件。";
  if (/Home changed|changed|not indexed/.test(text)) return "文件或空间已变化，请更新列表后重新选择。";
  if (/E32006|login required/.test(text)) return "空间已锁定，请重新登录。";
  if (/local|本地模式/.test(text)) return "本地模式只能使用本机模型，请在下面选择本地服务。";
  if (/INVALID_RESULT/.test(text)) return "模型没有返回有效标注，这次结果未保存。可以重试或更换模型。";
  if (/INVALID_PHOTO_LABELS/.test(text)) return "模型没有返回合规的照片分类，这次结果未保存。可以更换视觉模型或手动标注。";
  if (/BATCH_CONSENT_REQUIRED/.test(text)) return "请先确认本批照片要发送到哪个模型。";
  if (/E32003|TOO_LARGE/.test(text)) return "内容超出当前分析上限，请选择较小的文件。";
  return "AI 暂时没能完成标注。请检查模型连接后重试。";
}
