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
let publicWithArtworkId: string;

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

  await bucket.put("k-art", Buffer.from("fake-png-bytes"), {
    httpMetadata: { contentType: "image/png" },
  });
  const [pubArt] = await db
    .insert(playlists)
    .values({ ownerId: user.id, name: "public with art", isPublic: true, artworkKey: "k-art" })
    .returning();
  publicWithArtworkId = pubArt.id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("public API boundary", () => {
  it("returns metadata for a public playlist with only the public fields", async () => {
    const res = await app.request(`/public/v1/playlists/${publicId}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playlist: { name: string; tracks: Array<{ id: string; title: string; duration: number }> };
    };
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

  it("404s artwork for a private playlist identically to the standard not-found body", async () => {
    const res = await app.request(`/public/v1/playlists/${privateId}/artwork`, {}, env);
    const missing = await app.request(
      `/public/v1/playlists/00000000-0000-0000-0000-000000000000/artwork`,
      {},
      env
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await missing.text());
  });

  it("serves artwork for a public playlist with the correct content type", async () => {
    const res = await app.request(`/public/v1/playlists/${publicWithArtworkId}/artwork`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("fake-png-bytes");
  });
});
