import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Integration tests share a single Postgres `givernance_test` database
    // (also used by the worker package). Running test files in parallel
    // races on fixture cleanup and on any cross-file DDL. Keep file-level
    // parallelism off — tests WITHIN a file still run in declared order.
    fileParallelism: false,
  },
});
