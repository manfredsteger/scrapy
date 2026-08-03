import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
    // API tests share one DB; run files sequentially to avoid cross-talk.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
