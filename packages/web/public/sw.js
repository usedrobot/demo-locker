// v4 evicts the v3 caches, which could be holding API responses — see below.
//
// v5 evicts v4 to ship the new logo mark. favicon.svg, manifest.json and the
// icon-*.png files are all cache-first below with no revalidation, so a visitor
// who loaded the site before the redesign would keep serving the old artwork
// out of their own cache indefinitely — the deploy would look like it silently
// failed for exactly the people who use the app most. Any future change to a
// CACHE_FIRST asset that keeps its filename needs this bumped too.
const CACHE_NAME = "demo-locker-v5";
const SHELL_ASSETS = ["/", "/index.html"];

// Only build output is safe to serve cache-first, and this is an allowlist
// rather than an API denylist on purpose.
//
// v3 tried to keep the API out by skipping cross-origin requests, assuming the
// API always lives on another host. That holds for the split Pages + Worker
// deploy, but the Cloudflare and standalone builds set VITE_API_URL=""
// (packages/cli/scripts/build-assets.sh), so the app calls /tracks, /playlists
// and /auth/me on its own origin. Those fell through to the cache-first branch
// and were then served forever with no revalidation: uploaded tracks never
// appeared, and a library cached in one session could be replayed days later.
// Because the Cache API keys on URL and ignores the Authorization header, a
// cached /auth/me could even hand one account's data to the next account
// signed in on that browser.
//
// A denylist would need updating every time the API grows a route, and missing
// one reintroduces exactly that bug. An allowlist fails closed: a new route is
// uncached until someone deliberately adds it here.
const CACHE_FIRST =
  /^\/(assets\/|favicon\.svg$|icons\.svg$|manifest\.json$|icon-\d+\.png$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // skip non-GET and any cross-origin request (R2, a split-deploy API, etc.)
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // network-first for HTML, so a deploy is picked up on the next navigation
  // while the shell still works offline.
  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || new Response("Offline", { status: 503 }))
        )
    );
    return;
  }

  // cache-first for build output only. Everything else — every API route, and
  // token-gated media like /tracks/<id>/stream and /playlists/<id>/artwork —
  // is left alone and goes to the network untouched.
  if (!CACHE_FIRST.test(url.pathname)) return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
    )
  );
});
