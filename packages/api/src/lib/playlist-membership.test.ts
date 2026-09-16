import { describe, it, expect, beforeAll } from "vitest";
import { createSqliteDb } from "../db/sqlite.js";
import type { Database } from "../db/index.js";
import { users, playlists } from "../db/schema.js";
import { seedTrack } from "../test/seed.js";
import {
  playlistIdsForTrack,
  playlistIdsForTracks,
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

  it("answers membership for a batch of tracks, including ones in none", async () => {
    const t = await seedTrack(db, { ownerId, title: "batch", playlistIds: [b] });
    const lib = await seedTrack(db, { ownerId, title: "batch-lib" });
    const m = await playlistIdsForTracks(db, [t.id, lib.id, "no-such-track"]);
    expect(m.get(t.id)).toEqual([b]);
    expect(m.get(lib.id)).toEqual([]);
    expect(m.get("no-such-track")).toEqual([]);
    expect(await playlistIdsForTracks(db, [])).toEqual(new Map());
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
