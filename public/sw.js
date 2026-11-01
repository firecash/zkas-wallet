/* ZKas app-shell service worker.
 *
 * Only static same-origin UI files are cached. Wallet daemon, chain, explorer,
 * pool and gateway requests are always network-only: replaying a cached balance
 * or invoice in a finance app would be worse than an honest offline error. */
// Cache name carries the build version (stamped by the vite plugin in
// vite.config.ts). A new release => a new cache name => `activate` DELETES the
// previous cache wholesale. Without this the cache was pinned at "…-v2" across
// releases, so a device that cached the broken 1.0.25 bundle kept being served
// its poisoned assets forever (the "__wbindgen_is_object requires a callable"
// reports on "latest version"). Never hardcode a fixed version here again.
const CACHE = "zkas-wallet-shell-__SW_BUILD_VERSION__";
// zkas-mark.png is the boot/loading mark. The inline splash in index.html
// carries its own copy as a data URI (nothing to fetch on first paint); this
// entry is for the React BootLoader, so a reopened wallet with no network still
// shows the brand instead of a broken image.
const SHELL = ["/", "/boot-probe.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-512-maskable.png", "/apple-touch-icon.png", "/zkas-mark.png"];

// Cross-origin isolation for the wallet running in this browser. The engine's multi-threaded
// build (every core for the proof: measured 2.2 s vs 7-8.5 s single-threaded) needs
// SharedArrayBuffer, which a page only gets with COOP/COEP headers. The worker adds them to the
// app's own pages and assets, and only once the page has said the wallet runs here (a flag in
// its own cache, so it survives the worker being stopped). COEP "credentialless" still loads
// cross-origin images and frames, just without cookies; a browser that does not know the value
// ignores it and stays on the single-threaded build.
const FLAGS = "zkas-wallet-flags";
const COI_KEY = "/__coi";

async function coiWanted() {
  try {
    return !!(await (await caches.open(FLAGS)).match(COI_KEY));
  } catch {
    return false;
  }
}

function withCoi(response) {
  if (!response || response.status === 0 || response.type === "opaque" || response.type === "opaqueredirect") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function maybeCoi(response) {
  return (await coiWanted()) ? withCoi(response) : response;
}

self.addEventListener("message", (event) => {
  const d = event.data;
  if (!d || d.type !== "coi") return;
  const port = event.ports && event.ports[0];
  event.waitUntil(
    caches
      .open(FLAGS)
      .then((c) => (d.on ? c.put(COI_KEY, new Response("1")) : c.delete(COI_KEY)))
      .then(
        () => port && port.postMessage({ ok: true }),
        () => port && port.postMessage({ ok: false }),
      ),
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== FLAGS).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

function isPrivateApi(url) {
  return url.pathname.startsWith("/daemon") || url.pathname.startsWith("/chain") || url.pathname.startsWith("/api/") || url.hostname === "api.zkas.info" || url.hostname === "mining-pool.zkas.info";
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || isPrivateApi(url)) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put("/", copy));
      return maybeCoi(response);
    }).catch(() => caches.match("/").then(maybeCoi)));
    return;
  }
  if (!url.pathname.startsWith("/assets/") && !SHELL.includes(url.pathname)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })).then(maybeCoi));
});
