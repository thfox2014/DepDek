import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VERSION is the single source of truth for the app version (scripts/version.mjs).
const appVersion = readFileSync(fileURLToPath(new URL("./VERSION", import.meta.url)), "utf8").trim();

// Browser preview: the standalone sidecar issues a per-launch token, written
// to .preview-token (0600) by scripts/dev-preview.mjs. The proxy injects it as
// an x-depdek-token header so the browser JS never touches it.
const previewToken = (() => {
  try {
    const value = readFileSync(fileURLToPath(new URL("./.preview-token", import.meta.url)), "utf8").trim();
    return value || undefined;
  } catch {
    return process.env.DEPDEK_PREVIEW_TOKEN;
  }
})();

// Tauri 2 expects a fixed dev port and no screen clearing.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 1420,
    strictPort: true,
    // Browser preview: settings are persisted by the standalone agent service
    // (sidecar) into the local data folder. Keep the port in sync with
    // DEPDEK_AGENT_HTTP_PORT (default 1421).
    proxy: {
      "/v1": {
        target: `http://127.0.0.1:${process.env.DEPDEK_AGENT_HTTP_PORT ?? "1421"}`,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (previewToken) proxyReq.setHeader("x-depdek-token", previewToken);
          });
        },
      },
    },
  },
  build: {
    target: "es2021",
  },
});
