import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/worker.ts"],
  format: ["esm"],
  noExternal: ["@givernance/shared"],
  clean: true,
});