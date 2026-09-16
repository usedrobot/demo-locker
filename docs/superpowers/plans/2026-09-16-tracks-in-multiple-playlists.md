# Tracks in Multiple Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one track sit in any number of playlists by replacing `tracks.playlist_id` with a `playlist_tracks` join table, without changing what the embed player or share links see.

**Architecture:** Migration 0007 creates `playlist_tracks (playlist_id, track_id, position, added_at)`, backfills it, and drops `playlist_id` and `position` from `tracks`. The API gains add and remove routes under `/playlists/:id/tracks`, retires `PATCH /tracks/:id`, and routes every track-level access check through one new helper that asks "can the requester reach any playlist holding this track, or do they belong to its locker". The web app's playlist page picker lists every library track not already in that playlist; the remove control calls the new remove route.

**Tech Stack:** Hono on Cloudflare Workers and Node, Drizzle ORM 0.45 with drizzle-kit 0.31 (SQLite dialect, D1 and better-sqlite3), React 19 web app, Vitest in every package. House test pattern for the web app is `createRoot` + `act`, no testing-library.

**Spec:** `docs/superpowers/specs/2026-09-16-tracks-in-multiple-playlists-design.md`

## Global Constraints

- Migrations are generated with `npx drizzle-kit generate --name <name>` from `packages/api` and checked in under `packages/api/src/db/migrations/`. `packages/cli/assets/` is gitignored and built from those files, so nothing is mirrored by hand.
- Every access refusal on a track or playlist route is the same non-enumerable `{ error: "not found" }` 404, never 401 or 403.
- Share tokens are per playlist. A listen or edit token for playlist A must never expose a track through playlist B.
- The raw `uploaded_by` user id is never serialized. `publicTrack()` stays the single track serializer.
- `docs/openapi.json` is hand-maintained and must describe every route change in the same commit as the route.
- Run tests with `npm test` inside the package directory (`packages/api`, `packages/web`, `packages/player`). Run `npm run typecheck` from the repo root before any commit that touches TypeScript.
- Commit messages follow the existing `type(scope): summary` style and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work happens on branch `multi-playlist`, already created off `main`.

---

## File map

| Path | Responsibility |
|---|---|
| `packages/api/src/db/schema.ts` | Add `playlistTracks` table, remove `playlistId` and `position` from `tracks`. |
| `packages/api/src/db/migrations/0007_playlist_tracks.sql` | Create table, backfill, drop the two columns. Generated then edited. |
| `packages/api/src/db/migrations/0007_backfill.test.ts` (new) | Proves the backfill copies membership and order and that the count matches. |
| `packages/api/src/test/seed.ts` (new) | `seedTrack()` helper so every API test inserts tracks one way. |
| `packages/api/src/lib/playlist-membership.ts` (new) | `playlistIdsForTrack`, `tracksInPlaylist`, `nextPosition`, `addTrackToPlaylist`, `removeTrackFromPlaylist`. All join-table reads and writes live here. |
| `packages/api/src/lib/playlist-access.ts` | Add `requestCanAccessTrack(c, track)`. |
| `packages/api/src/lib/public-track.ts` | `publicTrack()` accepts optional `position` and `playlistIds` extras. |
| `packages/api/src/routes/tracks.ts` | Upload inserts a join row. Library returns `playlistIds`. Stream and download use `requestCanAccessTrack`. `PATCH /:id` returns 410. |
| `packages/api/src/routes/playlists.ts` | New add and remove routes. Get and reorder read and write the join table. |
| `packages/api/src/routes/public.ts` | Public playlist and stream read through the join table. |
| `packages/api/src/routes/shares.ts` | Invite landing reads through the join table. |
| `packages/api/src/routes/comments.ts` | Track-comment gates use `requestCanAccessTrack`; `commentTarget` resolves through the join table. |
| `packages/api/src/routes/playlist-tracks.test.ts` (new) | Add, remove, last-playlist, reorder scoping, access through any playlist, shared-track comments. |
| `docs/openapi.json` | New routes, retired route, `Track` schema. |
| `packages/web/src/lib/api.ts` | `Track` type loses `playlistId` and `position`, gains optional `playlistIds`. `tracks.attach` removed; `playlists.addTrack` and `playlists.removeTrack` added. |
| `packages/web/src/lib/audio.ts` | `setPlaylist(tracks, playlistId?)` and `playlistId` in state, so the player knows which artwork to show. |
| `packages/web/src/components/Player.tsx` | Artwork from `state.playlistId`. |
| `packages/web/src/components/TrackList.tsx` | Remove calls `playlists.removeTrack`. Needs a `playlistId` prop. |
| `packages/web/src/pages/PlaylistView.tsx` | Picker filters on `playlistIds`; add calls `playlists.addTrack`. |
| `packages/web/src/pages/Home.tsx` | Library rows show the playlists each track is in. |
| `packages/web/src/pages/Invite.tsx` | Pass the playlist id to the audio player. |

---

### Task 1: Schema and migration 0007

**Files:**
- Modify: `packages/api/src/db/schema.ts:68-100`
- Create: `packages/api/src/db/migrations/0007_playlist_tracks.sql` (via drizzle-kit, then edited)
- Create: `packages/api/src/db/migrations/0007_backfill.test.ts`
- Modify: `packages/api/src/db/sqlite.test.ts:44-60` (fixture uses `playlistId`)

**Interfaces:**
- Produces: `playlistTracks` Drizzle table with columns `playlistId`, `trackId`, `position`, `addedAt`. `tracks` no longer has `playlistId` or `position`.

- [ ] **Step 1: Write the backfill test**

Create `packages/api/src/db/migrations/0007_backfill.test.ts`. It builds a database at migration 0006, seeds tracks the old way with raw SQL, runs the remaining migrations, and checks the join rows.

