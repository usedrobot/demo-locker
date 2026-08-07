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

describe("createdBy is not exposed to anonymous playlist readers", () => {
  it("is absent from a share-token view of the playlist", async () => {
    const shareToken = "member-createdby-share-token";
    await db.insert(shares).values({
      playlistId: ownerPlaylistId,
      token: shareToken,
      permission: "listen",
    });

    const res = await app.request(`/playlists/${ownerPlaylistId}?token=${shareToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: Record<string, unknown> };
    expect(body.playlist).not.toHaveProperty("createdBy");
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
    const body = (await res.json()) as { playlist: Record<string, unknown> };
    expect(body.playlist).not.toHaveProperty("createdBy");
  });

  // Named for the path it actually exercises. `GET /playlists/:id` strips
  // createdBy for everyone (it admits anonymous share tokens), so this cannot
  // claim to cover "the owner's authenticated read" — POST /playlists is the
  // route that returns it, and this is the guard against over-stripping there.
  it("is still present on the creator's own POST /playlists response", async () => {
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
    const { playlist } = (await res.json()) as { playlist: { createdBy: string | null } };
    expect(playlist.createdBy).toBe(ownerId);
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
