import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// VERSION is the single source of truth for the app version (scripts/version.mjs).
const appVersion = readFileSync(fileURLToPath(new URL("./VERSION", import.meta.url)), "utf8").trim();

// PDF fonts/CMaps ship with the app. Never use a public CDN or expose a disk path.
function localPdfAssets(): Plugin {
  const assets = new Map<string, Buffer>();
  for (const folder of ["cmaps", "standard_fonts"]) {
    const directory = new URL(`./node_modules/pdfjs-dist/${folder}/`, import.meta.url);
    for (const name of readdirSync(directory)) {
      if (!/^[\w.-]+\.(bcmap|pfb|ttf)$/.test(name) && !/^LICENSE(?:_[A-Z]+)?$/.test(name)) continue;
      assets.set(`pdf-assets/${folder}/${name}`, readFileSync(new URL(name, directory)));
    }
  }
  assets.set("pdf-assets/LICENSE_PDFJS", readFileSync(new URL("./node_modules/pdfjs-dist/LICENSE", import.meta.url)));
  return {
    name: "depdek-local-pdf-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const content = assets.get(request.url?.split("?")[0].slice(1) ?? "");
        if (!content) return next();
        if (request.method !== "GET" && request.method !== "HEAD") { response.statusCode = 405; response.end(); return; }
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Cache-Control", "no-store");
        response.end(request.method === "HEAD" ? undefined : content);
      });
    },
    generateBundle() { for (const [fileName, source] of assets) this.emitFile({ type: "asset", fileName, source }); },
  };
}

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
  plugins: [react(), localPdfAssets()],
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
