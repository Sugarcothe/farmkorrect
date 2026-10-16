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

// --- push notifications ----------------------------------------------------
// The server sends { title, body, url, tag } (lib/server/notification-delivery.ts).
// A notification only ever opens a path on this site: anything else (another
// origin, "//host", backslashes, control characters) falls back to the inbox.

const INBOX_PATH = "/notifications";

function safeInternalPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) return INBOX_PATH;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\s]/.test(value)) return INBOX_PATH;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return INBOX_PATH;
  }
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return INBOX_PATH;
    return url.pathname + url.search + url.hash;
  } catch {
    return INBOX_PATH;
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : "Farm Korret Nig";
  const options = {
    body: typeof data.body === "string" ? data.body.slice(0, 300) : "",
    icon: "/icons/icon-192-v2.png",
    badge: "/icons/icon-192-v2.png",
    data: { url: safeInternalPath(data.url) },
  };
  if (typeof data.tag === "string" && /^[a-f0-9]{24}$/.test(data.tag)) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safeInternalPath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open && "navigate" in open) {
        return open
          .navigate(target)
          .then((client) => (client || open).focus())
          .catch(() => self.clients.openWindow(target));
      }
      return self.clients.openWindow(target);
    }),
  );
});
