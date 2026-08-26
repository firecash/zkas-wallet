import { defineConfig } from "vitest/config";
import { versionDefines } from "./buildinfo";

export default defineConfig({
  // The app build injects these; without them here every test read the
  // "dev" fallback and the version display was effectively untested.
  define: versionDefines(),
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
