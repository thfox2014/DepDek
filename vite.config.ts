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
  },
  build: {
    target: "es2021",
  },
});
