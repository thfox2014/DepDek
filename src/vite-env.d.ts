/// <reference types="vite/client" />
declare module "pdfjs-dist/build/pdf.worker.min.mjs";

interface ImportMetaEnv {
  readonly VITE_DEPDEK_OS?: string;
  readonly VITE_DEPDEK_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by vite.config.ts from the repository VERSION file. */
declare const __APP_VERSION__: string;
