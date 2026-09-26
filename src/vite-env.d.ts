/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEPDEK_OS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by vite.config.ts from the repository VERSION file. */
declare const __APP_VERSION__: string;