```ts
// Migration 0007 moves playlist membership off tracks.playlist_id and onto a
// join table. A track in a playlist must come out the other side as exactly
// one join row carrying its old position; a library track must produce none.
import { describe, it, expect } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

function sqlFiles(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

function apply(db: DatabaseConstructor.Database, file: string) {
  const sql = readFileSync(join(dir, file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    if (stmt.trim()) db.exec(stmt);
  }
}

describe("0007 backfill", () => {
  it("copies every playlist membership and its position, and nothing for library tracks", () => {
    const db = new DatabaseConstructor(":memory:");
    db.pragma("foreign_keys = ON");
    const files = sqlFiles();
    const before = files.filter((f) => f < "0007_");
    const after = files.filter((f) => f >= "0007_");
    for (const f of before) apply(db, f);

    db.exec(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'o@test.dev', 'x', 0)`);
    db.exec(`INSERT INTO playlists (id, owner_id, name, is_public, created_at, updated_at) VALUES ('p1', 'u1', 'one', 0, 0, 0)`);
    db.exec(`INSERT INTO tracks (id, playlist_id, owner_id, title, position, original_key, uploaded_at) VALUES
      ('t1', 'p1', 'u1', 'first', 0, 'k1', 1000),
      ('t2', 'p1', 'u1', 'second', 1, 'k2', 2000),
      ('t3', NULL, 'u1', 'library', 0, 'k3', 3000)`);

    for (const f of after) apply(db, f);

    const rows = db
      .prepare(`SELECT playlist_id, track_id, position, added_at FROM playlist_tracks ORDER BY position`)
      .all() as { playlist_id: string; track_id: string; position: number; added_at: number }[];
    expect(rows).toEqual([
      { playlist_id: "p1", track_id: "t1", position: 0, added_at: 1000 },
      { playlist_id: "p1", track_id: "t2", position: 1, added_at: 2000 },
    ]);

    const cols = (db.prepare(`PRAGMA table_info(tracks)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("playlist_id");
    expect(cols).not.toContain("position");
    // The library track survived the column drop untouched.
    expect(db.prepare(`SELECT count(*) AS n FROM tracks`).get()).toEqual({ n: 3 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run src/db/migrations/0007_backfill.test.ts`
Expected: FAIL, `no such table: playlist_tracks`.

- [ ] **Step 3: Change the schema**

In `packages/api/src/db/schema.ts`, delete the `playlistId` and `position` fields from `tracks` (lines 70-74 and 79, including the comment about SET NULL), and add the new table after `tracks`:

```ts
// Which playlists hold which tracks, and in what order. A track is a library
// item owned by a locker; membership is many-to-many. `position` lives here
// rather than on the track because a track has one position PER playlist.
// Both FKs cascade: deleting a playlist drops its rows and leaves the tracks
// in the library (the same outcome the old SET NULL gave); deleting a track
// drops it from every playlist.
export const playlistTracks = sqliteTable(
  "playlist_tracks",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    primaryKey({ columns: [t.playlistId, t.trackId] }),
    index("playlist_tracks_track_idx").on(t.trackId),
  ]
);
```

Add `primaryKey` and `index` to the import from `drizzle-orm/sqlite-core` on line 1.

- [ ] **Step 4: Generate the migration and edit it**

Run: `cd packages/api && npx drizzle-kit generate --name playlist_tracks`

drizzle-kit will emit `0007_playlist_tracks.sql` with a `CREATE TABLE` and two `ALTER TABLE tracks DROP COLUMN` statements. Open it and insert the backfill between the create and the drops, so the file reads:

```sql
CREATE TABLE `playlist_tracks` (
	`playlist_id` text NOT NULL,
	`track_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`playlist_id`, `track_id`),
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_tracks_track_idx` ON `playlist_tracks` (`track_id`);
--> statement-breakpoint
INSERT INTO `playlist_tracks` (`playlist_id`, `track_id`, `position`, `added_at`)
SELECT `playlist_id`, `id`, `position`, `uploaded_at` FROM `tracks` WHERE `playlist_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `playlist_id`;
--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `position`;
```

Keep whatever exact `CREATE TABLE` text drizzle-kit produced; only add the `INSERT ... SELECT` block. Do not edit `meta/0007_snapshot.json` or `meta/_journal.json`.

If drizzle-kit instead emits a table-recreate sequence for the drops (`CREATE TABLE __new_tracks ... INSERT ... DROP ... RENAME`), place the backfill before that sequence and leave the sequence as generated.

- [ ] **Step 5: Fix the one schema test that inserts the old way**

In `packages/api/src/db/sqlite.test.ts` the "nulls attribution" test inserts a track with `playlistId: pl.id` and `position: 0`. Remove those two fields from that `.values({...})` call. The test's purpose (uploader SET NULL) is unaffected.

- [ ] **Step 6: Run the backfill test and the schema test**

Run: `cd packages/api && npx vitest run src/db`
Expected: both files PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/db
git commit -m "feat(db): playlist_tracks join table, migration 0007 with backfill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

The API package will not typecheck yet; the route files still reference the dropped columns. Tasks 2 through 6 fix that. Do not run the full API suite until Task 6.

---

### Task 2: Membership helpers and the shared test seed

**Files:**
- Create: `packages/api/src/lib/playlist-membership.ts`
- Create: `packages/api/src/test/seed.ts`
- Create: `packages/api/src/lib/playlist-membership.test.ts`

**Interfaces:**
- Produces:
  - `playlistIdsForTrack(db, trackId): Promise<string[]>`
  - `tracksInPlaylist(db, playlistId): Promise<(TrackRow & { position: number })[]>` ordered by position
  - `nextPosition(db, playlistId): Promise<number>`
  - `addTrackToPlaylist(db, playlistId, trackId): Promise<boolean>` returns false if already present
  - `removeTrackFromPlaylist(db, playlistId, trackId): Promise<void>`
  - `seedTrack(db, { ownerId, title?, originalKey?, streamKey?, uploadedBy?, duration?, playlistIds? }): Promise<TrackRow>` inserts a track and one join row per playlist, positions appended.

- [ ] **Step 1: Write the helper tests**

```ts
// packages/api/src/lib/playlist-membership.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { createSqliteDb } from "../db/sqlite.js";
import type { Database } from "../db/index.js";
import { users, playlists } from "../db/schema.js";
import { seedTrack } from "../test/seed.js";
import {
  playlistIdsForTrack,
  tracksInPlaylist,
  nextPosition,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
} from "./playlist-membership.js";

let db: Database;
let ownerId: string;
let a: string;
let b: string;

beforeAll(async () => {
  db = createSqliteDb();
  const [u] = await db.insert(users).values({ email: "m@test.dev", passwordHash: "x" }).returning();
  ownerId = u.id;
  const [pa] = await db.insert(playlists).values({ ownerId, name: "A" }).returning();
  const [pb] = await db.insert(playlists).values({ ownerId, name: "B" }).returning();
  a = pa.id;
  b = pb.id;
});

describe("playlist membership", () => {
  it("seeds a track into several playlists with appended positions", async () => {
    const t1 = await seedTrack(db, { ownerId, title: "one", playlistIds: [a] });
    const t2 = await seedTrack(db, { ownerId, title: "two", playlistIds: [a, b] });
    expect(await playlistIdsForTrack(db, t1.id)).toEqual([a]);
    expect((await playlistIdsForTrack(db, t2.id)).sort()).toEqual([a, b].sort());
    const inA = await tracksInPlaylist(db, a);
    expect(inA.map((t) => [t.id, t.position])).toEqual([[t1.id, 0], [t2.id, 1]]);
    expect(await nextPosition(db, a)).toBe(2);
    expect(await nextPosition(db, b)).toBe(1);
  });

  it("add is idempotent and remove only touches the named playlist", async () => {
    const t = await seedTrack(db, { ownerId, title: "three", playlistIds: [a] });
    expect(await addTrackToPlaylist(db, b, t.id)).toBe(true);
    expect(await addTrackToPlaylist(db, b, t.id)).toBe(false);
    expect((await playlistIdsForTrack(db, t.id)).sort()).toEqual([a, b].sort());

    await removeTrackFromPlaylist(db, a, t.id);
    expect(await playlistIdsForTrack(db, t.id)).toEqual([b]);

    await removeTrackFromPlaylist(db, b, t.id);
    expect(await playlistIdsForTrack(db, t.id)).toEqual([]);
  });

  it("returns an empty list for a track in no playlist", async () => {
    const t = await seedTrack(db, { ownerId, title: "lib" });
    expect(await playlistIdsForTrack(db, t.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && npx vitest run src/lib/playlist-membership.test.ts`
Expected: FAIL, cannot find module `./playlist-membership.js`.

- [ ] **Step 3: Write the seed helper**

```ts
// packages/api/src/test/seed.ts
//
// The one way tests insert tracks. Before migration 0007 every test wrote
// `playlistId` and `position` straight onto the track row; now membership is
// a join row per playlist, and this helper writes both so no test has to know.
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { tracks, playlistTracks } from "../db/schema.js";
import type { TrackRow } from "../lib/public-track.js";
import { nextPosition } from "../lib/playlist-membership.js";

type SeedTrackInput = {
  ownerId: string;
  title?: string;
  originalKey?: string;
  streamKey?: string | null;
  uploadedBy?: string | null;
  uploadedByName?: string | null;
  duration?: number | null;
  waveformData?: string | null;
  sizeBytes?: number | null;
  playlistIds?: string[];
};

let seq = 0;

export async function seedTrack(db: Database, input: SeedTrackInput): Promise<TrackRow> {
  seq += 1;
  const { playlistIds = [], ...cols } = input;
  const [track] = await db
    .insert(tracks)
    .values({
      title: cols.title ?? `track ${seq}`,
      originalKey: cols.originalKey ?? `seed/${seq}`,
      streamKey: cols.streamKey === undefined ? (cols.originalKey ?? `seed/${seq}`) : cols.streamKey,
      ownerId: cols.ownerId,
      uploadedBy: cols.uploadedBy ?? null,
      uploadedByName: cols.uploadedByName ?? null,
      duration: cols.duration ?? null,
      waveformData: cols.waveformData ?? null,
      sizeBytes: cols.sizeBytes ?? null,
    })
    .returning();
  for (const playlistId of playlistIds) {
    await db.insert(playlistTracks).values({
      playlistId,
      trackId: track.id,
      position: await nextPosition(db, playlistId),
    });
  }
  return track;
}

// Read back a track's position inside one playlist, for assertions. Null when
// the track is not in that playlist.
export async function positionIn(db: Database, playlistId: string, trackId: string): Promise<number | null> {
  const [row] = await db
    .select({ position: playlistTracks.position })
    .from(playlistTracks)
    .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)))
    .limit(1);
  return row ? row.position : null;
}
```

The import line at the top of the file is `import { and, eq } from "drizzle-orm";`.

- [ ] **Step 4: Write the membership module**

```ts
// packages/api/src/lib/playlist-membership.ts
//
// Every read and write of playlist_tracks. Routes call these rather than
// touching the join table directly, so the "a track is in N playlists" rule
// has one home.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { playlistTracks, tracks } from "../db/schema.js";
import type { TrackRow } from "./public-track.js";

export async function playlistIdsForTrack(db: Database, trackId: string): Promise<string[]> {
  const rows = await db
    .select({ playlistId: playlistTracks.playlistId })
    .from(playlistTracks)
    .where(eq(playlistTracks.trackId, trackId));
  return rows.map((r: { playlistId: string }) => r.playlistId);
}

// Membership for a whole set of tracks in one query, keyed by track id.
// Every id in `trackIds` is present in the map, possibly with an empty list.
export async function playlistIdsForTracks(
  db: Database,
  trackIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(trackIds.map((id) => [id, []]));
  if (trackIds.length === 0) return out;
  const rows = await db
    .select({ playlistId: playlistTracks.playlistId, trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(sql`${playlistTracks.trackId} IN ${trackIds}`);
  for (const r of rows as { playlistId: string; trackId: string }[]) {
    out.get(r.trackId)?.push(r.playlistId);
  }
  return out;
}

export type TrackInPlaylist = TrackRow & { position: number };

export async function tracksInPlaylist(db: Database, playlistId: string): Promise<TrackInPlaylist[]> {
  const rows = await db
    .select({ track: tracks, position: playlistTracks.position })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position));
  return rows.map((r: { track: TrackRow; position: number }) => ({ ...r.track, position: r.position }));
}

export async function nextPosition(db: Database, playlistId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${playlistTracks.position})` })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId));
  return row?.max == null ? 0 : Number(row.max) + 1;
}

// Returns true when a row was inserted, false when the track was already in
// the playlist. Never throws on the duplicate: callers treat re-adding as a
// no-op 200, not an error.
export async function addTrackToPlaylist(db: Database, playlistId: string, trackId: string): Promise<boolean> {
  const [existing] = await db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)))
    .limit(1);
  if (existing) return false;
  await db.insert(playlistTracks).values({
    playlistId,
    trackId,
    position: await nextPosition(db, playlistId),
  });
  return true;
}

export async function removeTrackFromPlaylist(db: Database, playlistId: string, trackId: string): Promise<void> {
  await db
    .delete(playlistTracks)
    .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)));
}
```

- [ ] **Step 5: Run the helper tests**

Run: `cd packages/api && npx vitest run src/lib/playlist-membership.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/playlist-membership.ts packages/api/src/lib/playlist-membership.test.ts packages/api/src/test/seed.ts
git commit -m "feat(api): playlist membership helpers and a shared track seed for tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Track-level access check

**Files:**
- Modify: `packages/api/src/lib/playlist-access.ts` (append)
- Modify: `packages/api/src/lib/public-track.ts:100-140`
- Create: `packages/api/src/routes/playlist-tracks.test.ts` (first describe block only; later tasks add to it)

**Interfaces:**
- Produces: `requestCanAccessTrack(c, track: { id: string; ownerId: string }): Promise<boolean>`.
- Produces: `publicTrack(row, actingUserId, names, extras?: { position?: number; playlistIds?: string[] })`. The returned object carries `position` and `playlistIds` only when supplied.

- [ ] **Step 1: Write the access tests**

Create `packages/api/src/routes/playlist-tracks.test.ts`. It will grow in Tasks 4 and 5; this step writes the file header and the access block. The stream route is the subject because it is the most exposed track-level read.

```ts
// A track in several playlists is reachable through ANY of them, and through
// none of the others' tokens. Share tokens are per playlist: a listen link
// for A must not open a track that is only in B.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, playlists, sessions, shares } from "../db/schema.js";
import { seedTrack, positionIn } from "../test/seed.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;

let ownerId: string;
let ownerToken: string;
let strangerToken: string;
let playlistA: string;
let playlistB: string;
let tokenA: string; // listen share for A
let inBoth: string; // track in A and B
let onlyB: string; // track in B only
let libraryOnly: string; // track in no playlist

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-pltracks-"));
  const bucket = createFsBucket(root);
  env = { DB: "sqlite", DEMOS_BUCKET: bucket };

  const [owner] = await db.insert(users).values({ email: "pt-owner@test.dev", passwordHash: "x" }).returning();
  const [stranger] = await db.insert(users).values({ email: "pt-stranger@test.dev", passwordHash: "x" }).returning();
  ownerId = owner.id;
  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "pt-owner-token";
  strangerToken = "pt-stranger-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: stranger.id, token: strangerToken, expiresAt: future });

  const [a] = await db.insert(playlists).values({ ownerId, name: "A" }).returning();
  const [b] = await db.insert(playlists).values({ ownerId, name: "B" }).returning();
  playlistA = a.id;
  playlistB = b.id;

  tokenA = "pt-share-a";
  await db.insert(shares).values({ playlistId: playlistA, token: tokenA, permission: "listen", createdBy: ownerId });

  for (const key of ["k-both", "k-onlyb", "k-lib"]) {
    await bucket.put(key, Buffer.from("0123456789"), { httpMetadata: { contentType: "audio/wav" } });
  }
  inBoth = (await seedTrack(db, { ownerId, title: "both", originalKey: "k-both", playlistIds: [playlistA, playlistB] })).id;
  onlyB = (await seedTrack(db, { ownerId, title: "only b", originalKey: "k-onlyb", playlistIds: [playlistB] })).id;
  libraryOnly = (await seedTrack(db, { ownerId, title: "lib", originalKey: "k-lib" })).id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("track access through any containing playlist", () => {
  it("streams a track in A and B with A's listen token", async () => {
    const res = await app.request(`/tracks/${inBoth}/stream?token=${tokenA}`, {}, env);
    expect(res.status).toBe(200);
  });

  it("refuses A's token on a track that is only in B", async () => {
    const res = await app.request(`/tracks/${onlyB}/stream?token=${tokenA}`, {}, env);
    expect(res.status).toBe(404);
  });

  it("refuses A's token on a library-only track", async () => {
    const res = await app.request(`/tracks/${libraryOnly}/stream?token=${tokenA}`, {}, env);
    expect(res.status).toBe(404);
  });

  it("lets the owner stream a library-only track", async () => {
    const res = await app.request(`/tracks/${libraryOnly}/stream`, { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
  });

  it("refuses a stranger session on every one of them", async () => {
    for (const id of [inBoth, onlyB, libraryOnly]) {
      const res = await app.request(`/tracks/${id}/stream`, { headers: auth(strangerToken) }, env);
      expect(res.status).toBe(404);
    }
  });

  it("gates download the same way as stream", async () => {
    expect((await app.request(`/tracks/${inBoth}/download?token=${tokenA}`, {}, env)).status).toBe(200);
    expect((await app.request(`/tracks/${onlyB}/download?token=${tokenA}`, {}, env)).status).toBe(404);
  });
});
```

Note the `shares` insert needs a `createdBy`; check `packages/api/src/db/schema.ts` `shares` table for the exact required columns and match them.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api && npx vitest run src/routes/playlist-tracks.test.ts`
Expected: FAIL. The API still references `tracks.playlistId` and will not compile.

- [ ] **Step 3: Add `requestCanAccessTrack`**

Append to `packages/api/src/lib/playlist-access.ts`:

```ts
// TRACK access: a track is reachable by anyone who can reach ANY playlist it
// is in, or by a session in its locker. The playlist loop is deliberate: a
// share token is bound to one playlist, so each playlist is tested against
// the request's credentials on its own. "Any share on any of this track's
// playlists" would let a listen link for A open a track through B.
export async function requestCanAccessTrack(
  c: Context<Env>,
  track: { id: string; ownerId: string }
): Promise<boolean> {
  const db = getDb(c.env.DB);
  const userId = await requestSessionUserId(c);
  if (userId) {
    const lockerId = await lockerIdForUserId(db, userId);
    if (lockerId === track.ownerId) return true;
  }
  for (const playlistId of await playlistIdsForTrack(db, track.id)) {
    if (await requestCanAccessPlaylist(c, playlistId)) return true;
  }
  return false;
}
```

Add `import { playlistIdsForTrack } from "./playlist-membership.js";` to the imports at the top of `playlist-access.ts`. `playlist-membership.ts` does not import from `playlist-access.ts`, so there is no cycle.

- [ ] **Step 4: Extend `publicTrack` with optional extras**

In `packages/api/src/lib/public-track.ts`, change the `PublicTrack` type and function:

```ts
export type PublicTrack = Omit<
  TrackRow,
  "originalKey" | "streamKey" | "uploadedBy" | "uploadedByName"
> & {
  hasStream: boolean;
  uploadedByMe: boolean;
  uploadedByName: string | null;
  // Present only in a playlist listing: this track's order in THAT playlist.
  position?: number;
  // Present only in the library listing: every playlist this track is in.
  playlistIds?: string[];
};

export type TrackExtras = { position?: number; playlistIds?: string[] };

export function publicTrack(
  row: TrackRow,
  actingUserId: string | null,
  names: DisplayNames,
  extras: TrackExtras = {}
): PublicTrack {
```

and at the end of the returned object add:

```ts
    ...(extras.position !== undefined ? { position: extras.position } : {}),
    ...(extras.playlistIds !== undefined ? { playlistIds: extras.playlistIds } : {}),
```

Add a comment above the type additions:

```ts
// `position` and `playlistIds` are context, not columns. A track has a
// position per playlist and a membership list per library view, so the route
// that knows the context passes it in; the serializer never guesses.
```

- [ ] **Step 5: Do not run yet**

The API still will not compile until Task 4 rewrites the routes. Commit the two lib changes with the test file.

```bash
git add packages/api/src/lib/playlist-access.ts packages/api/src/lib/public-track.ts packages/api/src/routes/playlist-tracks.test.ts
git commit -m "feat(api): requestCanAccessTrack and context extras on publicTrack

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite the track and playlist routes

**Files:**
- Modify: `packages/api/src/routes/tracks.ts`
- Modify: `packages/api/src/routes/playlists.ts`
- Modify: `packages/api/src/routes/playlist-tracks.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces routes:
  - `POST /playlists/:id/tracks` body `{ trackId }` → 200 `{ ok: true, added: boolean }`, 400 without trackId, 404 when the caller cannot upload to the playlist or the track is not in the same locker.
  - `DELETE /playlists/:id/tracks/:trackId` → 200 `{ ok: true }`, 404 when the caller cannot upload to the playlist.
  - `PATCH /tracks/:id` → 410 `{ error: "moved: use POST/DELETE /playlists/:id/tracks" }`.
  - `GET /tracks` → each track carries `playlistIds`.
  - `GET /playlists/:id` → tracks carry `position`.

- [ ] **Step 1: Append route tests**

Add to `packages/api/src/routes/playlist-tracks.test.ts`:

```ts
describe("adding and removing", () => {
  it("adds a track to a second playlist and appends it", async () => {
    const t = await seedTrack(db, { ownerId, title: "addme", playlistIds: [playlistA] });
    const res = await app.request(
      `/playlists/${playlistB}/tracks`,
      { method: "POST", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackId: t.id }) },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: true });
    expect(await positionIn(db, playlistA, t.id)).not.toBeNull();
    const posB = await positionIn(db, playlistB, t.id);
    expect(posB).toBe(2); // inBoth, onlyB, then this one
  });

  it("re-adding is a no-op 200", async () => {
    const res = await app.request(
      `/playlists/${playlistB}/tracks`,
      { method: "POST", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackId: inBoth }) },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: false });
  });

  it("400s without a trackId", async () => {
    const res = await app.request(
      `/playlists/${playlistB}/tracks`,
      { method: "POST", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({}) },
      env
    );
    expect(res.status).toBe(400);
  });

  it("404s a stranger adding to a playlist they cannot see", async () => {
    const res = await app.request(
      `/playlists/${playlistB}/tracks`,
      { method: "POST", headers: { ...auth(strangerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackId: inBoth }) },
      env
    );
    expect(res.status).toBe(404);
  });

  it("404s a track from another locker", async () => {
    const [other] = await db.insert(users).values({ email: "pt-other@test.dev", passwordHash: "x" }).returning();
    const foreign = await seedTrack(db, { ownerId: other.id, title: "foreign" });
    const res = await app.request(
      `/playlists/${playlistB}/tracks`,
      { method: "POST", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackId: foreign.id }) },
      env
    );
    expect(res.status).toBe(404);
  });

  it("removes from one playlist and leaves the other", async () => {
    const t = await seedTrack(db, { ownerId, title: "rm", playlistIds: [playlistA, playlistB] });
    const res = await app.request(`/playlists/${playlistA}/tracks/${t.id}`, { method: "DELETE", headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    expect(await positionIn(db, playlistA, t.id)).toBeNull();
    expect(await positionIn(db, playlistB, t.id)).not.toBeNull();
  });

  it("removing from the last playlist keeps the track in the library", async () => {
    const t = await seedTrack(db, { ownerId, title: "last", playlistIds: [playlistA] });
    const res = await app.request(`/playlists/${playlistA}/tracks/${t.id}`, { method: "DELETE", headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const lib = await app.request(`/tracks`, { headers: auth(ownerToken) }, env);
    const body = (await lib.json()) as { tracks: { id: string; playlistIds: string[] }[] };
    const row = body.tracks.find((x) => x.id === t.id);
    expect(row).toBeDefined();
    expect(row!.playlistIds).toEqual([]);
  });

  it("the library lists every playlist a track is in", async () => {
    const lib = await app.request(`/tracks`, { headers: auth(ownerToken) }, env);
    const body = (await lib.json()) as { tracks: { id: string; playlistIds: string[] }[] };
    const row = body.tracks.find((x) => x.id === inBoth)!;
    expect(row.playlistIds.sort()).toEqual([playlistA, playlistB].sort());
  });

  it("a playlist listing carries each track's position in that playlist", async () => {
    const res = await app.request(`/playlists/${playlistA}`, { headers: auth(ownerToken) }, env);
    const body = (await res.json()) as { tracks: { id: string; position: number }[] };
    expect(body.tracks[0]).toMatchObject({ id: inBoth, position: 0 });
  });

  it("the old move route is gone", async () => {
    const res = await app.request(
      `/tracks/${inBoth}`,
      { method: "PATCH", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ playlistId: null }) },
      env
    );
    expect(res.status).toBe(410);
  });
});

describe("reorder stays scoped to one playlist", () => {
  it("cannot move a track's position in another playlist", async () => {
    const before = await positionIn(db, playlistB, onlyB);
    const res = await app.request(
      `/playlists/${playlistA}/reorder`,
      { method: "PATCH", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackIds: ["x1", "x2", "x3", "x4", "x5", onlyB] }) },
      env
    );
    expect(res.status).toBe(200);
    expect(await positionIn(db, playlistB, onlyB)).toBe(before);
  });

  it("reorders a shared track within one playlist without touching the other", async () => {
    const posInB = await positionIn(db, playlistB, inBoth);
    const listA = await tracksInA();
    const reversed = [...listA].reverse();
    const res = await app.request(
      `/playlists/${playlistA}/reorder`,
      { method: "PATCH", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackIds: reversed }) },
      env
    );
    expect(res.status).toBe(200);
    expect(await positionIn(db, playlistA, reversed[0])).toBe(0);
    expect(await positionIn(db, playlistB, inBoth)).toBe(posInB);
  });
});

async function tracksInA(): Promise<string[]> {
  const res = await app.request(`/playlists/${playlistA}`, { headers: auth(ownerToken) }, env);
  const body = (await res.json()) as { tracks: { id: string }[] };
  return body.tracks.map((t) => t.id);
}
```

- [ ] **Step 2: Rewrite `tracks.ts`**

Apply these edits to `packages/api/src/routes/tracks.ts`:

1. Imports: remove `desc` if unused after the edits (it is still used by the library list, keep it). Add:
   ```ts
   import { requestCanAccessTrack } from "../lib/playlist-access.js";
   import { addTrackToPlaylist, playlistIdsForTracks } from "../lib/playlist-membership.js";
   ```
   and remove `requestCanAccessPlaylist` and `lockerIdForUserId` from the imports if nothing else in the file uses them (upload still uses `lockerIdForUserId`; keep that one).
2. Delete the local `nextPosition` function and the `type Db` line.
3. In upload: delete `let position = 0;` and `position = await nextPosition(db, playlistId);`. Remove `playlistId,` and `position,` from the `.values({...})` insert. After the insert and before `resolveDisplayNames`, add:
   ```ts
   if (playlistId) {
     await addTrackToPlaylist(db, playlistId, track.id);
   }
   ```
4. In the library list, after `rows` is fetched, add:
   ```ts
   const membership = await playlistIdsForTracks(db, rows.map((t: TrackRow) => t.id));
   ```
   and change the map to:
   ```ts
   return c.json({
     tracks: rows.map((t: TrackRow) =>
       publicTrack(t, user.id, names, { playlistIds: membership.get(t.id) ?? [] })
     ),
   });
   ```
5. In stream and download, replace the whole `if (track.playlistId) { ... } else { ... }` block with:
   ```ts
   if (!(await requestCanAccessTrack(c, track))) {
     return c.json({ error: "not found" }, 404);
   }
   ```
   Update the comment above the stream route: "gated by the parent playlist" becomes "gated by any playlist the track is in, or the locker (lib/playlist-access.ts requestCanAccessTrack)".
6. Replace the `PATCH /:id` route body entirely:
   ```ts
   // Retired by the playlist_tracks migration. A track no longer has one
   // playlist to move between; membership is added and removed per playlist
   // via POST/DELETE /playlists/:id/tracks. 410 rather than 404 so a stale web
   // bundle fails with a message instead of looking like a missing track.
   tracksRouter.patch("/:id", requireAuth, async (c) => {
     return c.json({ error: "moved: use POST/DELETE /playlists/:id/tracks" }, 410);
   });
   ```
   Remove the `playlists` import if it is now unused in this file.

- [ ] **Step 3: Rewrite `playlists.ts`**

Apply these edits to `packages/api/src/routes/playlists.ts`:

1. Imports: add
   ```ts
   import { requestCanUploadToPlaylist } from "../lib/playlist-access.js";
   import {
     tracksInPlaylist,
     addTrackToPlaylist,
     removeTrackFromPlaylist,
     type TrackInPlaylist,
   } from "../lib/playlist-membership.js";
   import { playlistTracks } from "../db/schema.js";
   ```
   (merge with the existing `../db/schema.js` and `../lib/playlist-access.js` import lines rather than duplicating them). `tracks` from schema may become unused in this file; remove it if so. `asc` from drizzle stays only if still used.
2. In `GET /:id`, replace the `trackList` query with:
   ```ts
   const trackList = await tracksInPlaylist(db, id);
   ```
   and the response map with:
   ```ts
   tracks: trackList.map((t: TrackInPlaylist) =>
     publicTrack(t, actingUserId, names, { position: t.position })
   ),
   ```
   The `names` resolution keeps `...trackList.map((t: TrackInPlaylist) => t.uploadedBy)`.
3. In reorder, replace the update loop with:
   ```ts
   // Scoped to this playlist's join rows. Without the playlistId predicate the
   // caller could pass any track ID they had ever seen and rewrite its
   // position in someone else's playlist — edit rights on one playlist are
   // not edit rights on every track ID in the instance. The same guard as
   // before the join table; only the table changed.
   for (let i = 0; i < trackIds.length; i++) {
     await db
       .update(playlistTracks)
       .set({ position: i })
       .where(and(eq(playlistTracks.trackId, trackIds[i]), eq(playlistTracks.playlistId, id)));
   }
   ```
4. Add the two new routes before `export default`:
   ```ts
   // Put a library track into this playlist. Same gate as upload: a locker
   // session, never a share token — a share link lets someone hear and
   // arrange the record, not decide what is on it.
   playlistsRouter.post("/:id/tracks", requireAuth, async (c) => {
     const db = getDb(c.env.DB);
     const id = c.req.param("id");
     const { trackId } = await c.req.json<{ trackId?: string }>();
     if (!trackId) return c.json({ error: "trackId required" }, 400);

     const ownerId = await requestCanUploadToPlaylist(c, id);
     if (!ownerId) return c.json({ error: "not found" }, 404);

     // The track must be in the same locker as the playlist. Wrong locker is
     // the same non-enumerable 404 a missing track gets.
     const [track] = await db
       .select({ id: tracks.id, ownerId: tracks.ownerId })
       .from(tracks)
       .where(eq(tracks.id, trackId))
       .limit(1);
     if (!track || track.ownerId !== ownerId) return c.json({ error: "not found" }, 404);

     const added = await addTrackToPlaylist(db, id, trackId);
     await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id));
     return c.json({ ok: true, added });
   });

   // Take a track out of THIS playlist. The track, its files, and its place in
   // every other playlist are untouched. This is the control that once
   // destroyed masters; it must never reach the tracks table or the bucket.
   playlistsRouter.delete("/:id/tracks/:trackId", requireAuth, async (c) => {
     const db = getDb(c.env.DB);
     const id = c.req.param("id");
     const trackId = c.req.param("trackId");

     const ownerId = await requestCanUploadToPlaylist(c, id);
     if (!ownerId) return c.json({ error: "not found" }, 404);

     await removeTrackFromPlaylist(db, id, trackId);
     await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id));
     return c.json({ ok: true });
   });
   ```
   Keep `tracks` in the schema import since the add route reads it.

- [ ] **Step 4: Typecheck the API package**

Run: `cd packages/api && npx tsc --noEmit`
Expected: errors only in `public.ts`, `shares.ts`, `comments.ts` and the test files that still write `playlistId` on tracks. No errors in `tracks.ts` or `playlists.ts`. If any remain there, fix them before moving on.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tracks.ts packages/api/src/routes/playlists.ts packages/api/src/routes/playlist-tracks.test.ts
git commit -m "feat(api): add/remove tracks per playlist; reorder and listings via playlist_tracks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

The new test file does not pass yet; Task 5 finishes the remaining routes and Task 6 fixes the fixtures, after which the whole suite runs.

---

### Task 5: Public, invite, and comment routes

**Files:**
- Modify: `packages/api/src/routes/public.ts:22-100`
- Modify: `packages/api/src/routes/shares.ts:258-266`
- Modify: `packages/api/src/routes/comments.ts:20-120`
- Modify: `packages/api/src/routes/playlist-tracks.test.ts` (append)

**Interfaces:**
- Consumes: `tracksInPlaylist`, `playlistIdsForTrack`, `requestCanAccessTrack`.
- Produces: unchanged response shapes on `/public/v1/playlists/:id`, `/public/v1/tracks/:id/stream`, `/shares/invite/:token`, and the comment routes.

- [ ] **Step 1: Append tests**

```ts
describe("public and comments through the join table", () => {
  it("a public playlist lists its tracks in order and streams them anonymously", async () => {
    const [pub] = await db.insert(playlists).values({ ownerId, name: "pub", isPublic: true }).returning();
    await addTrackToPlaylistDirect(pub.id, inBoth);
    const res = await app.request(`/public/v1/playlists/${pub.id}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: { tracks: { id: string }[] } };
    expect(body.playlist.tracks.map((t) => t.id)).toEqual([inBoth]);

    const stream = await app.request(`/public/v1/tracks/${inBoth}/stream`, {}, env);
    expect(stream.status).toBe(200);
    // Still private elsewhere: a track only in private B does not stream publicly.
    expect((await app.request(`/public/v1/tracks/${onlyB}/stream`, {}, env)).status).toBe(404);
  });

  it("a track comment shows under every playlist the track is in", async () => {
    const post = await app.request(
      `/comments`,
      { method: "POST", headers: { ...auth(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ trackId: inBoth, authorName: "DL", body: "chorus is late" }) },
      env
    );
    expect(post.status).toBe(201);

    // Read with A's listen token and with the owner session; both see it.
    const viaA = await app.request(`/comments/track/${inBoth}?token=${tokenA}`, {}, env);
    expect(viaA.status).toBe(200);
    const viaAbody = (await viaA.json()) as { comments: { body: string }[] };
    expect(viaAbody.comments.some((c) => c.body === "chorus is late")).toBe(true);

    // A's token cannot read comments on a track that is only in B.
    expect((await app.request(`/comments/track/${onlyB}?token=${tokenA}`, {}, env)).status).toBe(404);
  });

  it("the invite landing lists the playlist's tracks in order", async () => {
    const res = await app.request(`/shares/invite/${tokenA}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracks: { id: string }[] };
    expect(body.tracks[0].id).toBe(inBoth);
  });
});

async function addTrackToPlaylistDirect(playlistId: string, trackId: string) {
  const { addTrackToPlaylist } = await import("../lib/playlist-membership.js");
  await addTrackToPlaylist(db, playlistId, trackId);
}
```

Check the POST `/comments` status the existing route returns (201 or 200) in `packages/api/src/routes/comments.ts` and match it.

- [ ] **Step 2: Rewrite `public.ts`**

1. Import `playlistTracks` alongside `playlists, tracks` from schema.
2. In `GET /playlists/:id`, replace the `trackRows` query with:
   ```ts
   const trackRows = await db
     .select({
       id: tracks.id,
       title: tracks.title,
       duration: tracks.duration,
       waveformData: tracks.waveformData,
     })
     .from(playlistTracks)
     .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
     .where(eq(playlistTracks.playlistId, id))
     .orderBy(asc(playlistTracks.position));
   ```
3. In `GET /tracks/:id/stream`, replace the query with:
   ```ts
   // Public iff ANY playlist holding the track is public.
   const [row] = await db
     .select({ streamKey: tracks.streamKey })
     .from(tracks)
     .innerJoin(playlistTracks, eq(playlistTracks.trackId, tracks.id))
     .innerJoin(playlists, eq(playlistTracks.playlistId, playlists.id))
     .where(and(eq(tracks.id, id), eq(playlists.isPublic, true)))
     .limit(1);
   ```

- [ ] **Step 3: Rewrite the invite landing in `shares.ts`**

Around line 258, replace the `trackList` query with:

```ts
const trackList = await tracksInPlaylist(db, share.playlistId);
```

Import `tracksInPlaylist` and `type TrackInPlaylist` from `../lib/playlist-membership.js`. Where that route maps `trackList` through `publicTrack`, pass `{ position: t.position }` as the fourth argument and type the callback parameter as `TrackInPlaylist`. Remove `tracks` from the schema import in this file if nothing else uses it.

- [ ] **Step 4: Rewrite the comment gates in `comments.ts`**

1. Import `requestCanAccessTrack` from `../lib/playlist-access.js` and `playlistIdsForTrack` from `../lib/playlist-membership.js`.
2. In `POST /` (around line 28), replace the `if (trackId) { ... }` gate with:
   ```ts
   if (trackId) {
     const [track] = await db
       .select({ id: tracks.id, ownerId: tracks.ownerId })
       .from(tracks)
       .where(eq(tracks.id, trackId))
       .limit(1);
     allowed = track ? await requestCanAccessTrack(c, track) : false;
   } else if (playlistId) {
   ```
   Keep the `else if (playlistId)` branch as it is.
3. In `GET /track/:trackId` (around line 71), replace the track lookup and `canAccess` logic the same way: select `id, ownerId`, then `canAccess = track ? await requestCanAccessTrack(c, track) : false`.
4. In `commentTarget`, replace the body with:
   ```ts
   async function commentTarget(
     db: ReturnType<typeof getDb>,
     comment: { playlistId: string | null; trackId: string | null }
   ): Promise<CommentTarget | null> {
     if (comment.playlistId) {
       const [playlist] = await db
         .select({ ownerId: playlists.ownerId })
         .from(playlists)
         .where(eq(playlists.id, comment.playlistId))
         .limit(1);
       return playlist ? { lockerId: playlist.ownerId, playlistId: comment.playlistId } : null;
     }
     if (comment.trackId) {
       const [track] = await db
         .select({ ownerId: tracks.ownerId })
         .from(tracks)
         .where(eq(tracks.id, comment.trackId))
         .limit(1);
       if (!track) return null;
       // A track comment belongs to the locker. `playlistId` here only feeds
       // refuseModeration's "has this caller demonstrated read access"
       // question, so the first reachable playlist is enough; the moderation
       // decision itself is made on lockerId.
       const [first] = await playlistIdsForTrack(db, comment.trackId);
       return { lockerId: track.ownerId, playlistId: first ?? null };
     }
     return null;
   }
   ```
   Then update `refuseModeration` so a track-level comment tests readability with `requestCanAccessTrack` instead of the single playlist. Change its signature to accept the comment row's `trackId`:
   ```ts
   async function refuseModeration(
     c: any,
     target: CommentTarget,
     trackId: string | null
   ) {
     let readable = false;
     if (trackId) {
       const db = getDb(c.env.DB);
       readable = await requestCanAccessTrack(c, { id: trackId, ownerId: target.lockerId });
     } else if (target.playlistId) {
       readable = await requestCanAccessPlaylist(c, target.playlistId);
     }
     return readable
       ? c.json({ error: "forbidden" }, 403)
       : c.json({ error: "not found" }, 404);
   }
   ```
   Update every `refuseModeration(c, target)` call site in the file to pass the comment's `trackId` as the third argument. Find them with `grep -n "refuseModeration(" packages/api/src/routes/comments.ts`. With this change `commentTarget` no longer needs `playlistId` for track comments; simplify it to `return { lockerId: track.ownerId, playlistId: null };` and delete the `playlistIdsForTrack` import if unused.

- [ ] **Step 5: Typecheck**

Run: `cd packages/api && npx tsc --noEmit`
Expected: errors only in `*.test.ts` files that still write `playlistId` or `position` on tracks.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/public.ts packages/api/src/routes/shares.ts packages/api/src/routes/comments.ts packages/api/src/routes/playlist-tracks.test.ts
git commit -m "feat(api): public, invite and comment routes read membership from playlist_tracks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Migrate the existing API test fixtures

**Files:**
- Modify: every file listed by `grep -rl "playlistId\|position:" packages/api/src --include='*.test.ts'`. At the time of writing: `public-attribution.test.ts`, `accent.test.ts`, `security.test.ts`, `public.test.ts`, `attribution.test.ts`, `legacy-access.test.ts`, `membership.test.ts`, `collab.test.ts`.

**Interfaces:**
- Consumes: `seedTrack` and `positionIn` from `packages/api/src/test/seed.ts`.

The invariant: no test inserts into `tracks` with `playlistId` or `position`, and no test reads `.position` or `.playlistId` off a track row. Run the grep, not this list, to decide when you are done.

- [ ] **Step 1: Replace each `db.insert(tracks).values({...})` with `seedTrack`**

Pattern. This:

```ts
const [tPriv] = await db
  .insert(tracks)
  .values({ playlistId: privateId, ownerId: owner.id, title: "priv track", position: 0, originalKey: "k-priv", streamKey: "k-priv" })
  .returning();
```

becomes:

```ts
const tPriv = await seedTrack(db, { ownerId: owner.id, title: "priv track", originalKey: "k-priv", streamKey: "k-priv", playlistIds: [privateId] });
```

A track with `playlistId: null` or no `playlistId` becomes `seedTrack(db, { ... })` with no `playlistIds`. Array inserts (`.values([{...}, {...}])`) become one `seedTrack` call per element, in the same order so positions match. Add `import { seedTrack } from "../test/seed.js";` (adjust the relative path per file) and drop `tracks` from the schema import where it is no longer used.

- [ ] **Step 2: Fix assertions that read position or playlistId**

In `security.test.ts` "reorder cannot reach tracks in another playlist" (lines 194-214), replace the two `db.select().from(tracks)` reads with `positionIn(db, victimPlaylist, victimTrack)`; look up the variable holding the victim's playlist id in that file's `beforeAll`. Any test asserting `track.playlistId` on a response body should assert `playlistIds` (library) or the track's presence in `GET /playlists/:id` instead.

- [ ] **Step 3: Typecheck, then run the whole API suite**

Run: `cd packages/api && npx tsc --noEmit && npm test`
Expected: typecheck clean, every test file PASS including `playlist-tracks.test.ts` and `0007_backfill.test.ts`.

- [ ] **Step 4: Confirm the invariant**

Run: `grep -rn "playlistId:\|position:" packages/api/src --include='*.test.ts' | grep -v "playlistIds\|seed.ts"`
Expected: no lines that insert onto `tracks`. Hits on `shares`, `comments`, or request bodies (`playlistId` in a share create, `trackIds` in reorder) are fine.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "test(api): seed tracks through playlist_tracks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: OpenAPI

**Files:**
- Modify: `docs/openapi.json`

- [ ] **Step 1: Update the `Track` schema**

In `components.schemas.Track`, delete `playlistId`, change `position` to optional (leave the property, remove it from any `required` list, add `"description": "Only in a playlist listing: this track's order in that playlist."`), and add:

```json
"playlistIds": {
  "type": "array",
  "items": { "type": "string", "format": "uuid" },
  "description": "Only in GET /tracks: every playlist this track is in. Empty for a library-only track."
}
```

- [ ] **Step 2: Retire `/tracks/{id}` patch**

Replace the `patch` operation under `/tracks/{id}` with:

```json
"patch": {
  "summary": "Retired: moving a track between playlists",
  "description": "Always 410. A track no longer belongs to one playlist. Add or remove membership with POST and DELETE /playlists/{id}/tracks.",
  "operationId": "moveTrackRetired",
  "deprecated": true,
  "security": [{ "bearerAuth": [] }],
  "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string", "format": "uuid" } }],
  "responses": {
    "410": { "description": "Route retired.", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
  }
}
```

- [ ] **Step 3: Add the two new paths**

Insert after `/playlists/{id}/reorder`:

```json
"/playlists/{id}/tracks": {
  "post": {
    "summary": "Add a library track to a playlist",
    "description": "Locker-scoped: the locker owner or a collaborator session. Share tokens are not accepted. The track must be in the same locker as the playlist; a track from another locker or a playlist the caller cannot see both return the same non-enumerable 404. Appended to the end of the playlist's order. Adding a track already present is a no-op 200 with added=false.",
    "operationId": "addTrackToPlaylist",
    "security": [{ "bearerAuth": [] }],
    "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string", "format": "uuid" } }],
    "requestBody": {
      "required": true,
      "content": { "application/json": { "schema": { "type": "object", "properties": { "trackId": { "type": "string", "format": "uuid" } }, "required": ["trackId"] } } }
    },
    "responses": {
      "200": { "description": "Membership ensured.", "content": { "application/json": { "schema": { "type": "object", "properties": { "ok": { "type": "boolean" }, "added": { "type": "boolean" } }, "required": ["ok", "added"] } } } },
      "400": { "description": "trackId missing.", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
      "401": { "description": "Missing, invalid, or expired session token.", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
      "404": { "description": "Playlist not reachable, or track not in this locker.", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
    }
  }
},
"/playlists/{id}/tracks/{trackId}": {
  "delete": {
    "summary": "Remove a track from one playlist",
    "description": "Locker-scoped, same gate as adding. Removes the track from THIS playlist only. The track, its files, and its membership in every other playlist are untouched; a track removed from its last playlist stays in the library. This never deletes a track. Use DELETE /tracks/{id} for that.",
    "operationId": "removeTrackFromPlaylist",
    "security": [{ "bearerAuth": [] }],
    "parameters": [
      { "name": "id", "in": "path", "required": true, "schema": { "type": "string", "format": "uuid" } },
      { "name": "trackId", "in": "path", "required": true, "schema": { "type": "string", "format": "uuid" } }
    ],
    "responses": {
      "200": { "description": "Removed (or was not present).", "content": { "application/json": { "schema": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] } } } },
      "401": { "description": "Missing, invalid, or expired session token.", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
      "404": { "description": "Playlist not reachable.", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
    }
  }
}
```

Also update the `GET /tracks` description to mention `playlistIds`, and the descriptions on `/tracks/{id}/stream` and `/tracks/{id}/download` from "gated by the parent playlist" to "gated by any playlist the track is in, or a locker session".

- [ ] **Step 4: Validate the JSON**

Run: `python3 -c "import json; json.load(open('docs/openapi.json')); print('ok')"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add docs/openapi.json
git commit -m "docs(openapi): playlist track membership routes, Track.playlistIds, retire PATCH /tracks/{id}

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Web API client and audio player context

**Files:**
- Modify: `packages/web/src/lib/api.ts:183-266`
- Modify: `packages/web/src/lib/audio.ts:73-76` and the state object
- Modify: `packages/web/src/components/Player.tsx:236-239`
- Modify: `packages/web/src/pages/PlaylistView.tsx:189,222,230`
- Modify: `packages/web/src/pages/Invite.tsx:48,72`
- Modify: `packages/web/src/pages/Home.tsx:229`

**Interfaces:**
- Produces:
  - `Track` type: no `playlistId`, `position?: number`, `playlistIds?: string[]`.
  - `playlists.addTrack(playlistId, trackId): Promise<{ ok: true; added: boolean }>`
  - `playlists.removeTrack(playlistId, trackId): Promise<{ ok: true }>`
  - `player.setPlaylist(tracks, playlistId: string | null)` and `player.getState().playlistId`.

- [ ] **Step 1: Edit the `Track` type and client functions**

In `packages/web/src/lib/api.ts`:

1. In `Track`, remove `playlistId: string | null;`. Change `position: number;` to `position?: number;` with the comment `// Only in a playlist listing: order within that playlist.` Add `playlistIds?: string[];` with the comment `// Only in the library listing: every playlist this track is in.`
2. In `tracks`, delete the `attach` entry.
3. In `playlists`, after `reorder`, add:
   ```ts
   addTrack: (id: string, trackId: string) =>
     request<{ ok: true; added: boolean }>(`/playlists/${id}/tracks`, {
       method: "POST",
       body: JSON.stringify({ trackId }),
     }),
   removeTrack: (id: string, trackId: string) =>
     request<{ ok: true }>(`/playlists/${id}/tracks/${trackId}`, { method: "DELETE" }),
   ```

- [ ] **Step 2: Give the audio player a playlist context**

In `packages/web/src/lib/audio.ts`, find where `playlist` and `currentIndex` are declared and the state object that `getState()` returns. Add a module variable `let playlistId: string | null = null;`, include `playlistId` in the state object, and change:

```ts
setPlaylist(tracks: Track[], id: string | null = null) {
  playlist = tracks;
  playlistId = id;
},
```

Ensure `notify()` includes `playlistId` in what it publishes (it builds the state object; add the field there).

- [ ] **Step 3: Player artwork from the context**

In `packages/web/src/components/Player.tsx` replace lines 236-239 with:

```ts
// Artwork belongs to the playlist being played, not the track: a track can
// be in several playlists, and the library has none.
const artworkSrc = state.playlistId
  ? playlistsApi.artworkUrlUnchecked(state.playlistId)
  : null;
```

- [ ] **Step 4: Pass the id at every `setPlaylist` call**

- `PlaylistView.tsx` lines 189, 222, 230: `player.setPlaylist(r.tracks, playlistId)`, `player.setPlaylist(reordered, playlistId)`, `player.setPlaylist(before, playlistId)`.
- `Invite.tsx` lines 48 and 72: `player.setPlaylist(r.tracks, r.playlist.id)` and `player.setPlaylist(reordered, playlist.id)` (use whatever variable holds the playlist in scope at line 72; read the surrounding code).
- `Home.tsx` line 229: `player.setPlaylist(library, null)`.

Confirm with: `grep -rn "setPlaylist(" packages/web/src --include='*.tsx' | grep -v test` — every hit passes two arguments.

- [ ] **Step 5: Typecheck the web package**

Run: `cd packages/web && npx tsc --noEmit`
Expected: errors only in `TrackList.tsx` (`tracksApi.attach`) and `PlaylistView.tsx` (`attach`, `t.playlistId`), plus their tests. Tasks 9 and 10 fix those.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/audio.ts packages/web/src/components/Player.tsx packages/web/src/pages/PlaylistView.tsx packages/web/src/pages/Invite.tsx packages/web/src/pages/Home.tsx
git commit -m "feat(web): playlist membership client calls; player artwork follows the playlist being played

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Remove control calls the per-playlist route

**Files:**
- Modify: `packages/web/src/components/TrackList.tsx:8-16, 58, 87-108`
- Modify: `packages/web/src/components/TrackList.test.tsx:16-22, 36-38, 40-47, 68-90`
- Modify: `packages/web/src/pages/PlaylistView.tsx` (the `<TrackList>` render, pass `playlistId`)
- Modify: `packages/web/src/pages/Invite.tsx` (the `<TrackList>` render, if it passes `onRemove`; otherwise no change)

**Interfaces:**
- Produces: `TrackList` prop `playlistId: string` required whenever `onRemove` is supplied.

- [ ] **Step 1: Update the test**

In `packages/web/src/components/TrackList.test.tsx`:

1. Change the `../lib/api` mock so `tracks` no longer has `attach` and `playlists` has `removeTrack`:
   ```ts
   vi.mock("../lib/api", () => ({
     tracks: {
       delete: vi.fn(async () => ({})),
       downloadUrl: (id: string) => `/tracks/${id}/download`,
     },
     playlists: {
       removeTrack: vi.fn(async () => ({ ok: true })),
     },
   }));
   ```
   Keep whatever other members of the existing mock the component imports (read the current mock at lines 16-22 and preserve any entries not named here).
2. Import `playlists as playlistsApi` alongside `tracks as tracksApi` and replace `const attachMock = vi.mocked(tracksApi.attach);` with `const removeMock = vi.mocked(playlistsApi.removeTrack);`.
3. In the `track` fixture remove `playlistId: "p1"`.
4. In `render`, pass `playlistId="p1"` to `<TrackList>`.
5. In "detaches the track instead of deleting it", replace `attachMock` with `removeMock` and the key assertion with `expect(removeMock).toHaveBeenCalledWith("p1", "t1");`. Rename the test to "removes the track from this playlist instead of deleting it".
6. Anywhere else `attachMock` appears, use `removeMock`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/web && npx vitest run src/components/TrackList.test.tsx`
Expected: FAIL, `removeTrack` never called / `attach` is not a function.

- [ ] **Step 3: Change the component**

In `packages/web/src/components/TrackList.tsx`:

1. Add to `Props`: `playlistId?: string;` with the comment `// Required when onRemove is set: which playlist the remove control acts on.`
2. Change the import from `tracks as tracksApi` to also import `playlists as playlistsApi` (keep `tracksApi` if the file still uses it for download URLs; check).
3. Destructure `playlistId` in the component signature.
4. In `handleRemove`, replace `await tracksApi.attach(trackId, null);` with:
   ```ts
   if (!playlistId) return;
   await playlistsApi.removeTrack(playlistId, trackId);
   ```
   and update the comment above it: "Remove from THIS playlist, never destroy: the track keeps its master, its rendition, and its place in every other playlist."
5. Update the `Props` comment on `onRemove` (lines 10-15) to drop the sentence about `PATCH /tracks/:id`.

- [ ] **Step 4: Pass `playlistId` from the pages**

In `PlaylistView.tsx`, find the `<TrackList` element and add `playlistId={playlistId}`. In `Invite.tsx`, if `<TrackList` is rendered with `onRemove`, add `playlistId={playlist.id}`; if it is rendered without `onRemove`, leave it.

- [ ] **Step 5: Run the test**

Run: `cd packages/web && npx vitest run src/components/TrackList.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/TrackList.tsx packages/web/src/components/TrackList.test.tsx packages/web/src/pages/PlaylistView.tsx packages/web/src/pages/Invite.tsx
git commit -m "feat(web): remove control detaches from this playlist only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The picker lists every library track not already here

**Files:**
- Modify: `packages/web/src/pages/PlaylistView.tsx:167-177, 504-510`
- Create: `packages/web/src/pages/PlaylistView.addtracks.test.tsx`

**Interfaces:**
- Consumes: `playlists.addTrack`, `Track.playlistIds`.

- [ ] **Step 1: Write the picker test**

Model the mocks on `PlaylistView.owner.test.tsx` (copy its `vi.mock("../lib/api", ...)` and `vi.mock("../lib/audio", ...)` blocks, then adjust). The test:

```tsx
// @vitest-environment happy-dom
//
// The add picker must offer every library track that is not already in THIS
// playlist. Before the join table it offered only tracks in NO playlist, which
// is why a track could never be added to a second one.
//
// House test pattern (createRoot + act). See PlaylistView.owner.test.tsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlaylistView from "./PlaylistView";
import { playlists as playlistsApi, tracks as tracksApi, auth } from "../lib/api";
import type { Playlist, Track, User } from "../lib/api";

vi.mock("../lib/api", () => ({
  auth: { me: vi.fn() },
  playlists: {
    get: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => ({})),
    addTrack: vi.fn(async () => ({ ok: true, added: true })),
    removeTrack: vi.fn(async () => ({ ok: true })),
    artworkUrl: () => null,
  },
  tracks: {
    list: vi.fn(),
    downloadUrl: (id: string) => `/tracks/${id}/download`,
    streamUrl: (id: string) => `/tracks/${id}/stream`,
  },
  shares: { forPlaylist: vi.fn(async () => ({ shares: [] })) },
  comments: {
    forPlaylist: vi.fn(async () => ({ comments: [] })),
    forTrack: vi.fn(async () => ({ comments: [] })),
    create: vi.fn(async () => ({ comment: {} })),
    resolve: vi.fn(async () => ({ comment: {} })),
    remove: vi.fn(async () => ({ ok: true })),
  },
  getApiOrigin: () => "http://localhost:3001",
}));

vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playing: false, duration: 0, currentTime: 0, playlistId: null }),
    subscribe: () => () => {},
    setPlaylist: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    clear: vi.fn(),
  },
}));

