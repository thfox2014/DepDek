/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEPDEK_OS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
