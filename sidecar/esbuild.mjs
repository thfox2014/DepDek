import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outfile: "dist/sidecar.mjs",
});

// Separate opt-in worker. External SDK packages are pinned, runtime-verified
// and mounted read-only; it is not included in the legacy stdio main bundle.
await build({
  entryPoints: ["src/r1EngineWorker.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/r1-engine-worker.mjs",
});
