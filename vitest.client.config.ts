import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  test: {
    name: "client",
    include: ["client/src/**/*.test.ts", "client/src/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["client/src/test-setup.ts"],
    fileParallelism: false,
    testTimeout: 15000,
  },
});
