// Legacy (non-`/public/v1`) read/write endpoints must no longer treat an
// unguessable playlist/track ID as a bearer capability. Phase B publishes
// those IDs on the open web, so each of these routes is now gated behind:
//   (a) a valid session whose user OWNS the playlist, OR
//   (b) a valid share/invite token that maps to the playlist.
// Everything else must get the same non-enumerable 404 the public API uses.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createPgliteDb } from "../db/pglite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, playlists, tracks, sessions, shares } from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;

let ownerToken: string; // session token of the playlist owner
let strangerToken: string; // session token of an unrelated user
let shareToken: string; // valid share/invite token for the private playlist

let privateId: string;
let privateTrackId: string;

const NONEXISTENT = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  db = await createPgliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-legacy-"));
  const bucket = createFsBucket(root);
  env = { DATABASE_URL: "pglite", DEMOS_BUCKET: bucket };

  const [owner] = await db
    .insert(users)
    .values({ email: "legacy-owner@test.dev", passwordHash: "x" })
    .returning();
  const [stranger] = await db
    .insert(users)
    .values({ email: "legacy-stranger@test.dev", passwordHash: "x" })
    .returning();

  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "sess-owner-token";
  strangerToken = "sess-stranger-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: stranger.id, token: strangerToken, expiresAt: future });

  const [priv] = await db
    .insert(playlists)
    .values({ ownerId: owner.id, name: "private demo", artworkKey: "art-priv" })
    .returning();
  privateId = priv.id;

  await bucket.put("art-priv", Buffer.from("IMGDATA"), {
    httpMetadata: { contentType: "image/png" },
  });
  await bucket.put("k-priv", Buffer.from("0123456789"), {
    httpMetadata: { contentType: "audio/wav" },
  });

  const [tPriv] = await db
    .insert(tracks)
    .values({ playlistId: privateId, title: "priv track", position: 0, originalKey: "k-priv", streamKey: "k-priv" })
    .returning();
  privateTrackId = tPriv.id;

  shareToken = "share-token-abc";
  await db.insert(shares).values({ playlistId: privateId, token: shareToken, permission: "listen" });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("legacy endpoint access gating", () => {
  it("1. anonymous GET /playlists/:id on a private playlist 404s identically to a nonexistent one", async () => {
    const priv = await app.request(`/playlists/${privateId}`, {}, env);
    const missing = await app.request(`/playlists/${NONEXISTENT}`, {}, env);
    expect(priv.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await priv.text()).toBe(await missing.text());
  });

  it("2. GET /playlists/:id with a valid share token -> 200", async () => {
    const viaQuery = await app.request(`/playlists/${privateId}?token=${shareToken}`, {}, env);
    expect(viaQuery.status).toBe(200);
    const viaHeader = await app.request(
      `/playlists/${privateId}`,
      { headers: { Authorization: `Bearer ${shareToken}` } },
      env
    );
    expect(viaHeader.status).toBe(200);
  });

  it("3. owner session -> 200, unrelated user's session -> 404", async () => {
    const owner = await app.request(
      `/playlists/${privateId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env
    );
    expect(owner.status).toBe(200);
    const stranger = await app.request(
      `/playlists/${privateId}`,
      { headers: { Authorization: `Bearer ${strangerToken}` } },
      env
    );
    expect(stranger.status).toBe(404);
  });

  it("gates artwork the same way (anon 404, share token / session-token query 200)", async () => {
    const anon = await app.request(`/playlists/${privateId}/artwork`, {}, env);
    expect(anon.status).toBe(404);
    const withShare = await app.request(`/playlists/${privateId}/artwork?token=${shareToken}`, {}, env);
    expect(withShare.status).toBe(200);
    const withSession = await app.request(`/playlists/${privateId}/artwork?token=${ownerToken}`, {}, env);
    expect(withSession.status).toBe(200);
  });

  it("4. revocation: private stream route serves nobody anonymously (no token -> 404), but a session token works", async () => {
    const anon = await app.request(`/tracks/${privateTrackId}/stream`, {}, env);
    expect(anon.status).toBe(404);
    const withSession = await app.request(
      `/tracks/${privateTrackId}/stream?token=${ownerToken}`,
      { headers: { Range: "bytes=2-5" } },
      env
    );
    expect(withSession.status).toBe(206);
    expect(await withSession.text()).toBe("2345");
    const withShare = await app.request(`/tracks/${privateTrackId}/stream?token=${shareToken}`, {}, env);
    expect(withShare.status).toBe(200);
  });

  it("5. anonymous POST /comments on a private playlist's track -> 404; with share token -> 201", async () => {
    const anon = await app.request(
      `/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: privateTrackId, authorName: "anon", body: "sneaky" }),
      },
      env
    );
    expect(anon.status).toBe(404);

    const withShare = await app.request(
      `/comments?token=${shareToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: privateTrackId, authorName: "invitee", body: "sounds great" }),
      },
      env
    );
    expect(withShare.status).toBe(201);
  });

  it("gates comment reads (anon 404, share token 200)", async () => {
    const anonTrack = await app.request(`/comments/track/${privateTrackId}`, {}, env);
    expect(anonTrack.status).toBe(404);
    const withShareTrack = await app.request(`/comments/track/${privateTrackId}?token=${shareToken}`, {}, env);
    expect(withShareTrack.status).toBe(200);

    const anonPlaylist = await app.request(`/comments/playlist/${privateId}`, {}, env);
    expect(anonPlaylist.status).toBe(404);
    const withSharePlaylist = await app.request(`/comments/playlist/${privateId}?token=${shareToken}`, {}, env);
    expect(withSharePlaylist.status).toBe(200);
  });
});
