// A collaborator shares the owner's library: same playlists, same tracks, the
// ability to add to both, and — sharing being band work, not administration —
// minting and managing share links too. What they may NOT do is act on the
// locker itself (publish, invite) or destroy something they did not create.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, playlists, sessions, tracks, shares } from "../db/schema.js";

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
      playlist: Record<string, unknown> & { ownerId: string; createdByMe: boolean };
    };
    expect(playlist.ownerId).toBe(ownerId);
    // Attribution reaches the creator as a bit, never as their raw id.
    expect(playlist.createdByMe).toBe(true);
    expect(playlist).not.toHaveProperty("createdBy");
    // The row really did record them, even though the response does not say so.
    const [row] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.id, playlist.id as string));
    expect(row.createdBy).toBe(collabId);
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

  it("refuses a collaborator's attempt to publish a private playlist", async () => {
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
    // 403, not 404: this caller can already read the playlist, so hiding its
    // existence would only mislead them into thinking it was deleted.
    expect(res.status).toBe(403);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.isPublic).toBe(false);
  });

  it("refuses a collaborator's attempt to un-publish a public playlist — it must not fail open and stay live", async () => {
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
    expect(res.status).toBe(403);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.isPublic).toBe(true);
  });

  it("refuses a collaborator's publish attempt as a whole — a rename in the same body is not partially applied", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab combined attempt" })
      .returning();
    const res = await app.request(
      `/playlists/${pl.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed and published", isPublic: true }),
      },
      env
    );
    expect(res.status).toBe(403);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(row.name).toBe("collab combined attempt");
    expect(row.isPublic).toBe(false);
  });

  it("lets a collaborator rename while echoing the current (private) isPublic value — a no-op is not a change", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab rename with echoed isPublic" })
      .returning();
    const res = await app.request(
      `/playlists/${pl.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed despite echoed isPublic", isPublic: false }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { playlist } = (await res.json()) as { playlist: { name: string; isPublic: boolean } };
    expect(playlist.name).toBe("renamed despite echoed isPublic");
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

describe("the shared playlist-access gates resolve the locker", () => {
  it("lets a collaborator open the owner's playlist", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      { headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: { id: string } };
    expect(body.playlist.id).toBe(ownerPlaylistId);
  });

  it("still 404s a stranger opening it", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      { headers: auth(strangerToken) },
      env
    );
    expect(res.status).toBe(404);
  });

  it("lets a collaborator reorder the owner's playlist", async () => {
    const [a] = await db
      .insert(tracks)
      .values({
        ownerId,
        playlistId: ownerPlaylistId,
        title: "first",
        position: 0,
        originalKey: "lib/reorder-a",
        uploadedBy: ownerId,
      })
      .returning();
    const [b] = await db
      .insert(tracks)
      .values({
        ownerId,
        playlistId: ownerPlaylistId,
        title: "second",
        position: 1,
        originalKey: "lib/reorder-b",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/playlists/${ownerPlaylistId}/reorder`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: [b.id, a.id] }),
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it("still refuses a stranger reordering it", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}/reorder`,
      {
        method: "PATCH",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: [] }),
      },
      env
    );
    expect(res.status).toBe(404);
  });
});