const playlist = { id: "pl-1", name: "reel", ownerId: "u1", isPublic: false, artworkKey: null, createdByMe: true, createdByName: null } as unknown as Playlist;
const here = { id: "t-here", title: "already here", hasStream: true, playlistIds: ["pl-1"] } as unknown as Track;
const elsewhere = { id: "t-else", title: "in another", hasStream: true, playlistIds: ["pl-2"] } as unknown as Track;
const nowhere = { id: "t-lib", title: "library only", hasStream: true, playlistIds: [] } as unknown as Track;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PlaylistView add-tracks picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.me).mockResolvedValue({ user: { id: "u1", email: "o@test.dev", lockerOwnerId: null, displayName: null, accent: null } as unknown as User });
    vi.mocked(playlistsApi.get).mockResolvedValue({ playlist, tracks: [here] });
    vi.mocked(tracksApi.list).mockResolvedValue({ tracks: [here, elsewhere, nowhere] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers tracks in other playlists and in none, but not the ones already here", async () => {
    act(() => {
      root.render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
    });
    await flush();

    const openBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("add tracks"));
    expect(openBtn).toBeDefined();
    await act(async () => {
      openBtn!.click();
    });
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("in another");
    expect(text).toContain("library only");
    const addButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.includes("[+ add]"));
    expect(addButtons).toHaveLength(2);
  });

  it("adds through the playlist route", async () => {
    act(() => {
      root.render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
    });
    await flush();
    const openBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("add tracks"))!;
    await act(async () => {
      openBtn.click();
    });
    await flush();

    const row = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("[+ add]") && b.parentElement?.textContent?.includes("in another")
    )!;
    await act(async () => {
      row.click();
    });
    await flush();

    expect(playlistsApi.addTrack).toHaveBeenCalledWith("pl-1", "t-else");
  });
});
```

Check the exact `User` fields `auth.me` returns in `api.ts` (line ~440) and match the cast. Check how `PlaylistView.owner.test.tsx` flushes promises and copy its approach if it differs from `flush()` above.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/web && npx vitest run src/pages/PlaylistView.addtracks.test.tsx`
Expected: FAIL. The picker filters on `t.playlistId === null` (undefined now, so nothing shows) and `addTrack` calls `tracksApi.attach`, which the mock lacks.

