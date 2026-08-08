/* ZKas app-shell service worker.
 *
 * Only static same-origin UI files are cached. Wallet daemon, chain, explorer,
 * pool and gateway requests are always network-only: replaying a cached balance
 * or invoice in a finance app would be worse than an honest offline error. */
const CACHE = "zkas-wallet-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-512-maskable.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
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
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  if (!url.pathname.startsWith("/assets/") && !SHELL.includes(url.pathname)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
