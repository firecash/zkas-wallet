import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { versionDefines } from "./buildinfo";

// Static SPA. It talks to the user's LOCAL firecash-walletd (default
// http://127.0.0.1:8501), so the keys never touch this page's origin.
export default defineConfig({
  plugins: [react()],
  define: versionDefines(),
  base: "./",
  build: { outDir: "dist" },
});
