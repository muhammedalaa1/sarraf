import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", redis: "src/idempotency/redis.ts", conformance: "src/conformance.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  external: ["vitest"],
});
