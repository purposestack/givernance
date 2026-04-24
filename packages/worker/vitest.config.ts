import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Shares the `givernance_test` database with the API package. See the
    // matching comment in packages/api/vitest.config.ts — file-level
    // parallelism off to eliminate cross-file DB races.
    fileParallelism: false,
  },
});
