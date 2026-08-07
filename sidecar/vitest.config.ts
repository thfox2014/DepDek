import { defineConfig } from "vitest/config";

// Local config so vitest does not pick up the project-root vite.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
