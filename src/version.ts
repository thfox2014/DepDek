/**
 * Application version.
 *
 * `VERSION` in the repository root is the single source of truth; vite.config.ts
 * injects it at build time (see scripts/version.mjs). The fallback keeps unit
 * tests and any non-Vite runtime working.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
