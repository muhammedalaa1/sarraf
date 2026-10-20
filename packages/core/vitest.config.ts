import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/conformance.ts"],
      // CI fails below these. Money math must stay near-fully tested.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
        "src/money.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});
