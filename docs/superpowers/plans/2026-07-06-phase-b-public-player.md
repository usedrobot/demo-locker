# Phase B: Public Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playlist can be marked public and embedded on any website via `<script src=".../embed.js">` + `<demo-locker-player playlist="...">`, backed by an unauthenticated read-only `/public/v1` API.

**Architecture:** One new `is_public` column gates three new read-only routes in a `public.ts` router mounted on the shared Hono app (works on Worker + Node). The range-streaming logic is extracted from `tracks.ts` into a shared helper so both private and public stream routes use one implementation. The player is a zero-dependency vanilla web component in a new `packages/player` workspace, built to a single IIFE and served at `/embed.js` (Node: read from disk into a binding; Worker: Cloudflare static assets).

**Tech Stack:** Hono 4, Drizzle 0.45.2, PGlite (tests), Vite lib-mode (player build), vanilla Custom Elements + Shadow DOM.

**Spec:** `docs/superpowers/specs/2026-07-06-phase-b-public-player-design.md`

## Global Constraints

- Branch: `feat/phase-b-public-player` (create from up-to-date `main` at Task 1; do NOT commit to main).
- **Non-enumerable 404s:** every public endpoint returns the identical `{ error: "not found" }` 404 for private and nonexistent resources — no distinguishable errors.
- Public surface is EXACTLY: playlist name, artwork, track id/title/duration/order, streams. No comments, owner info, invite data, `originalKey`/`streamKey`, or timestamps in public payloads.
- Column name: `is_public` (Drizzle property `isPublic`), `boolean NOT NULL DEFAULT false`.
- Schema change via `drizzle-kit generate` only; never applied to prod Neon by anything in this plan (prod gets it at deploy time via the cloud process — out of scope here; fresh installs get it from the migrations folder).
- Existing private endpoints keep their exact behavior except: `PATCH /playlists/:id` learns `isPublic`, and `index.ts`'s no-store middleware learns to skip `/public/` and `/embed.js` paths.
- TypeScript ESM, `.js` import suffixes in packages/api. `npm run typecheck` green at every commit.
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `is_public` column + migration + PATCH support

**Files:**
- Modify: `packages/api/src/db/schema.ts` (playlists table — add one line + import)
- Create: `packages/api/src/db/migrations/0002_*.sql` (generated)
- Modify: `packages/api/src/routes/playlists.ts:89-91` (PATCH updates)
- Test: `packages/api/src/db/pglite.test.ts` (extend)

**Interfaces:**
- Produces: `playlists.isPublic: boolean` (Drizzle column, `is_public` in SQL) — Tasks 2 and 5 depend on it. PATCH `/playlists/:id` accepts `{ isPublic: boolean }`.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b feat/phase-b-public-player
```

- [ ] **Step 2: Write the failing test**

In `packages/api/src/db/pglite.test.ts`, add inside the existing `describe`:

```ts
  it("playlists have is_public defaulting to false", async () => {
    const db = await createPgliteDb();
    const [user] = await db
      .insert(users)
      .values({ email: "pub@test.dev", passwordHash: "x" })
      .returning();
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId: user.id, name: "p" })
      .returning();
    expect(pl.isPublic).toBe(false);
  });
```

Add `playlists` to the existing schema import in the test file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w packages/api`
Expected: FAIL — `isPublic` does not exist on the returned row (TS error or undefined ≠ false).

- [ ] **Step 4: Add the column and regenerate migrations**

In `packages/api/src/db/schema.ts`: add `boolean` to the `drizzle-orm/pg-core` import list, and in the `playlists` table add after `artworkKey`:

```ts
  isPublic: boolean("is_public").notNull().default(false),
```

Then:

```bash
cd packages/api && npx drizzle-kit generate
cat src/db/migrations/0002_*.sql
```

