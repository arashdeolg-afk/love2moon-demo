// Love2moon service worker
// Strategy:
//  - Navigation requests: network-first (always try to get the freshest app shell),
//    falling back to the cached shell when offline.
//  - Static assets (scripts, styles, images, fonts, icons, manifest): cache-first,
//    falling back to network and caching the result.
//  - API / auth calls (anything under /api/ or Clerk's proxy paths): network-only,
//    NEVER cached. These responses are user/session-scoped (auth tokens, private
//    couple data), so caching them risks replaying stale or another user's data
//    after sign-out / account switch on a shared device.

const CACHE_VERSION = "love2moon-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = ["/love2moon-demo/", "/love2moon-demo/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {
        // Ignore pre-cache failures (e.g. offline install); the SW will still
        // populate the cache lazily as requests come in.
      })
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
            .filter((key) => key.startsWith("love2moon-") && key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isAuthSensitiveRequest(url) {
  // Never intercept/cache API traffic or Clerk's auth proxy paths — these carry
  // user-scoped, potentially sensitive data and must always hit the network.
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/api/") ||
    url.pathname.includes("clerk") ||
    url.hostname.includes("clerk")
  );
}

function isStaticAsset(request, url) {
  if (request.destination && ["script", "style", "image", "font"].includes(request.destination)) {
    return true;
  }
  return /\.(?:js|css|png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)$/.test(url.pathname);
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === "GET") {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("push", (event) => {
  let payload = { title: "love2moon", body: "Something new under the moon", url: "/love2moon-demo/app" };
  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch {
    // keep the fallback copy
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/love2moon-demo/icons/icon-192.png",
      badge: "/love2moon-demo/icons/favicon-32.png",
      data: { url: payload.url || "/love2moon-demo/app" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/love2moon-demo/app";
  event.waitUntil(self.clients.openWindow(url));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    // Never intercept mutating requests — let them go straight to the network.
    return;
  }

  const url = new URL(request.url);

  // Well-known files (e.g. Digital Asset Links for TWA/Play Store verification)
  // must always be served directly from the network/static host, never cached,
  // rewritten, or intercepted by the SW.
  if (url.pathname.startsWith("/.well-known/")) {
    return;
  }

  // API calls and Clerk auth traffic: always network-only, never cached or
  // served from cache, to avoid leaking/replaying user-scoped data.
  if (isAuthSensitiveRequest(url)) {
    return;
  }

  // Navigation requests (loading the app shell / client-side routes).
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, RUNTIME_CACHE).catch(() => caches.match("/love2moon-demo/"))
    );
    return;
  }

  if (url.origin === self.location.origin && isStaticAsset(request, url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else (fonts from Google, misc cross-origin calls, etc.):
  // best-effort network-first without failing the request chain.
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
