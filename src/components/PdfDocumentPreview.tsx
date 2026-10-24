import { ArrowLeft, ArrowRight, CircleNotch } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFWorker, RenderTask } from "pdfjs-dist";

/** Canvas-only local PDF display: no viewer links, actions, forms or scripts. */
export default function PdfDocumentPreview({ data, name }: { data: string; name: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [error, setError] = useState(""), [drawing, setDrawing] = useState(false);
  const [width, setWidth] = useState(500), holder = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true, worker: Worker | undefined, pdfWorker: PDFWorker | undefined;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    setPdf(null); setPage(1); setError("");
    const timer = window.setTimeout(() => { if (active) { setError("PDF 打开超时，可稍后重试或导出原件。"); void task?.destroy().catch(() => {}); worker?.terminate(); } }, 20000);
    void import("pdfjs-dist").then(async (library) => {
      if (!active) return;
      worker = new Worker(new URL("../workers/documentPdf.ts", import.meta.url), { type: "module" });
      pdfWorker = library.PDFWorker.create({ port: worker });
      class LocalBinaryDataFactory {
        async fetch({ kind, filename: name }: { kind: string; filename: string }) {
          const folder = kind === "cMapUrl" ? "cmaps" : kind === "standardFontDataUrl" ? "standard_fonts" : null;
          if (!folder || !/^[\w.-]+\.(bcmap|pfb|ttf)$/.test(name) || name.includes("..")) throw new Error("PDF resource unavailable");
          const url = new URL(`./pdf-assets/${folder}/${name}`, document.baseURI);
          const response = await fetch(url, { credentials: "omit", redirect: "error" });
          if (!response.ok) throw new Error("PDF resource unavailable");
          return new Uint8Array(await response.arrayBuffer());
        }
      }
      task = library.getDocument({ data: Uint8Array.from(atob(data), (char) => char.charCodeAt(0)), worker: pdfWorker, BinaryDataFactory: LocalBinaryDataFactory, enableXfa: false, useWorkerFetch: false, useWasm: false, useSystemFonts: true, disableFontFace: true, maxImageSize: 4_000_000, canvasMaxAreaInBytes: 16_000_000 });
      const loaded = await task.promise;
      if (active) { window.clearTimeout(timer); setPdf(loaded); }
      else await task.destroy();
    }).catch(() => { if (active) { window.clearTimeout(timer); setError("这份 PDF 暂不能在本机预览，可加入资料包导出原件。加密 PDF 与扫描件不会自动识别。"); } });
    return () => { active = false; window.clearTimeout(timer); void task?.destroy().catch(() => {}); pdfWorker?.destroy(); worker?.terminate(); };
  }, [data]);
  useEffect(() => {
    if (!holder.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(160, entry.contentRect.width)));
    observer.observe(holder.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let active = true, render: RenderTask | undefined;
    setDrawing(true); setError("");
    void pdf.getPage(page).then(async (source) => {
      if (!active || !canvas.current) return;
      const base = source.getViewport({ scale: 1 });
      if (!Number.isFinite(base.width * base.height) || base.width <= 0 || base.height <= 0) throw new Error("invalid PDF dimensions");
      const scale = Math.min(width / base.width, 2, Math.sqrt(4_000_000 / (base.width * base.height)));
      const view = source.getViewport({ scale }), target = canvas.current;
      target.width = Math.ceil(view.width); target.height = Math.ceil(view.height);
      render = source.render({ canvas: target, viewport: view, annotationMode: 0 });
      await render.promise;
      if (active) setDrawing(false);
    }).catch(() => { if (active) { setDrawing(false); setError("这一页未能显示，可换一页或导出原件。"); } });
    return () => { active = false; render?.cancel(); };
  }, [pdf, page, width]);
  return <div className="documents-pdf" ref={holder}>
    {error && <p role="alert">{error}</p>}
    {!pdf && !error && <p role="status"><CircleNotch className="room-spin" size={16} />正在本机打开 PDF…</p>}
    {pdf && <><div className="documents-pdf__paging"><button aria-label="PDF 上一页" disabled={page <= 1 || drawing} onClick={() => setPage((value) => value - 1)}><ArrowLeft size={16} /></button><span>{page} / {pdf.numPages} 页{drawing ? " · 绘制中" : ""}</span><button aria-label="PDF 下一页" disabled={page >= pdf.numPages || drawing} onClick={() => setPage((value) => value + 1)}><ArrowRight size={16} /></button></div><canvas ref={canvas} aria-label={`${name}，第 ${page} 页`} /></>}
    {pdf && <p>本机页面预览，不含 OCR；如有缺字或缺图，请导出原件查看。</p>}
  </div>;
}