Expected: exactly one statement — `ALTER TABLE "playlists" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;`. If anything else appears, STOP and report (unexpected drift).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w packages/api`
Expected: PASS (all tests).

- [ ] **Step 6: Accept isPublic in PATCH**

In `packages/api/src/routes/playlists.ts`, in the PATCH `/:id` handler where `updates` is built (after the `artworkKey` line, ~line 91):

```ts
  if (typeof body.isPublic === "boolean") updates.isPublic = body.isPublic;
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add packages/api/src/db packages/api/src/routes/playlists.ts
git commit -m "feat(api): is_public playlist column + PATCH support"
```

---

### Task 2: Shared stream helper + `/public/v1` routes with boundary tests

**Files:**
- Create: `packages/api/src/lib/stream-response.ts` (extracted from tracks.ts)
- Modify: `packages/api/src/routes/tracks.ts:91-121` (use the helper)
- Create: `packages/api/src/routes/public.ts`
- Modify: `packages/api/src/index.ts` (mount router; widen no-store skip)
- Test: `packages/api/src/routes/public.test.ts`

**Interfaces:**
- Consumes: `playlists.isPublic` (Task 1), `StorageBucket` (existing), `getDb`/`setDbFactory`, `createPgliteDb`, `createFsBucket`.
- Produces: `buildStreamResponse(rangeHeader: string | undefined, bucket: StorageBucket, key: string): Promise<Response>`; routes `GET /public/v1/playlists/:id`, `GET /public/v1/playlists/:id/artwork`, `GET /public/v1/tracks/:id/stream`. Task 3's player consumes these payload shapes; Task 6's smoke test hits these paths.

- [ ] **Step 1: Extract the stream helper**

Create `packages/api/src/lib/stream-response.ts` with the exact logic currently in `tracks.ts`'s stream route (lines 91-121), parameterized:

```ts
// Shared range-capable audio streaming used by the private and public stream routes.

import type { StorageBucket } from "./storage.js";

export async function buildStreamResponse(
  rangeHeader: string | undefined,
  bucket: StorageBucket,
  key: string
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    return Response.json({ error: "file not found" }, { status: 404 });
  }

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "audio/mpeg");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=3600");

  if (rangeHeader && object.size) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : object.size - 1;
      const sliced = await bucket.get(key, {
        range: { offset: start, length: end - start + 1 },
      });
      if (sliced) {
        headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
        headers.set("Content-Length", String(end - start + 1));
        return new Response(sliced.body, { status: 206, headers });
      }
    }
  }

  if (object.size) {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { headers });
}
```

In `packages/api/src/routes/tracks.ts`, replace the body of the `GET /:id/stream` handler from the `const object = await c.env.DEMOS_BUCKET.get(...)` line through the final `return new Response(...)` with:

```ts
  return buildStreamResponse(c.req.header("Range"), c.env.DEMOS_BUCKET, track.streamKey);
```

and add the import: `import { buildStreamResponse } from "../lib/stream-response.js";`
(The track lookup + `!track || !track.streamKey` 404 check above it stays.)

- [ ] **Step 2: Verify no regression**

Run: `npm test -w packages/api && npm run typecheck`
Expected: all pass.

- [ ] **Step 3: Write the failing boundary tests**

Create `packages/api/src/routes/public.test.ts`. This is an integration test: real app, PGlite db, tmp-dir fs bucket, requests via `app.request(path, init, env)`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createPgliteDb } from "../db/pglite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, playlists, tracks } from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;
let publicId: string;
let privateId: string;
let publicTrackId: string;
let privateTrackId: string;

beforeAll(async () => {
  db = await createPgliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-public-"));
  const bucket = createFsBucket(root);
  env = { DATABASE_URL: "pglite", DEMOS_BUCKET: bucket };

  const [user] = await db
    .insert(users)
    .values({ email: "owner@test.dev", passwordHash: "x" })
    .returning();
  const [pub] = await db
    .insert(playlists)
    .values({ ownerId: user.id, name: "public one", isPublic: true })
    .returning();
  const [priv] = await db
    .insert(playlists)
    .values({ ownerId: user.id, name: "private one" })
    .returning();
  publicId = pub.id;
  privateId = priv.id;

  await bucket.put("k-pub", Buffer.from("0123456789"), {
    httpMetadata: { contentType: "audio/wav" },
  });
  await bucket.put("k-priv", Buffer.from("0123456789"));
  const [tPub] = await db
    .insert(tracks)
    .values({ playlistId: publicId, title: "pub track", position: 0, originalKey: "k-pub", streamKey: "k-pub", duration: 1.5 })
    .returning();
  const [tPriv] = await db
    .insert(tracks)
    .values({ playlistId: privateId, title: "priv track", position: 0, originalKey: "k-priv", streamKey: "k-priv" })
    .returning();
  publicTrackId = tPub.id;
  privateTrackId = tPriv.id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("public API boundary", () => {
  it("returns metadata for a public playlist with only the public fields", async () => {
    const res = await app.request(`/public/v1/playlists/${publicId}`, {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playlist.name).toBe("public one");
    expect(body.playlist.tracks).toHaveLength(1);
    expect(body.playlist.tracks[0]).toEqual({ id: publicTrackId, title: "pub track", duration: 1.5 });
    // no private fields anywhere in the payload
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ownerId");
    expect(raw).not.toContain("streamKey");
    expect(raw).not.toContain("originalKey");
  });

  it("404s a private playlist identically to a nonexistent one", async () => {
    const priv = await app.request(`/public/v1/playlists/${privateId}`, {}, env);
    const missing = await app.request(`/public/v1/playlists/00000000-0000-0000-0000-000000000000`, {}, env);
    expect(priv.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await priv.text()).toBe(await missing.text());
  });

  it("streams a public track without auth, honoring ranges", async () => {
    const res = await app.request(
      `/public/v1/tracks/${publicTrackId}/stream`,
      { headers: { Range: "bytes=2-5" } },
      env
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
  });

  it("404s a stream whose parent playlist is private", async () => {
    const res = await app.request(`/public/v1/tracks/${privateTrackId}/stream`, {}, env);
    expect(res.status).toBe(404);
  });

  it("revokes access when a playlist is made private again", async () => {
    const { eq } = await import("drizzle-orm");
    await db.update(playlists).set({ isPublic: false }).where(eq(playlists.id, publicId));
    const res = await app.request(`/public/v1/playlists/${publicId}`, {}, env);
    expect(res.status).toBe(404);
    await db.update(playlists).set({ isPublic: true }).where(eq(playlists.id, publicId));
  });

  it("sets short public caching on metadata (not no-store)", async () => {
    const res = await app.request(`/public/v1/playlists/${publicId}`, {}, env);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});
```

