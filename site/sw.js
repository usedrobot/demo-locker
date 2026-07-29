// Kill switch. This is not a service worker for the brochure — the brochure
// doesn't want one — it exists to remove the service worker that is already
// installed on this origin.
//
// demo-locker.pages.dev used to serve the web app (the old `deploy-web` CI job,
// now `deploy-site`). Browsers that opened the app there registered
// packages/web's sw.js at scope "/", and that registration outlived the switch
// to the brochure. It serves same-origin non-HTML GETs cache-first with no
// revalidation, so those visitors kept getting a stale /style.css and /copy.js:
// the page shipped new markup for the screenshot strip while the CSS that lays
// it out came from cache, and the cards rendered as a stacked list. A normal
// reload does not help, because a reload does not bypass a service worker.
//
// The brochure is static HTML and never calls register(), so nothing here would
// ever have replaced or removed that worker on its own. But browsers re-fetch
// the *script* of an installed worker on navigation and install it if the bytes
// differ — which is the one hook we still have. Serving this file at the path
// the old worker was registered from turns that update check into an uninstall.
//
// Do not "clean this up" by deleting the file: every browser that still has the
// old worker would keep it. It can go once that population is gone, and there
// is no way to observe that from here.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();

      // Reload open tabs. Without this the current page keeps the stale
      // stylesheet it already parsed, so the visitor still sees the broken
      // layout until they navigate again of their own accord.
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.navigate(client.url);
    })()
  );
});

// No fetch handler on purpose. An installed worker with no fetch listener does
// not intercept anything, so requests go straight to the network for the short
// window between this activating and the unregister taking effect.
