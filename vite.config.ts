import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VERSION is the single source of truth for the app version (scripts/version.mjs).
const appVersion = readFileSync(fileURLToPath(new URL("./VERSION", import.meta.url)), "utf8").trim();

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
      },
    },
  },
  build: {
    target: "es2021",
  },
});
