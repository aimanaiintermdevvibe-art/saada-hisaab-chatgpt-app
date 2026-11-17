import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Tests share one database pool; run files one at a time.
    fileParallelism: false,
  },
});
