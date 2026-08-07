// A collaborator shares the owner's library: same playlists, same tracks, and
// the ability to add to both. What they may NOT do is act on the locker itself
// (publish, share, invite) or destroy something they did not create.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, playlists, sessions } from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;

let ownerId: string;
let collabId: string;
let ownerToken: string;
let collabToken: string;
let strangerToken: string;
let ownerPlaylistId: string;

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-member-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [owner] = await db
    .insert(users)
    .values({ email: "member-owner@test.dev", passwordHash: "x" })
    .returning();
  ownerId = owner.id;
  const [collab] = await db
    .insert(users)
    .values({
      email: "member-collab@test.dev",
      passwordHash: "x",
      lockerOwnerId: owner.id,
    })
    .returning();
  collabId = collab.id;
  const [stranger] = await db
    .insert(users)
    .values({ email: "member-stranger@test.dev", passwordHash: "x" })
    .returning();

  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "member-owner-token";
  collabToken = "member-collab-token";
  strangerToken = "member-stranger-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: collab.id, token: collabToken, expiresAt: future });
  await db.insert(sessions).values({ userId: stranger.id, token: strangerToken, expiresAt: future });

  const [pl] = await db
    .insert(playlists)
    .values({ ownerId: owner.id, name: "owner demos" })
    .returning();
  ownerPlaylistId = pl.id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("playlists under collaboration", () => {
  it("lists the owner's playlists for a collaborator", async () => {
    const res = await app.request("/playlists", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlists: { id: string }[] };
    expect(body.playlists.map((p) => p.id)).toContain(ownerPlaylistId);
  });

  it("does not list them for a stranger", async () => {
    const res = await app.request("/playlists", { headers: auth(strangerToken) }, env);
    const body = (await res.json()) as { playlists: unknown[] };
    expect(body.playlists).toHaveLength(0);
  });

  it("creates a playlist into the owner's locker, attributed to the collaborator", async () => {
    const res = await app.request(
      "/playlists",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "collab demos" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { playlist } = (await res.json()) as {
      playlist: { id: string; ownerId: string; createdBy: string };
    };
    expect(playlist.ownerId).toBe(ownerId);
    expect(playlist.createdBy).toBe(collabId);
  });

  it("lets a collaborator rename the owner's playlist", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed by collab" }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { playlist } = (await res.json()) as { playlist: { name: string } };
    expect(playlist.name).toBe("renamed by collab");
  });

  it("a collaborator's isPublic:true is ignored, not rejected — playlist stays private", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab publish attempt" })
      .returning();
    const res = await app.request(
      `/playlists/${pl.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.isPublic).toBe(false);
  });

  it("a collaborator's isPublic:false is ignored, not rejected — an already-public playlist stays public", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab unpublish attempt", isPublic: true })
      .returning();
    const res = await app.request(
      `/playlists/${pl.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: false }),
      },
      env
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.isPublic).toBe(true);
  });

  it("lets a collaborator rename while a stale isPublic value rides along in the same request", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab rename with stale isPublic" })
      .returning();
    const res = await app.request(
      `/playlists/${pl.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed despite stale isPublic", isPublic: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { playlist } = (await res.json()) as { playlist: { name: string; isPublic: boolean } };
    expect(playlist.name).toBe("renamed despite stale isPublic");
    expect(playlist.isPublic).toBe(false);
  });

  it("lets the owner publish a playlist", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "owner publish target" })
      .returning();
    const res = await app.request(
      `/playlists/${pl.id}`,
      {
        method: "PATCH",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { playlist } = (await res.json()) as { playlist: { isPublic: boolean } };
    expect(playlist.isPublic).toBe(true);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.isPublic).toBe(true);
  });

  it("404s a stranger patching the playlist", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      {
        method: "PATCH",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hijacked" }),
      },
      env
    );
    expect(res.status).toBe(404);
  });
});
