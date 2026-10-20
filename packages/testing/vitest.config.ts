import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // CI fails below these.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
