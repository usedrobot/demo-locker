// Service worker caching rules.
//
// These exist because the SW shipped a bug that made the app look broken in a
// way that pointed at the database: it cached same-origin API responses
// cache-first and never revalidated, so uploaded tracks never appeared and a
// week-old library could be replayed indefinitely. The Cloudflare build sets
// VITE_API_URL="" (packages/cli/scripts/build-assets.sh), which makes every API
// call same-origin, so the SW's "skip cross-origin" guard never fired.
//
// The SW is plain JS served from public/, not a module, so it's pulled in as
// source text and evaluated against a fake ServiceWorkerGlobalScope.
import { describe, expect, it, vi } from "vitest";
import SW_SRC from "../public/sw.js?raw";
const ORIGIN = "https://demolocker.dlisok.com";

type FetchEvent = {
  request: Request;
  respondWith: (r: Promise<Response>) => void;
  waitUntil: (p: Promise<unknown>) => void;
};

function loadSw() {
  const handlers: Record<string, (e: FetchEvent) => void> = {};
  const store = new Map<string, Response>();

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: FetchEvent) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };

  const caches = {
    open: async () => ({
      addAll: async () => {},
      put: async (req: Request, res: Response) => {
        store.set(req.url, res);
      },
    }),
    match: async (req: Request) => store.get(req.url),
    keys: async () => ["demo-locker-v3"],
    delete: async () => true,
  };

  const fetchMock = vi.fn(
    async () => new Response("FROM_NETWORK", { status: 200 })
  );

  new Function("self", "caches", "fetch", SW_SRC)(self, caches, fetchMock);

  return { handlers, store, fetchMock };
}

/** Returns the response the SW served, or null when it passed through to the network. */
async function handleFetch(
  sw: ReturnType<typeof loadSw>,
  url: string,
  init: RequestInit = {}
): Promise<Response | null> {
  let responded: Promise<Response> | null = null;
  const event: FetchEvent = {
    request: new Request(url, init),
    respondWith: (r) => {
      responded = r;
    },
    waitUntil: () => {},
  };
  sw.handlers.fetch(event);
  return responded ? await (responded as Promise<Response>) : null;
}

/** Seed the SW cache with a stale entry, as a real browser would after one visit. */
function seedStale(sw: ReturnType<typeof loadSw>, url: string) {
  sw.store.set(url, new Response("FROM_CACHE", { status: 200 }));
}

async function bodyOf(res: Response | null, fallback = "PASSTHROUGH") {
  return res ? await res.text() : fallback;
}

describe("service worker caching", () => {
  // The regression. Every one of these was found sitting in the live
  // demo-locker-v3 cache on a browser that had the app open.
  const API_PATHS = [
    "/tracks",
    "/playlists",
    "/auth/me",
    "/playlists/5bc74134-b67f-405f-917c-36576035fce3",
    "/shares/playlist/5bc74134-b67f-405f-917c-36576035fce3",
    "/comments/track/bcb9c097-42a3-49f8-8b4b-27e6c4d765c2",
    "/comments/playlist/5bc74134-b67f-405f-917c-36576035fce3",
    "/health",
  ];

  it.each(API_PATHS)("never serves a stale cached %s", async (path) => {
    const sw = loadSw();
    const url = `${ORIGIN}${path}`;
    seedStale(sw, url);

    const res = await handleFetch(sw, url, {
      headers: { accept: "application/json" },
    });

    expect(await bodyOf(res)).not.toBe("FROM_CACHE");
  });

  it("does not write API responses into the cache", async () => {
    const sw = loadSw();
    await handleFetch(sw, `${ORIGIN}/tracks`, {
      headers: { accept: "application/json" },
    });
    // give any un-awaited cache.put() a turn to land
    await new Promise((r) => setTimeout(r, 0));

    expect(sw.store.has(`${ORIGIN}/tracks`)).toBe(false);
  });

  it("still serves build assets cache-first", async () => {
    const sw = loadSw();
    const url = `${ORIGIN}/assets/index-BHkH0RLW.js`;
    seedStale(sw, url);

    const res = await handleFetch(sw, url);

    expect(await bodyOf(res)).toBe("FROM_CACHE");
  });

  it("caches a build asset it has not seen before", async () => {
    const sw = loadSw();
    const url = `${ORIGIN}/assets/index-DmlxaBbv.css`;

    const res = await handleFetch(sw, url);
    await new Promise((r) => setTimeout(r, 0));

    expect(await bodyOf(res)).toBe("FROM_NETWORK");
    expect(sw.store.has(url)).toBe(true);
  });

  it("serves HTML network-first", async () => {
    const sw = loadSw();
    const url = `${ORIGIN}/`;
    seedStale(sw, url);

    const res = await handleFetch(sw, url, {
      headers: { accept: "text/html" },
    });

    expect(await bodyOf(res)).toBe("FROM_NETWORK");
  });

  it("falls back to cached HTML when the network is down", async () => {
    const sw = loadSw();
    const url = `${ORIGIN}/`;
    seedStale(sw, url);
    sw.fetchMock.mockRejectedValueOnce(new Error("offline"));

    const res = await handleFetch(sw, url, {
      headers: { accept: "text/html" },
    });

    expect(await bodyOf(res)).toBe("FROM_CACHE");
  });

  it("ignores cross-origin requests", async () => {
    const sw = loadSw();
    const res = await handleFetch(sw, "https://r2.example.com/audio.m4a");
    expect(res).toBeNull();
  });

  it("ignores non-GET requests", async () => {
    const sw = loadSw();
    const res = await handleFetch(sw, `${ORIGIN}/tracks`, { method: "POST" });
    expect(res).toBeNull();
  });

  it("never touches private media", async () => {
    const sw = loadSw();
    const stream = `${ORIGIN}/tracks/abc/stream`;
    seedStale(sw, stream);

    expect(await handleFetch(sw, stream)).toBeNull();
  });
});
