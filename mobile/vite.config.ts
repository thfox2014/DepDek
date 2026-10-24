import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.MOBILE_API_PROXY || "http://127.0.0.1:8787";
  const url = new URL(target);
  if (
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "MOBILE_API_PROXY must be an explicit loopback HTTP origin. Remote transport is not enabled by this frontend.",
    );
  }
  return {
    plugins: [react()],
    base: env.VITE_MOBILE_BASE || "/",
    define: {
      __APP_VERSION__: JSON.stringify(
        readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim(),
      ),
    },
    server: {
      port: 1444,
      strictPort: true,
      host: "127.0.0.1",
      proxy: { "/api": { target, changeOrigin: false } },
    },
    preview: { port: 1444, strictPort: true, host: "127.0.0.1", proxy: {} },
    build: { outDir: "dist", target: "es2021", emptyOutDir: true },
  };
});