- [ ] **Step 3: Change the picker**

In `packages/web/src/pages/PlaylistView.tsx`:

```ts
async function openAddTracks() {
  const r = await tracksApi.list();
  // Everything in the library that is not already in THIS playlist. A track
  // may be in any number of other playlists; that is no reason to hide it.
  setLibraryTracks(r.tracks.filter((t) => !(t.playlistIds ?? []).includes(playlistId)));
  setShowAddTracks(true);
}

async function addTrack(id: string) {
  await api.addTrack(playlistId, id);
  setLibraryTracks(libraryTracks.filter((t) => t.id !== id));
  load();
}
```

`api` here is the `playlists as api` import already at the top of the file. Change the empty-state copy at line 507 from "no unattached tracks in your library — upload from the main page" to "every track in your library is already in this playlist — upload from the main page".

- [ ] **Step 4: Run the new test and the other PlaylistView tests**

Run: `cd packages/web && npx vitest run src/pages`
Expected: all PASS. If `PlaylistView.owner.test.tsx` asserts on the old empty-state copy, update the string there.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/PlaylistView.tsx packages/web/src/pages/PlaylistView.addtracks.test.tsx packages/web/src/pages/PlaylistView.owner.test.tsx
git commit -m "feat(web): add picker offers every library track not already in this playlist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Library rows show playlist membership

