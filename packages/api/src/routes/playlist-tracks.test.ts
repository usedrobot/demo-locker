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
