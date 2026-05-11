import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Shares the `givernance_test` database with the api + worker packages —
    // see the matching comment in their vitest configs. File-level
    // parallelism off so cross-file DDL / fixture cleanup can't race.
    fileParallelism: false,
  },
});
