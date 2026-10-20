import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/sandbox/**/*.test.ts"], testTimeout: 60_000, retry: 0 },
});