**Files:**
- Modify: `packages/web/src/pages/Home.tsx:767-810`
- Modify: `packages/web/src/pages/Home.test.tsx` (append one test)

- [ ] **Step 1: Write the test**

Append to `packages/web/src/pages/Home.test.tsx`, reusing that file's existing render helper and mocks (read how its other tests mount `<Home>` and resolve `playlists.list` / `tracks.list`, and follow the same shape):

```tsx
describe("library rows show playlist membership", () => {
  it("names each playlist a track is in, and nothing for a library-only track", async () => {
    vi.mocked(playlistsApi.list).mockResolvedValue({
      playlists: [
        { id: "pl-1", name: "reel", ownerId: "u1", isPublic: false, artworkKey: null, createdByMe: true, createdByName: null } as unknown as Playlist,
        { id: "pl-2", name: "for the label", ownerId: "u1", isPublic: false, artworkKey: null, createdByMe: true, createdByName: null } as unknown as Playlist,
      ],
    });
    vi.mocked(tracksApi.list).mockResolvedValue({
      tracks: [
        { id: "t1", title: "two homes", hasStream: true, duration: 10, uploadedByMe: true, uploadedByName: null, playlistIds: ["pl-1", "pl-2"] } as unknown as Track,
        { id: "t2", title: "loose", hasStream: true, duration: 10, uploadedByMe: true, uploadedByName: null, playlistIds: [] } as unknown as Track,
      ],
    });
    await mount(); // the file's existing mount/flush helper
    const rows = Array.from(container.querySelectorAll("[data-track-row]"));
    const twoHomes = rows.find((r) => r.textContent?.includes("two homes"))!;
    expect(twoHomes.textContent).toContain("reel");
    expect(twoHomes.textContent).toContain("for the label");
    const loose = rows.find((r) => r.textContent?.includes("loose"))!;
    expect(loose.textContent).not.toContain("reel");
  });
});
```

