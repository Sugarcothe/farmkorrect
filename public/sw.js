// bump when precached files change so old copies (e.g. icons) are dropped
const CACHE_NAME = "farm-korrect-v4";
const OFFLINE_URL = "/";

const PRECACHE_URLS = [
  OFFLINE_URL,
  "/icons/icon-192-v2.png",
  "/icons/icon-512-v2.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

// network-first for navigations, falling back to cache when offline
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // never touch API calls or other origins; the browser handles them as usual
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // cache-first only for build assets and images; page data always hits the network
  if (!isStaticAsset(url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:png|jpe?g|webp|svg|ico|woff2?)$/.test(url.pathname)
  );
}
