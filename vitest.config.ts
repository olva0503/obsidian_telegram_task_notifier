import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["tests/setup.ts"]
  },
  resolve: {
    alias: {
      obsidian: resolve(__dirname, "tests/obsidian.ts")
    }
  }
});
