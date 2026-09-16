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
