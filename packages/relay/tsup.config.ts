import { defineConfig } from "tsup";

// Mirrors packages/worker/tsup.config.ts: bundle @givernance/shared into the
// relay's dist so the production `node dist/index.js` doesn't try to resolve
// extension-less ESM imports inside the workspace package's TypeScript
// source (which fails under Node ESM resolution).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  noExternal: ["@givernance/shared"],
  clean: true,
});