describe("tracks under collaboration", () => {
  it("shows the owner's library to a collaborator", async () => {
    await db.insert(tracks).values({
      ownerId,
      title: "owner riff",
      position: 0,
      originalKey: "lib/owner-riff",
      uploadedBy: ownerId,
    });

    const res = await app.request("/tracks", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracks: { title: string }[] };
    expect(body.tracks.map((t) => t.title)).toContain("owner riff");
  });

  it("hides it from a stranger", async () => {
    const res = await app.request("/tracks", { headers: auth(strangerToken) }, env);
    const body = (await res.json()) as { tracks: unknown[] };
    expect(body.tracks).toHaveLength(0);
  });

  it("lets a collaborator move an owner's track between playlists", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "movable",
        position: 0,
        originalKey: "lib/movable",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId }),
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it("404s a stranger moving the same track", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "not yours",
        position: 0,
        originalKey: "lib/not-yours",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      {
        method: "PATCH",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: null }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("attributes a collaborator's upload to them, in the owner's locker", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "demo.wav"), "demo.wav");
    form.append("title", "collab upload");

    const res = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(collabToken), body: form },
      env
    );
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(tracks)
      .where(eq(tracks.title, "collab upload"));
    expect(row.ownerId).toBe(ownerId);
    expect(row.uploadedBy).toBe(collabId);
  });

  it("lets a collaborator stream and download their own library upload", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9, 9, 9])], "collab-own.wav"), "collab-own.wav");
    form.append("title", "collab stream own");

    const uploadRes = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(collabToken), body: form },
      env
    );
    expect(uploadRes.status).toBe(201);
    const { track } = (await uploadRes.json()) as { track: { id: string } };

    const streamRes = await app.request(
      `/tracks/${track.id}/stream`,
      { headers: auth(collabToken) },
      env
    );
    expect(streamRes.status).toBe(200);

    const downloadRes = await app.request(
      `/tracks/${track.id}/download`,
      { headers: auth(collabToken) },
      env
    );
    expect(downloadRes.status).toBe(200);
  });

  it("lets a collaborator stream and download an owner's library upload", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([4, 4, 4])], "owner-own.wav"), "owner-own.wav");
    form.append("title", "owner stream target");

    const uploadRes = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(ownerToken), body: form },
      env
    );
    expect(uploadRes.status).toBe(201);
    const { track } = (await uploadRes.json()) as { track: { id: string } };

    const streamRes = await app.request(
      `/tracks/${track.id}/stream`,
      { headers: auth(collabToken) },
      env
    );
    expect(streamRes.status).toBe(200);

    const downloadRes = await app.request(
      `/tracks/${track.id}/download`,
      { headers: auth(collabToken) },
      env
    );
    expect(downloadRes.status).toBe(200);
  });

  it("still 404s a stranger streaming or downloading a library track", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([5, 5, 5])], "stranger-blocked.wav"), "stranger-blocked.wav");
    form.append("title", "stranger blocked target");

    const uploadRes = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(ownerToken), body: form },
      env
    );
    expect(uploadRes.status).toBe(201);
    const { track } = (await uploadRes.json()) as { track: { id: string } };

    const streamRes = await app.request(
      `/tracks/${track.id}/stream`,
      { headers: auth(strangerToken) },
      env
    );
    expect(streamRes.status).toBe(404);

    const downloadRes = await app.request(
      `/tracks/${track.id}/download`,
      { headers: auth(strangerToken) },
      env
    );
    expect(downloadRes.status).toBe(404);
  });
});

