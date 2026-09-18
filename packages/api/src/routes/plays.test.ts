// Play counts. A play is recorded by the client when playback starts (the
// stream route is hit many times per listen by Range requests, so counting
// there would overcount). Every listener counts, the owner included — DL's
// ruling 2026-09-18, no dedupe. The library listing carries the total per
// track; a playlist listing carries the plays that came through THAT playlist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { eq } from "drizzle-orm";
import { users, playlists, sessions, shares, plays } from "../db/schema.js";
import { seedTrack } from "../test/seed.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;

let ownerId: string;
let ownerToken: string;
let strangerToken: string;
let playlistA: string; // private
let playlistB: string; // public
let tokenA: string; // listen share for A
let inBoth: string; // track in A and B
let onlyA: string; // track in A only (never public)
let libraryOnly: string; // track in no playlist

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    env
  );
}

async function libraryPlays(): Promise<Map<string, number>> {
  const res = await app.request("/tracks", { headers: auth(ownerToken) }, env);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { tracks: { id: string; plays: number }[] };
  return new Map(json.tracks.map((t) => [t.id, t.plays]));
}

async function playlistPlays(playlistId: string): Promise<Map<string, number>> {
  const res = await app.request(`/playlists/${playlistId}`, { headers: auth(ownerToken) }, env);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { tracks: { id: string; plays: number }[] };
  return new Map(json.tracks.map((t) => [t.id, t.plays]));
}

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-plays-"));
  const bucket = createFsBucket(root);
  env = { DB: "sqlite", DEMOS_BUCKET: bucket };

  const [owner] = await db.insert(users).values({ email: "pl-owner@test.dev", passwordHash: "x" }).returning();
  const [stranger] = await db.insert(users).values({ email: "pl-stranger@test.dev", passwordHash: "x" }).returning();
  ownerId = owner.id;
  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "pl-owner-token";
  strangerToken = "pl-stranger-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: stranger.id, token: strangerToken, expiresAt: future });

  const [a] = await db.insert(playlists).values({ ownerId, name: "A" }).returning();
  const [b] = await db.insert(playlists).values({ ownerId, name: "B", isPublic: true }).returning();
  playlistA = a.id;
  playlistB = b.id;

  tokenA = "pl-share-a";
  await db.insert(shares).values({ playlistId: playlistA, token: tokenA, permission: "listen", createdBy: ownerId });

  inBoth = (await seedTrack(db, { ownerId, title: "both", playlistIds: [playlistA, playlistB] })).id;
  onlyA = (await seedTrack(db, { ownerId, title: "only a", playlistIds: [playlistA] })).id;
  libraryOnly = (await seedTrack(db, { ownerId, title: "lib" })).id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("counts start at zero", () => {
  it("library and playlist listings carry plays: 0 for an unplayed track", async () => {
    expect((await libraryPlays()).get(libraryOnly)).toBe(0);
    expect((await playlistPlays(playlistA)).get(onlyA)).toBe(0);
  });
});

describe("POST /tracks/:id/plays", () => {
  it("owner session: records a library play, counted in the total only", async () => {
    const res = await post(`/tracks/${libraryOnly}/plays`, {}, auth(ownerToken));
    expect(res.status).toBe(201);
    expect((await libraryPlays()).get(libraryOnly)).toBe(1);
  });

  it("with a playlistId the track is in: counts in that playlist and in the total", async () => {
    const res = await post(`/tracks/${inBoth}/plays`, { playlistId: playlistA }, auth(ownerToken));
    expect(res.status).toBe(201);
    expect((await playlistPlays(playlistA)).get(inBoth)).toBe(1);
    expect((await playlistPlays(playlistB)).get(inBoth)).toBe(0);
    expect((await libraryPlays()).get(inBoth)).toBe(1);
  });

  it("with a playlistId the track is NOT in: stored as a library play, not attributed", async () => {
    const res = await post(`/tracks/${onlyA}/plays`, { playlistId: playlistB }, auth(ownerToken));
    expect(res.status).toBe(201);
    expect((await playlistPlays(playlistA)).get(onlyA)).toBe(0);
    expect((await libraryPlays()).get(onlyA)).toBe(1);
  });

  it("listen share token for A: counts a play in A", async () => {
    const res = await post(`/tracks/${onlyA}/plays`, { playlistId: playlistA }, auth(tokenA));
    expect(res.status).toBe(201);
    expect((await playlistPlays(playlistA)).get(onlyA)).toBe(1);
    expect((await libraryPlays()).get(onlyA)).toBe(2);
  });

  it("share token for A cannot record a play against a track it cannot reach", async () => {
    const res = await post(`/tracks/${libraryOnly}/plays`, {}, auth(tokenA));
    expect(res.status).toBe(404);
    expect((await libraryPlays()).get(libraryOnly)).toBe(1);
  });

  it("stranger session: 404, nothing recorded", async () => {
    const res = await post(`/tracks/${inBoth}/plays`, {}, auth(strangerToken));
    expect(res.status).toBe(404);
    expect((await libraryPlays()).get(inBoth)).toBe(1);
  });

  it("anonymous: 404", async () => {
    const res = await post(`/tracks/${inBoth}/plays`, {});
    expect(res.status).toBe(404);
  });

  it("every play counts — no dedupe on repeat", async () => {
    await post(`/tracks/${libraryOnly}/plays`, {}, auth(ownerToken));
    await post(`/tracks/${libraryOnly}/plays`, {}, auth(ownerToken));
    expect((await libraryPlays()).get(libraryOnly)).toBe(3);
  });
});

describe("POST /public/v1/tracks/:id/plays", () => {
  it("a track in a public playlist: anonymous play counted against that playlist", async () => {
    const res = await post(`/public/v1/tracks/${inBoth}/plays`, { playlistId: playlistB });
    expect(res.status).toBe(201);
    expect((await playlistPlays(playlistB)).get(inBoth)).toBe(1);
    expect((await libraryPlays()).get(inBoth)).toBe(2);
  });

  it("a public track with a PRIVATE playlistId: attributed to nothing, not to the private playlist", async () => {
    const before = (await playlistPlays(playlistA)).get(inBoth);
    const res = await post(`/public/v1/tracks/${inBoth}/plays`, { playlistId: playlistA });
    expect(res.status).toBe(201);
    expect((await playlistPlays(playlistA)).get(inBoth)).toBe(before);
    expect((await libraryPlays()).get(inBoth)).toBe(3);
  });

  it("a track in no public playlist: 404, same body as nonexistent", async () => {
    const res = await post(`/public/v1/tracks/${onlyA}/plays`, {});
    expect(res.status).toBe(404);
    const missing = await post(`/public/v1/tracks/nope/plays`, {});
    expect(missing.status).toBe(404);
    expect(await res.json()).toEqual(await missing.json());
  });
});

describe("deleting the track", () => {
  it("drops its plays with it (FK cascade)", async () => {
    const res = await app.request(`/tracks/${libraryOnly}`, { method: "DELETE", headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const rows = await db.select().from(plays).where(eq(plays.trackId, libraryOnly));
    expect(rows).toHaveLength(0);
  });
});