NOTE: `setDbFactory(() => db)` is module-global — vitest runs test FILES in separate workers by default, so this cannot leak into other test files. Verify that assumption holds by running the full suite in Step 6.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -w packages/api`
Expected: the new file fails with 404s on every request (router not mounted yet).

- [ ] **Step 5: Implement the public router**

Create `packages/api/src/routes/public.ts`:

```ts
// Unauthenticated read-only API for playlists marked public.
// Rule: private and nonexistent are indistinguishable — same 404 body.

import { Hono } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { buildStreamResponse } from "../lib/stream-response.js";
import type { Env } from "../types.js";

const publicRouter = new Hono<Env>();

const NOT_FOUND = { error: "not found" } as const;

publicRouter.get("/playlists/:id", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!playlist) return c.json(NOT_FOUND, 404);

  const trackRows = await db
    .select({ id: tracks.id, title: tracks.title, duration: tracks.duration })
    .from(tracks)
    .where(eq(tracks.playlistId, id))
    .orderBy(asc(tracks.position));

  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    playlist: {
      id: playlist.id,
      name: playlist.name,
      artworkUrl: playlist.artworkKey ? `/public/v1/playlists/${playlist.id}/artwork` : null,
      tracks: trackRows,
    },
  });
});

publicRouter.get("/playlists/:id/artwork", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!playlist || !playlist.artworkKey) return c.json(NOT_FOUND, 404);

  const object = await c.env.DEMOS_BUCKET.get(playlist.artworkKey);
  if (!object) return c.json(NOT_FOUND, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

publicRouter.get("/tracks/:id/stream", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

  const [row] = await db
    .select({ streamKey: tracks.streamKey })
    .from(tracks)
    .innerJoin(playlists, eq(tracks.playlistId, playlists.id))
    .where(and(eq(tracks.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!row || !row.streamKey) return c.json(NOT_FOUND, 404);

  return buildStreamResponse(c.req.header("Range"), c.env.DEMOS_BUCKET, row.streamKey);
});

export default publicRouter;
```

In `packages/api/src/index.ts`:
1. `import publicRouter from "./routes/public.js";`
2. Mount after the existing routes: `app.route("/public/v1", publicRouter);`
3. Widen the no-store middleware condition:

```ts
  if (
    !c.req.path.includes("/stream") &&
    !c.req.path.startsWith("/public/") &&
    c.req.path !== "/embed.js"
  ) {
    c.header("Cache-Control", "no-store");
  }
```

(CORS: `app.use("/*", cors())` already allows all origins app-wide — nothing to add for the public routes, nothing changes for private ones.)

- [ ] **Step 6: Run the full suite**

Run: `npm test -w packages/api && npm run typecheck`
Expected: all pass, including all pre-existing files (verifies the setDbFactory isolation note in Step 3).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): /public/v1 read-only API + shared stream helper"
```

---

### Task 3: `packages/player` — the web component

**Files:**
- Create: `packages/player/package.json`
- Create: `packages/player/tsconfig.json`
- Create: `packages/player/vite.config.ts`
- Create: `packages/player/src/player.ts`

**Interfaces:**
- Consumes: `GET {instance}/public/v1/playlists/:id` → `{ playlist: { id, name, artworkUrl, tracks: [{ id, title, duration }] } }`; `GET {instance}/public/v1/tracks/:id/stream` (Task 2).
- Produces: `packages/player/dist/embed.js` (IIFE, self-contained) defining `<demo-locker-player instance? playlist>`; Tasks 4 and 6 depend on that build artifact path.

- [ ] **Step 1: Scaffold the workspace**

`packages/player/package.json`:

```json
{
  "name": "@demo-locker/player",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^8.0.1"
  }
}
```

`packages/player/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true
  },
  "include": ["src"]
}
```

`packages/player/vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/player.ts",
      name: "DemoLockerPlayer",
      formats: ["iife"],
      fileName: () => "embed.js",
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

Then `npm install` at the repo root (links the new workspace).

- [ ] **Step 2: Implement the component**

Create `packages/player/src/player.ts`:

```ts
// <demo-locker-player playlist="..." [instance="https://your-box"]>
// Zero-dependency web component. Fetches /public/v1 metadata and streams audio.
// Theming: every visual value is a --dl-* custom property; structural nodes
// carry part="" attributes for ::part() styling.

type Track = { id: string; title: string; duration: number | null };
type PlaylistData = {
  id: string;
  name: string;
  artworkUrl: string | null;
  tracks: Track[];
};

// Origin of the script that loaded us — the default instance.
const SCRIPT_ORIGIN = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL(src).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

function formatTime(secs: number | null): string {
  if (secs == null || !isFinite(secs)) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const STYLES = `
:host {
  --dl-bg: #0d0d0d;
  --dl-fg: #d8d8d8;
  --dl-accent: #5fd75f;
  --dl-muted: #6b6b6b;
  --dl-border: #2e2e2e;
  --dl-font: "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --dl-font-size: 13px;
  --dl-radius: 0;
  --dl-padding: 12px;
  display: block;
  background: var(--dl-bg);
  color: var(--dl-fg);
  font-family: var(--dl-font);
  font-size: var(--dl-font-size);
  border: 1px solid var(--dl-border);
  border-radius: var(--dl-radius);
  max-width: 100%;
}
* { box-sizing: border-box; }
.header { display: flex; gap: var(--dl-padding); padding: var(--dl-padding); border-bottom: 1px solid var(--dl-border); align-items: center; }
.artwork { width: 64px; height: 64px; object-fit: cover; border: 1px solid var(--dl-border); flex: none; }
.artwork.empty { display: flex; align-items: center; justify-content: center; color: var(--dl-muted); }
.title { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transport { display: flex; align-items: center; gap: 8px; padding: 8px var(--dl-padding); border-bottom: 1px solid var(--dl-border); }
button { background: none; border: 1px solid var(--dl-border); color: var(--dl-fg); font: inherit; cursor: pointer; padding: 2px 8px; }
button:hover { border-color: var(--dl-accent); color: var(--dl-accent); }
.time { color: var(--dl-muted); font-size: 0.9em; white-space: nowrap; }
.seek { flex: 1; appearance: none; height: 4px; background: var(--dl-border); cursor: pointer; }
.seek::-webkit-slider-thumb { appearance: none; width: 10px; height: 14px; background: var(--dl-accent); }
.seek::-moz-range-thumb { width: 10px; height: 14px; background: var(--dl-accent); border: none; border-radius: 0; }
.tracks { list-style: none; margin: 0; padding: 4px 0; max-height: 240px; overflow-y: auto; }
.tracks li { display: flex; justify-content: space-between; gap: 8px; padding: 4px var(--dl-padding); cursor: pointer; }
.tracks li:hover { color: var(--dl-accent); }
.tracks li.active { color: var(--dl-accent); }
.tracks li .dur { color: var(--dl-muted); }
.status { padding: var(--dl-padding); color: var(--dl-muted); }
.footer { padding: 4px var(--dl-padding); border-top: 1px solid var(--dl-border); font-size: 0.85em; }
.footer a { color: var(--dl-muted); text-decoration: none; }
.footer a:hover { color: var(--dl-accent); }
`;

class DemoLockerPlayer extends HTMLElement {
  private shadow: ShadowRoot;
  private audio = new Audio();
  private data: PlaylistData | null = null;
  private current = -1;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.audio.preload = "none";
    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("timeupdate", () => this.updateTime());
    this.audio.addEventListener("play", () => this.render());
    this.audio.addEventListener("pause", () => this.render());
  }

  get instance(): string {
    return this.getAttribute("instance") || SCRIPT_ORIGIN;
  }

  async connectedCallback() {
    const playlistId = this.getAttribute("playlist");
    if (!playlistId) {
      this.renderStatus("demo-locker-player: missing playlist attribute");
      return;
    }
    this.renderStatus("loading…");
    try {
      const res = await fetch(`${this.instance}/public/v1/playlists/${playlistId}`);
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()).playlist;
      this.render();
    } catch {
      this.renderStatus("playlist unavailable");
    }
  }

  disconnectedCallback() {
    this.audio.pause();
  }

  private streamUrl(trackId: string): string {
    return `${this.instance}/public/v1/tracks/${trackId}/stream`;
  }

  private play(index: number) {
    if (!this.data || !this.data.tracks[index]) return;
    if (this.current === index) {
      if (this.audio.paused) this.audio.play();
      else this.audio.pause();
      return;
    }
    this.current = index;
    this.audio.src = this.streamUrl(this.data.tracks[index].id);
    this.audio.play();
    this.render();
  }

  private next() {
    if (!this.data) return;
    if (this.current + 1 < this.data.tracks.length) this.play(this.current + 1);
    else this.render();
  }

  private prev() {
    if (this.current > 0) this.play(this.current - 1);
  }

  private updateTime() {
    const time = this.shadow.querySelector(".time");
    const seek = this.shadow.querySelector<HTMLInputElement>(".seek");
    if (time) {
      time.textContent = `${formatTime(this.audio.currentTime)} / ${formatTime(
        this.audio.duration || this.data?.tracks[this.current]?.duration || null
      )}`;
    }
    if (seek && this.audio.duration) {
      seek.value = String((this.audio.currentTime / this.audio.duration) * 100);
    }
  }

  private renderStatus(msg: string) {
    this.shadow.innerHTML = `<style>${STYLES}</style><div class="status" part="status"></div>`;
    this.shadow.querySelector(".status")!.textContent = msg;
  }

  private render() {
    if (!this.data) return;
    const playing = this.current >= 0 && !this.audio.paused;
    const artwork = this.data.artworkUrl
      ? `<img class="artwork" part="artwork" src="${this.instance}${this.data.artworkUrl}" alt="">`
      : `<div class="artwork empty" part="artwork">♫</div>`;

    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="header" part="header">
        ${artwork}
        <div class="title" part="title"></div>
      </div>
      <div class="transport" part="transport">
        <button class="prev" part="button">|◀</button>
        <button class="toggle" part="button">${playing ? "❚❚" : "▶"}</button>
        <button class="nextb" part="button">▶|</button>
        <input class="seek" part="seek" type="range" min="0" max="100" value="0">
        <span class="time" part="time">--:-- / --:--</span>
      </div>
      <ul class="tracks" part="tracklist"></ul>
      <div class="footer" part="footer"><a href="https://github.com/usedrobot/demo-locker" target="_blank" rel="noopener">demo locker</a></div>
    `;

    this.shadow.querySelector(".title")!.textContent = this.data.name;

    const list = this.shadow.querySelector(".tracks")!;
    this.data.tracks.forEach((t, i) => {
      const li = document.createElement("li");
      li.setAttribute("part", "track");
      if (i === this.current) li.classList.add("active");
      const name = document.createElement("span");
      name.textContent = `${i === this.current && playing ? "▶ " : ""}${t.title}`;
      const dur = document.createElement("span");
      dur.className = "dur";
      dur.textContent = formatTime(t.duration);
      li.append(name, dur);
      li.addEventListener("click", () => this.play(i));
      list.appendChild(li);
    });

    this.shadow.querySelector(".toggle")!.addEventListener("click", () => {
      if (this.current < 0) this.play(0);
      else this.play(this.current);
    });
    this.shadow.querySelector(".prev")!.addEventListener("click", () => this.prev());
    this.shadow.querySelector(".nextb")!.addEventListener("click", () => this.next());
    this.shadow.querySelector<HTMLInputElement>(".seek")!.addEventListener("input", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (this.audio.duration) this.audio.currentTime = (v / 100) * this.audio.duration;
    });

    this.updateTime();
  }
}

if (!customElements.get("demo-locker-player")) {
  customElements.define("demo-locker-player", DemoLockerPlayer);
}
```

- [ ] **Step 3: Build and inspect**

```bash
npm run build -w packages/player
head -c 200 packages/player/dist/embed.js && echo && wc -c packages/player/dist/embed.js
```

Expected: an IIFE (`(function(){...` or `var DemoLockerPlayer=function(){...`), single file, roughly 8–15 KB.

- [ ] **Step 4: Typecheck everything**

Run: `npm run typecheck`
Expected: clean across all three workspaces (root script runs `--workspaces`).

- [ ] **Step 5: Commit**

```bash
git add packages/player package-lock.json
git commit -m "feat(player): <demo-locker-player> web component (vanilla, TUI theme, --dl-* vars)"
```

---

### Task 4: Serve `/embed.js` from both deploy targets

**Files:**
- Modify: `packages/api/src/types.ts` (add `EMBED_JS?: string` to Bindings)
- Modify: `packages/api/src/index.ts` (add the route)
- Modify: `packages/api/src/server.ts` (load bundle into bindings)
- Modify: `packages/api/wrangler.jsonc` (static assets for Worker)
- Modify: `Dockerfile` (build + copy player dist into standalone image)
- Modify: `.github/workflows/ci.yml` (build player before wrangler deploy)

**Interfaces:**
- Consumes: `packages/player/dist/embed.js` (Task 3).
- Produces: `GET /embed.js` → the bundle with `Content-Type: text/javascript`, 404 with a clear message if not built. Task 6's smoke and docs rely on this path.

- [ ] **Step 1: Bindings type + shared route**

In `packages/api/src/types.ts`, add to `Bindings`:

```ts
  EMBED_JS?: string;
```

In `packages/api/src/index.ts`, after the `/health` route:

```ts
app.get("/embed.js", (c) => {
  if (!c.env.EMBED_JS) {
    return c.text("player bundle not available on this deployment", 404);
  }
  return new Response(c.env.EMBED_JS, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
```

(The no-store middleware already skips `/embed.js` from Task 2 Step 5.)

- [ ] **Step 2: Node wiring**

In `packages/api/src/server.ts`, alongside the existing `webDist` logic in `main()` (before `bindings` is built):

```ts
  const playerBundle = process.env.PLAYER_DIST || "../player/dist/embed.js";
  const embedJs = existsSync(playerBundle) ? readFileSync(playerBundle, "utf-8") : undefined;
  console.log(embedJs ? `embed: serving ${playerBundle}` : `embed: not serving (no build at ${playerBundle})`);
```

and add `EMBED_JS: embedJs,` to the `bindings` object.

- [ ] **Step 3: Worker wiring (Cloudflare static assets)**

In `packages/api/wrangler.jsonc`, add:

```jsonc
  "assets": {
    "directory": "../player/dist"
  },
```

With Workers static assets, a request matching a file (`/embed.js`) is served directly from the asset store before the Worker runs; everything else falls through to the app. The in-app route from Step 1 stays as the Node path + Worker fallback (it 404s cleanly if `EMBED_JS` is absent — on the Worker, assets answer first, so the 404 path is never hit for a deployed bundle).

In `.github/workflows/ci.yml`, in the `deploy-api` job, add before the wrangler deploy step:

```yaml
      - run: npm run build -w packages/player
```

- [ ] **Step 4: Dockerfile — build and include the player**

In `Dockerfile`: the `base` stage's package.json COPY block gets one more line (after the web one):

```dockerfile
COPY packages/player/package.json packages/player/
```

Append a build stage after `standalone-web-build` and extend `standalone`:

```dockerfile
# --- Player bundle (embed.js) ---
FROM base AS player-build
COPY packages/player packages/player
WORKDIR /app/packages/player
RUN npm run build
```

and in the `standalone` stage, after the web dist COPY:

```dockerfile
COPY --from=player-build /app/packages/player/dist packages/player/dist
```

- [ ] **Step 5: Verify end-to-end locally**

```bash
npm run build -w packages/player
VITE_API_URL="" npm run build -w packages/web
cd packages/api && rm -rf /tmp/dl-embed && DATA_DIR=/tmp/dl-embed npx tsx src/server.ts &
sleep 6
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:3001/embed.js   # → 200 text/javascript...
curl -s http://localhost:3001/embed.js | head -c 80; echo
kill %1
```

Expected as annotated; boot log shows `embed: serving ../player/dist/embed.js`.

- [ ] **Step 6: Tests + typecheck, commit**

```bash
npm test -w packages/api && npm run typecheck
git add packages/api Dockerfile .github/workflows/ci.yml
git commit -m "feat: serve /embed.js on both deploy targets (bindings on Node, assets on Worker)"
```

---

### Task 5: Owner UX — public toggle + embed snippet

**Files:**
- Modify: `packages/web/src/lib/api.ts` (Playlist type + update signature)
- Modify: `packages/web/src/pages/PlaylistView.tsx` (toggle + snippet UI)

**Interfaces:**
- Consumes: `PATCH /playlists/:id` with `{ isPublic }` (Task 1); `playlists.update` in `api.ts`.
- Produces: owner-visible `[make public]`/`[make private]` control and, when public, a copy-paste snippet box. Task 6's docs reference this flow.

- [ ] **Step 1: Extend the web API layer**

In `packages/web/src/lib/api.ts`: add `isPublic: boolean;` to the `Playlist` type (near `updatedAt`), and widen the update signature:

```ts
  update: (id: string, data: Partial<Pick<Playlist, "name" | "artworkKey" | "isPublic">>) =>
```

- [ ] **Step 2: Add the toggle + snippet UI**

In `packages/web/src/pages/PlaylistView.tsx`, locate the owner-only header controls (the area rendering the existing `[update cover]`-style owner links — grep for `update cover` or `isOwner`). Following the file's existing state/handler patterns, add:

1. A handler:

```tsx
  const togglePublic = async () => {
    if (!playlist) return;
    const updated = await playlists.update(playlist.id, { isPublic: !playlist.isPublic });
    setPlaylist(updated.playlist);
  };
```

(Adapt the setter name to the component's actual playlist state variable; `playlists.update` already returns `{ playlist }`.)

2. Next to the other owner-only links, in the same link/button style the file already uses:

```tsx
  <button className="link-btn" onClick={togglePublic}>
    [{playlist.isPublic ? "make private" : "make public"}]
  </button>
```

3. When `playlist.isPublic`, an embed box under the header (reuse existing panel/box styling conventions from the file):

```tsx
  {playlist.isPublic && (
    <div className="embed-box">
      <div>public — embed on any site:</div>
      <textarea
        readOnly
        rows={2}
        value={`<script src="${window.location.origin}/embed.js"></script>\n<demo-locker-player playlist="${playlist.id}"></demo-locker-player>`}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="embed-note">
        api: {window.location.origin}/public/v1/playlists/{playlist.id}
      </div>
    </div>
  )}
```

Style `.embed-box`/`.link-btn` additions in the same stylesheet the component already uses, matching the TUI aesthetic (monospace, `1px solid` borders, no rounding). NOTE for the standalone image `window.location.origin` is the instance origin (web served same-origin). For the split hosted deploy (Pages + Worker), origin ≠ API — build the snippet from `API_URL || window.location.origin` by importing the module's API base if `api.ts` exports it; if it doesn't, export a `getApiOrigin()` helper from `api.ts` returning `API_URL || window.location.origin` and use it for both snippet lines.

- [ ] **Step 3: Verify in the browser**

```bash
npm run build -w packages/player
VITE_API_URL="" npm run build -w packages/web
cd packages/api && rm -rf /tmp/dl-ux && DATA_DIR=/tmp/dl-ux npx tsx src/server.ts &
```

Open http://localhost:3001 — sign up, create a playlist, upload any audio file, toggle `[make public]`, confirm the snippet box appears and `curl -s http://localhost:3001/public/v1/playlists/<id>` returns the metadata; toggle `[make private]` and confirm it 404s. Kill the server after.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
npm run typecheck && npm run lint
git add packages/web/src
git commit -m "feat(web): public toggle + embed snippet in playlist view"
```

---

### Task 6: Smoke extension, embed docs, demo site

**Files:**
- Modify: `scripts/smoke.sh`
- Create: `docs/embed.md`
- Create: `docs/demo-site/index.html`
- Modify: `README.md` (feature bullet + docs link)

**Interfaces:**
- Consumes: everything above; the smoke playlist/track/token variables already in `scripts/smoke.sh`.

- [ ] **Step 1: Extend smoke.sh**

After the existing comment step in `scripts/smoke.sh` (before the SPA check), add:

```bash
echo "→ public API boundary"
STATUS=$(curl -fsS -o /dev/null -w '%{http_code}' "$BASE/public/v1/playlists/$PLAYLIST_ID" || true)
[ "$STATUS" = "404" ] || { echo "FAIL: private playlist visible publicly (got $STATUS)"; exit 1; }

echo "→ make public"
curl -fsS -X PATCH "$BASE/playlists/$PLAYLIST_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"isPublic":true}' | jq -re '.playlist.isPublic' | grep -q true

echo "→ public metadata + unauthenticated range stream"
PUB_TRACK=$(curl -fsS "$BASE/public/v1/playlists/$PLAYLIST_ID" | jq -re '.playlist.tracks[0].id')
STATUS=$(curl -fsS -o /dev/null -w '%{http_code}' -H "Range: bytes=0-99" "$BASE/public/v1/tracks/$PUB_TRACK/stream")
[ "$STATUS" = "206" ] || { echo "FAIL: public stream expected 206, got $STATUS"; exit 1; }

echo "→ embed.js served"
curl -fsS -o /dev/null -w '%{content_type}' "$BASE/embed.js" | grep -q javascript || { echo "FAIL: embed.js"; exit 1; }
```

Run `./scripts/smoke.sh` — expected `SMOKE OK` with the new steps green.

- [ ] **Step 2: Write docs/embed.md**

Create `docs/embed.md` covering, in order, with real code blocks:
1. The two-line snippet (script + element), noting `instance` defaults to the script's origin and when to set it explicitly.
2. Element attributes table: `playlist` (required), `instance` (optional).
3. Theming: the full `--dl-*` variable list from `player.ts` STYLES with defaults, one example override block (`demo-locker-player { --dl-accent: hotpink; }`), and a `::part()` example (parts: `header`, `artwork`, `title`, `transport`, `button`, `seek`, `time`, `tracklist`, `track`, `status`, `footer`).
4. Public API reference: the three endpoints, response shapes (copy from the spec), the 404-indistinguishable rule, CORS-open note.
5. A "roll your own player" paragraph: the API is the SDK; fetch metadata, point an `<audio>` at the stream URL. Distribution note: `/embed.js` from your instance is the supported path; npm package planned; if you must load from a CDN later, pin a version with SRI.

- [ ] **Step 3: Demo site**

Create `docs/demo-site/index.html` — a minimal single-file fake band page (inline CSS, dark, one hero heading, one paragraph, the embed snippet pointing at a configurable instance):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>THE COOLANTS — demos</title>
  <style>
    body { background:#111; color:#eee; font-family: Georgia, serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
    h1 { letter-spacing: 0.2em; }
    .note { color: #999; font-size: 0.9em; }
    demo-locker-player { margin-top: 24px; --dl-accent: #ff6ad5; }
  </style>
</head>
<body>
  <h1>THE COOLANTS</h1>
  <p>New demos, straight from the locker. Self-hosted — no platform between us and you.</p>
  <p class="note">Edit the two attributes below to point at your own instance + public playlist.</p>
  <script src="http://localhost:3001/embed.js"></script>
  <demo-locker-player instance="http://localhost:3001" playlist="PASTE-PUBLIC-PLAYLIST-ID"></demo-locker-player>
</body>
</html>
```

Manual verification: with the Task 5 server still running and a public playlist ID pasted in, `open docs/demo-site/index.html` — player loads, lists tracks, plays, auto-advances.

- [ ] **Step 4: README**

In `README.md` Features list add: `- Public player — mark a playlist public, embed it on any site with two lines ([docs](docs/embed.md))`.

- [ ] **Step 5: Full verification + commit**

```bash
npm test -w packages/api && npm run typecheck && ./scripts/smoke.sh
git add scripts/smoke.sh docs/embed.md docs/demo-site README.md
git commit -m "feat: smoke coverage for public API + embed docs + demo band site"
```

---

## Self-Review (completed at plan time)

- **Spec coverage:** is_public column/migration (T1), three public endpoints + 404-indistinguishable + cache headers + CORS note (T2), boundary test suite incl. revocation (T2), vanilla component with TUI theme + `--dl-*` + parts + auto-advance (T3), instance-served /embed.js on both targets (T4), owner toggle + snippet (T5), smoke extension + embed.md + demo site (T6). Out-of-scope list respected (no downloads, no npm, no waveform, no analytics).
- **Type consistency:** `buildStreamResponse(rangeHeader, bucket, key)` used identically in T2 both routes; public payload shape `{ playlist: { id, name, artworkUrl, tracks } }` consistent across T2 tests, T3 component, T6 docs; `EMBED_JS?: string` binding consistent T4 steps.
- **Known verify-at-implementation points:** PlaylistView's actual state-setter and owner-check names (T5 Step 2 adapts); wrangler assets config syntax against the installed wrangler v4 (T4 Step 3); vite IIFE output naming (T3 Step 3 inspects).