// The raw `uploadedBy` user id is never serialized to anyone. `uploadedByMe`
// carries the one bit a client can use — did I upload this — without telling
// collaborator A anything about collaborator B's internal id. It is
// attribution, not delete authority: see the note in lib/public-track.ts.
describe("uploadedByMe replaces the raw uploadedBy id", () => {
  // A second collaborator on the same locker, created here rather than in the
  // shared fixture: only these tests need two distinct uploaders.
  let collab2Id: string;
  const collab2Token = "member-collab2-token";
  let ownUploadId: string;
  let otherUploadId: string;

  beforeAll(async () => {
    const [collab2] = await db
      .insert(users)
      .values({
        email: "member-collab2@test.dev",
        passwordHash: "x",
        lockerOwnerId: ownerId,
      })
      .returning();
    collab2Id = collab2.id;
    await db.insert(sessions).values({
      userId: collab2.id,
      token: collab2Token,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    const upload = async (token: string, title: string, playlistId?: string) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array([7, 7, 7])], `${title}.wav`), `${title}.wav`);
      form.append("title", title);
      if (playlistId) form.append("playlistId", playlistId);
      const res = await app.request(
        "/tracks/upload",
        { method: "POST", headers: auth(token), body: form },
        env
      );
      expect(res.status).toBe(201);
      const { track } = (await res.json()) as { track: { id: string } };
      return track.id;
    };

    ownUploadId = await upload(collabToken, "collab one upload");
    otherUploadId = await upload(collab2Token, "collab two upload");
  });

  it("is true on a collaborator's own upload and false on another's, with no raw id", async () => {
    const res = await app.request("/tracks", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tracks: (Record<string, unknown> & { id: string })[];
    };

    expect(body.tracks.find((t) => t.id === ownUploadId)?.uploadedByMe).toBe(true);
    expect(body.tracks.find((t) => t.id === otherUploadId)?.uploadedByMe).toBe(false);
    expect(body.tracks.length).toBeGreaterThan(0);
    for (const t of body.tracks) {
      expect(t).not.toHaveProperty("uploadedBy");
    }
  });

  it("is false for the owner on a collaborator's upload, with no raw id", async () => {
    const res = await app.request("/tracks", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tracks: (Record<string, unknown> & { id: string })[];
    };
    const row = body.tracks.find((t) => t.id === ownUploadId);
    expect(row?.uploadedByMe).toBe(false);
    expect(row).not.toHaveProperty("uploadedBy");
    // and collab2's id is nowhere in the payload at all
    expect(JSON.stringify(body)).not.toContain(collab2Id);
  });

  it("is true on the uploader's own 201 response", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([8, 8, 8])], "own-201.wav"), "own-201.wav");
    form.append("title", "own 201 upload");
    const res = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(collabToken), body: form },
      env
    );
    expect(res.status).toBe(201);
    const { track } = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(track.uploadedByMe).toBe(true);
    expect(track).not.toHaveProperty("uploadedBy");
  });

  it("is false for an anonymous share holder, with no raw id", async () => {
    const shareToken = "member-listen-share-token";
    await db.insert(shares).values({
      playlistId: ownerPlaylistId,
      token: shareToken,
      permission: "listen",
    });

    const form = new FormData();
    form.append("file", new File([new Uint8Array([2, 2, 2])], "share-visible.wav"), "share-visible.wav");
    form.append("title", "share visible track");
    form.append("playlistId", ownerPlaylistId);
    const uploadRes = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(ownerToken), body: form },
      env
    );
    expect(uploadRes.status).toBe(201);

    const res = await app.request(`/playlists/${ownerPlaylistId}?token=${shareToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracks: Record<string, unknown>[] };
    expect(body.tracks.length).toBeGreaterThan(0);
    for (const t of body.tracks) {
      expect(t).not.toHaveProperty("uploadedBy");
      expect(t.uploadedByMe).toBe(false);
    }
  });

  // The case the two-serializer split made impossible: GET /playlists/:id is
  // reachable by BOTH an anonymous share holder and a locker session, so it had
  // to use the stripping serializer and an authenticated collaborator got no
  // attribution at all. Task 11's per-track delete control depends on this.
  it("reaches a collaborator opening GET /playlists/:id", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9, 9, 9])], "in-playlist.wav"), "in-playlist.wav");
    form.append("title", "collab track in playlist");
    form.append("playlistId", ownerPlaylistId);
    const uploadRes = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(collabToken), body: form },
      env
    );
    expect(uploadRes.status).toBe(201);
    const { track: uploaded } = (await uploadRes.json()) as { track: { id: string } };

    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      { headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tracks: (Record<string, unknown> & { id: string })[];
    };
    const mine = body.tracks.find((t) => t.id === uploaded.id);
    expect(mine?.uploadedByMe).toBe(true);
    for (const t of body.tracks) {
      expect(t).not.toHaveProperty("uploadedBy");
    }

    // ...and the owner reading the same playlist sees it as not theirs.
    const ownerRes = await app.request(
      `/playlists/${ownerPlaylistId}`,
      { headers: auth(ownerToken) },
      env
    );
    const ownerBody = (await ownerRes.json()) as {
      tracks: (Record<string, unknown> & { id: string })[];
    };
    expect(ownerBody.tracks.find((t) => t.id === uploaded.id)?.uploadedByMe).toBe(false);
  });
});

describe("createdBy is not exposed to any reader", () => {
  // A second collaborator on the same locker, created here rather than in the
  // shared fixture (the same pattern the uploadedByMe block uses): only the
  // GET /playlists test needs two distinct creators, and their id is the thing
  // the strip is protecting.
  let otherCollabId: string;

  beforeAll(async () => {
    const [otherCollab] = await db
      .insert(users)
      .values({
        email: "member-createdby-collab2@test.dev",
        passwordHash: "x",
        lockerOwnerId: ownerId,
      })
      .returning();
    otherCollabId = otherCollab.id;
  });

  it("is absent from a share-token view of the playlist", async () => {
    const shareToken = "member-createdby-share-token";
    // This fixture predates the column, so its createdBy is null — which makes
    // this also the null-vs-null case: an anonymous reader has no id, and must
    // still get false rather than matching a null creator.
    const [fixture] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.id, ownerPlaylistId));
    expect(fixture.createdBy).toBeNull();
    await db.insert(shares).values({
      playlistId: ownerPlaylistId,
      token: shareToken,
      permission: "listen",
    });

    const res = await app.request(`/playlists/${ownerPlaylistId}?token=${shareToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playlist: Record<string, unknown> & { createdByMe: boolean };
    };
    expect(body.playlist).not.toHaveProperty("createdBy");
    expect(body.playlist.createdByMe).toBe(false);
  });

  it("is absent from the invite view of the playlist", async () => {
    const inviteToken = "member-createdby-invite-token";
    await db.insert(shares).values({
      playlistId: ownerPlaylistId,
      token: inviteToken,
      permission: "listen",
    });

    const res = await app.request(`/shares/invite/${inviteToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playlist: Record<string, unknown> & { createdByMe: boolean };
    };
    expect(body.playlist).not.toHaveProperty("createdBy");
    expect(body.playlist.createdByMe).toBe(false);
  });

  // Every route now strips it, including the creator's own POST response: the
  // raw id was useless to the client that received it, and serializing it on
  // the locker-scoped reads let one collaborator harvest another's user id off
  // GET /playlists. createdByMe carries the only bit anyone needed. This test
  // is the guard against under-stripping on the route that used to return it.
  it("is absent from the creator's own POST /playlists response, replaced by createdByMe", async () => {
    const res = await app.request(
      "/playlists",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "createdBy sanity check" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { playlist } = (await res.json()) as {
      playlist: Record<string, unknown> & { createdByMe: boolean };
    };
    expect(playlist).not.toHaveProperty("createdBy");
    expect(playlist.createdByMe).toBe(true);
  });

  // The leak this closes: GET /playlists is a locker-scoped read, so it is the
  // one route where collaborator A is guaranteed to see rows collaborator B
  // created. It returned raw rows, which shipped B's internal user UUID to A —
  // the exact disclosure uploadedBy is stripped everywhere to prevent.
  it("is absent from GET /playlists, which answers createdByMe per row instead", async () => {
    const [mine] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab's list row", createdBy: collabId })
      .returning();
    const [theirs] = await db
      .insert(playlists)
      .values({ ownerId, name: "other collab's list row", createdBy: otherCollabId })
      .returning();

    const res = await app.request("/playlists", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playlists: (Record<string, unknown> & { id: string; createdByMe: boolean })[];
    };

    expect(body.playlists.find((p) => p.id === mine.id)?.createdByMe).toBe(true);
    expect(body.playlists.find((p) => p.id === theirs.id)?.createdByMe).toBe(false);

    // Not one row, and not one field: no raw creator id anywhere in the
    // response, including the other collaborator's, whose id is the thing
    // being protected.
    for (const p of body.playlists) expect(p).not.toHaveProperty("createdBy");
    expect(JSON.stringify(body)).not.toContain(otherCollabId);
    expect(JSON.stringify(body)).not.toContain(collabId);
  });

});

describe("comments on a library track under collaboration", () => {
  it("lets a collaborator read and post a comment on a library track", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "library comment target",
        position: 0,
        originalKey: "lib/comment-target",
        uploadedBy: ownerId,
      })
      .returning();

    const getRes = await app.request(
      `/comments/track/${tr.id}`,
      { headers: auth(collabToken) },
      env
    );
    expect(getRes.status).toBe(200);

    const postRes = await app.request(
      "/comments",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({
          trackId: tr.id,
          authorName: "Collab",
          body: "sounds great",
        }),
      },
      env
    );
    expect(postRes.status).toBe(201);
  });

  it("still refuses a stranger reading or posting on the same library track", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "library comment target for stranger",
        position: 0,
        originalKey: "lib/comment-target-stranger",
        uploadedBy: ownerId,
      })
      .returning();

    const getRes = await app.request(
      `/comments/track/${tr.id}`,
      { headers: auth(strangerToken) },
      env
    );
    expect(getRes.status).toBe(404);

    const postRes = await app.request(
      "/comments",
      {
        method: "POST",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({
          trackId: tr.id,
          authorName: "Stranger",
          body: "not yours",
        }),
      },
      env
    );
    expect(postRes.status).toBe(404);
  });
});

describe("sharing under collaboration", () => {
  it("lets a collaborator mint a share link on the owner's playlist", async () => {
    const res = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId, permission: "edit" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { share } = (await res.json()) as { share: { permission: string } };
    expect(share.permission).toBe("edit");
  });

  it("shows the locker's share links to a collaborator", async () => {
    const res = await app.request("/shares", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: { playlistId: string }[] };
    expect(body.shares.length).toBeGreaterThan(0);
    expect(body.shares.every((s) => s.playlistId === ownerPlaylistId)).toBe(true);
  });

  it("still refuses a stranger minting one", async () => {
    const res = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId, permission: "listen" }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("returns no shares to a stranger listing them", async () => {
    const res = await app.request("/shares", { headers: auth(strangerToken) }, env);
    const body = (await res.json()) as { shares: unknown[] };
    expect(body.shares).toHaveLength(0);
  });

  // Attribution on share links, the same computed-boolean shape as
  // uploadedByMe/createdByMe: anyone in the locker may mint a link, so without
  // this the owner cannot tell their own links from a collaborator's — and
  // removing that collaborator silently takes theirs away (created_by
  // cascades). The minter's raw user id is never serialized.
  it("tells each locker member which share links they minted themselves", async () => {
    const [collabShare] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-mintedbyme-collab-token",
        permission: "listen",
        createdBy: collabId,
      })
      .returning();
    const [ownerShare] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-mintedbyme-owner-token",
        permission: "listen",
        createdBy: ownerId,
      })
      .returning();

    type Row = { id: string; mintedByMe: boolean; createdBy?: string };
    const read = async (token: string) => {
      const res = await app.request("/shares", { headers: auth(token) }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { shares: Row[] };
      return new Map(body.shares.map((s) => [s.id, s]));
    };

    const asOwner = await read(ownerToken);
    expect(asOwner.get(ownerShare.id)!.mintedByMe).toBe(true);
    expect(asOwner.get(collabShare.id)!.mintedByMe).toBe(false);

    const asCollab = await read(collabToken);
    expect(asCollab.get(collabShare.id)!.mintedByMe).toBe(true);
    expect(asCollab.get(ownerShare.id)!.mintedByMe).toBe(false);

    // Attribution replaces the id — it must not be served alongside it.
    expect(asOwner.get(collabShare.id)!.createdBy).toBeUndefined();
  });

  it("marks a freshly minted share link as the minter's own", async () => {
    const res = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId, permission: "listen" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { share } = (await res.json()) as { share: { mintedByMe: boolean; createdBy?: string } };
    expect(share.mintedByMe).toBe(true);
    expect(share.createdBy).toBeUndefined();
  });

  // The intended-but-surprising case per the task ruling: share links are
  // locker-level state, not per-creator state, so a collaborator can revoke a
  // link the owner minted.
  it("lets a collaborator revoke a share link the owner created", async () => {
    const [ownerShare] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-owner-created-share-token",
        permission: "listen",
      })
      .returning();

    const res = await app.request(
      `/shares/${ownerShare.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(shares).where(eq(shares.id, ownerShare.id));
    expect(rows).toHaveLength(0);
  });

  it("still refuses a stranger revoking a locker's share link, and leaves it intact", async () => {
    const [ownerShare] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-stranger-revoke-attempt-token",
        permission: "listen",
      })
      .returning();

    const res = await app.request(
      `/shares/${ownerShare.id}`,
      { method: "DELETE", headers: auth(strangerToken) },
      env
    );
    expect(res.status).toBe(404);

    const rows = await db.select().from(shares).where(eq(shares.id, ownerShare.id));
    expect(rows).toHaveLength(1);
  });

  it("lets a collaborator list a playlist's share links via GET /shares/playlist/:playlistId", async () => {
    const [inserted] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-playlist-list-share-token",
        permission: "listen",
      })
      .returning();

    const res = await app.request(
      `/shares/playlist/${ownerPlaylistId}`,
      { headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: { id: string; playlistId: string }[] };
    // Pin the specific row just inserted, not merely "the list is non-empty" —
    // every returned row trivially satisfies playlistId === ownerPlaylistId
    // because the route already filters on it, and the list was non-empty
    // before this insert too (an earlier test in this block minted a share).
    expect(body.shares.map((s) => s.id)).toContain(inserted.id);
  });

  it("404s a stranger listing the same playlist's share links", async () => {
    const res = await app.request(
      `/shares/playlist/${ownerPlaylistId}`,
      { headers: auth(strangerToken) },
      env
    );
    expect(res.status).toBe(404);
  });

  it("lets a collaborator re-permission a share link the owner created", async () => {
    const [ownerShare] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-owner-created-repermission-token",
        permission: "listen",
      })
      .returning();

    const res = await app.request(
      `/shares/${ownerShare.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ permission: "edit" }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { share } = (await res.json()) as { share: { permission: string } };
    expect(share.permission).toBe("edit");

    const [row] = await db.select().from(shares).where(eq(shares.id, ownerShare.id));
    expect(row.permission).toBe("edit");
  });

  it("still refuses a stranger re-permissioning a locker's share link, and leaves it unchanged", async () => {
    const [ownerShare] = await db
      .insert(shares)
      .values({
        playlistId: ownerPlaylistId,
        token: "member-stranger-repermission-attempt-token",
        permission: "listen",
      })
      .returning();

    const res = await app.request(
      `/shares/${ownerShare.id}`,
      {
        method: "PATCH",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ permission: "edit" }),
      },
      env
    );
    expect(res.status).toBe(404);

    const [row] = await db.select().from(shares).where(eq(shares.id, ownerShare.id));
    expect(row.permission).toBe("listen");
  });
});

describe("delete is limited to what you created", () => {
  it("refuses to let a collaborator delete the owner's track, and keeps the file", async () => {
    const bucket = env.DEMOS_BUCKET as { put: Function; get: Function };
    await bucket.put("lib/precious", Buffer.from("MASTER"), {
      httpMetadata: { contentType: "audio/wav" },
    });
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "owner master",
        position: 0,
        originalKey: "lib/precious",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(404);

    const [still] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(still).toBeDefined();
    expect(await bucket.get("lib/precious")).not.toBeNull();
  });

  // A null uploadedBy is the fail-closed case the guard exists for: rows that
  // predate the column, rows whose uploader was removed (ON DELETE SET NULL),
  // and uploads by anonymous edit-share holders. It reads as the owner's, so a
  // collaborator must not be able to destroy it — and the master must survive.
  it("refuses to let a collaborator delete a track with no recorded uploader, and keeps the file", async () => {
    const bucket = env.DEMOS_BUCKET as { put: Function; get: Function };
    await bucket.put("lib/unattributed", Buffer.from("MASTER"), {
      httpMetadata: { contentType: "audio/wav" },
    });
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "unattributed master",
        position: 0,
        originalKey: "lib/unattributed",
      })
      .returning();
    expect(tr.uploadedBy).toBeNull();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(404);

    const [still] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(still).toBeDefined();
    expect(await bucket.get("lib/unattributed")).not.toBeNull();
  });

  it("lets a collaborator delete a track they uploaded themselves", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "collab master",
        position: 0,
        originalKey: "lib/collab-own",
        uploadedBy: collabId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
    const [gone] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(gone).toBeUndefined();
  });

  it("lets the owner delete a collaborator's track", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "collab upload, owner deletes",
        position: 0,
        originalKey: "lib/owner-can",
        uploadedBy: collabId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);
    const [gone] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(gone).toBeUndefined();
  });

  it("still refuses a stranger, without disclosing that the track exists", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "not the stranger's business",
        position: 0,
        originalKey: "lib/stranger-cannot",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(strangerToken) },
      env
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    const [still] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(still).toBeDefined();
  });

  // A dedicated row rather than the shared `ownerPlaylistId` fixture: this test
  // attempts a mutation, and the mutation-check in the brief's Step 5 makes the
  // delete actually land, which would cascade unrelated failures through the
  // file and obscure which guard was being checked.
  it("refuses to let a collaborator delete a playlist they did not create", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "owner's own, no createdBy" })
      .returning();
    expect(pl.createdBy).toBeNull();

    const res = await app.request(
      `/playlists/${pl.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(404);
    const [still] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(still).toBeDefined();
  });

  it("lets a collaborator delete a playlist they created", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab's own", createdBy: collabId })
      .returning();

    const res = await app.request(
      `/playlists/${pl.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
    const [gone] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(gone).toBeUndefined();
  });

  it("lets the owner delete a playlist a collaborator created", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab made, owner deletes", createdBy: collabId })
      .returning();

    const res = await app.request(
      `/playlists/${pl.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);
    const [gone] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(gone).toBeUndefined();
  });
});
