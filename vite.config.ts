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

// Vite emits the app stylesheet as a plain <link rel="stylesheet"> in <head>.
// That link is render-blocking: on a cold load nothing paints at all — not even
// the inline boot splash sitting right below it in the same document — until
// ~20 KB gz of CSS has crossed the network. Measured on the production build at
// 6x CPU on slow 4G, serving the identical page with that one link removed moves
// FCP from 656ms to 344ms on phone and 644ms to 456ms on desktop. It is the
// single largest remaining item in the cold-load budget.
//
// `media="print"` makes the browser fetch the file at normal priority WITHOUT
// blocking the first paint, then `onload` promotes it to all media the moment it
// lands. This is deliberately not a dynamic import() from main.tsx: that would
// also unblock paint, but it would queue the CSS BEHIND the ~157 KB gz JS
// bundle, trading ~300ms of first paint for about a second of time-to-usable.
// Here the CSS still downloads in parallel with the JS.
//
// Nothing flashes unstyled, because the boot splash is inline-styled, covers the
// viewport, and main.tsx does not fade it until the sheet is actually applied.
// <noscript> keeps the page styled with JS off, and main.tsx re-promotes the
// link itself in case a future Content-Security-Policy blocks inline handlers.
function deferAppCss() {
  return {
    name: "defer-app-css",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      return html.replace(
        /<link rel="stylesheet"([^>]*?)href="([^"]+)"([^>]*)>/g,
        (_m, pre: string, href: string, post: string) =>
          `<link rel="stylesheet" data-app-css${pre}href="${href}"${post} media="print" onload="this.media='all';this.onload=null">` +
          `<noscript><link rel="stylesheet"${pre}href="${href}"${post}></noscript>`,
      );
    },
  };
}

// Static SPA. It talks to the user's LOCAL firecash-walletd (default
// http://127.0.0.1:8501), so the keys never touch this page's origin.
export default defineConfig({
  plugins: [react(), deferAppCss(), stampServiceWorker()],
  define: versionDefines(),
  base: "./",
  build: { outDir: "dist" },
});
