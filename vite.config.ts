import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { versionDefines } from "./buildinfo";

// Stamp the app version into the copied service worker so every release gets a
// fresh cache name (see public/sw.js). publicDir files are copied verbatim, so
// the placeholder is replaced here after the bundle is written.
function stampServiceWorker() {
  const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;
  return {
    name: "stamp-sw-version",
    closeBundle() {
      const swPath = new URL("./dist/sw.js", import.meta.url);
      try {
        const src = readFileSync(swPath, "utf8");
        writeFileSync(swPath, src.replace(/__SW_BUILD_VERSION__/g, version));
      } catch {
        /* no sw.js in this build target — nothing to stamp */
      }
    },
  };
}

// Static SPA. It talks to the user's LOCAL firecash-walletd (default
// http://127.0.0.1:8501), so the keys never touch this page's origin.
export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  define: versionDefines(),
  base: "./",
  build: { outDir: "dist" },
});
