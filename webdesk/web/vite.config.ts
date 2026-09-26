import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build output is embedded into the Rust binary by rust-embed
// (webdesk/src/web.rs), so it must stay at webdesk/web/dist.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5280,
    strictPort: true,
    // `npm run dev` in webdesk/web talks to a locally running depdek-webdesk.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