Import `playlists as playlistsApi` and `tracks as tracksApi` from `../lib/api` at the top of the test file if not already imported. Replace `mount()` with whatever the file actually uses.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/web && npx vitest run src/pages/Home.test.tsx`
Expected: the new test FAILS (no `[data-track-row]`, no playlist names).

- [ ] **Step 3: Render membership**

In `packages/web/src/pages/Home.tsx`, in the `library.map((t) => {` block:

1. Add `data-track-row` to the row `<div>` (the one with `key={t.id}` and `onClick={() => playLibraryTrack(t.id)}`).
2. After the `<Attribution ... />` element and before the duration span, add:
   ```tsx
   {/* Which playlists hold this track. Names, not ids; a library-only
       track shows nothing rather than "0 playlists". */}
   {(t.playlistIds ?? []).length > 0 && (
     <span style={{ color: "var(--fg-dim)", fontSize: "12px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
       {(t.playlistIds ?? [])
         .map((id) => playlists.find((p) => p.id === id)?.name)
         .filter((n): n is string => Boolean(n))
         .join(" · ")}
     </span>
   )}
   ```
   `playlists` is the page's existing state array.

- [ ] **Step 4: Run the Home tests**

Run: `cd packages/web && npx vitest run src/pages/Home.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full web suite and typecheck**

Run: `cd packages/web && npx tsc --noEmit && npm test`
Expected: clean and all PASS. Any remaining test that mocks `tracks.attach` or sets `playlistId` on a `Track` fixture is fixed by removing that field; the grep `grep -rn "attach\|playlistId:" packages/web/src --include='*.test.tsx'` must return only hits that refer to playlist props or share/comment payloads, not track fixtures.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/Home.tsx packages/web/src/pages/Home.test.tsx
git commit -m "feat(web): library rows name the playlists each track is in

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Embed player verification, full checks, rollout notes

**Files:**
- Modify: `docs/upgrading.md` (one paragraph)
- No player code changes expected.

- [ ] **Step 1: Run the player suite unchanged**

Run: `cd packages/player && npm test`
Expected: PASS. The player reads `json.playlist.tracks` from `/public/v1/playlists/:id`, whose shape Task 5 preserved. If any test fails, the shape changed and Task 5 must be corrected, not the player.

- [ ] **Step 2: Root typecheck and every suite**

Run from the repo root:
```bash
npm run typecheck && (cd packages/api && npm test) && (cd packages/web && npm test) && (cd packages/player && npm test)
```
Expected: all clean.

- [ ] **Step 3: Live smoke against a fresh local database**

Run the API locally on SQLite (`cd packages/api && npm run dev`), sign up, create two playlists, upload one track into the first, add it to the second from the second playlist's picker, confirm it appears in both, remove it from the first, confirm it stays in the second and in the library, and play it from the second playlist and confirm the second playlist's artwork shows in the player. Record what you did and saw in the commit message of Step 5.

- [ ] **Step 4: Rollout note**

Append to `docs/upgrading.md` under the section on migrations:

```markdown
### 0007: tracks in multiple playlists

Migration 0007 moves playlist membership from `tracks.playlist_id` onto a
`playlist_tracks` join table, backfills it, and drops `playlist_id` and
`position` from `tracks`. Before applying it on a Cloudflare instance, export
the D1 database (`wrangler d1 export <name> --output before-0007.sql`). After
applying, `SELECT count(*) FROM playlist_tracks` must equal the number of
tracks that had a playlist before. Web bundles older than this release will
get a 410 from the retired `PATCH /tracks/:id`; deploy the API and the web
app together.
```

- [ ] **Step 5: Commit**

```bash
git add docs/upgrading.md
git commit -m "docs: upgrade note for migration 0007; smoke-tested add/remove/play across two playlists

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand back to DL**

Not automated. Before merging: export the dlisok D1, apply 0007, compare the counts, deploy. Then a CLI release, which DL tags.
