// Whose demo is this?
//
// The permissions half of collaboration (Tasks 1-11) records who uploaded what
// and gates deletes on it, but every response reduced that to a boolean —
// "mine / not mine" — which with two songwriters in one locker can never say
// WHICH of them a demo came from. These are the display half: a name on the
// row, resolved server-side, with the raw user id still nowhere on the wire.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import {
  users,
  sessions,
  tracks,
  playlists,
  shares,
  collaboratorInvites,
} from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;

let ownerId: string;
let collabId: string;
let ownerToken: string;
let collabToken: string;
let playlistId: string;

// Named so an accidental leak of the raw column is unmistakable in a payload.
const OWNER_EMAIL = "attr-owner@test.dev";
const COLLAB_EMAIL = "attr-collab@test.dev";

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-attr-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  // The owner has no invite and therefore no label: they fall back to email.
  const [owner] = await db
    .insert(users)
    .values({ email: OWNER_EMAIL, passwordHash: "x" })
    .returning();
  ownerId = owner.id;

  // The collaborator redeemed an invite the owner labelled "Jimmy".
  const [collab] = await db
    .insert(users)
    .values({
      email: COLLAB_EMAIL,
      passwordHash: "x",
      lockerOwnerId: owner.id,
      displayName: "Jimmy",
    })
    .returning();
  collabId = collab.id;

  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "attr-owner-token";
  collabToken = "attr-collab-token";
  await db.insert(sessions).values({ userId: ownerId, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: collabId, token: collabToken, expiresAt: future });

  const [pl] = await db
    .insert(playlists)
    .values({ ownerId, name: "attr demos", createdBy: collabId })
    .returning();
  playlistId = pl.id;

  await db.insert(tracks).values([
    {
      ownerId,
      playlistId,
      title: "jimmys demo",
      position: 1,
      originalKey: "k1",
      uploadedBy: collabId,
    },
    {
      ownerId,
      playlistId,
      title: "owners demo",
      position: 2,
      originalKey: "k2",
      uploadedBy: ownerId,
    },
    // Predates the column, or its uploader has since been removed (the FK is
    // ON DELETE SET NULL). No attribution to show.
    { ownerId, playlistId, title: "orphan demo", position: 3, originalKey: "k3" },
  ]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

type PublicTrack = { title: string; uploadedByMe: boolean; uploadedByName: string | null };
type PublicPlaylist = { id: string; createdByMe: boolean; createdByName: string | null };

const byTitle = (rows: PublicTrack[], title: string) => {
  const row = rows.find((t) => t.title === title);
  // Pin the row's presence: a missing row must fail here rather than let a
  // "renders no name" assertion pass on an empty list.
  expect(row, `no track titled ${title} in the response`).toBeDefined();
  return row!;
};

describe("GET /tracks attribution", () => {
  it("names the collaborator who uploaded a track, from their display name", async () => {
    const res = await app.request("/tracks", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { tracks: rows } = (await res.json()) as { tracks: PublicTrack[] };

    const jimmys = byTitle(rows, "jimmys demo");
    expect(jimmys.uploadedByName).toBe("Jimmy");
    expect(jimmys.uploadedByMe).toBe(false);
  });

  it("falls back to the email for the owner, who has no invite label", async () => {
    const res = await app.request("/tracks", { headers: auth(collabToken) }, env);
    const { tracks: rows } = (await res.json()) as { tracks: PublicTrack[] };

    const owners = byTitle(rows, "owners demo");
    expect(owners.uploadedByName).toBe(OWNER_EMAIL);
  });

  it("names the caller's own uploads too — the UI decides to say \"you\"", async () => {
    const res = await app.request("/tracks", { headers: auth(collabToken) }, env);
    const { tracks: rows } = (await res.json()) as { tracks: PublicTrack[] };

    const jimmys = byTitle(rows, "jimmys demo");
    expect(jimmys.uploadedByMe).toBe(true);
    expect(jimmys.uploadedByName).toBe("Jimmy");
  });

  it("serves null — never a placeholder — when no uploader is recorded", async () => {
    const res = await app.request("/tracks", { headers: auth(ownerToken) }, env);
    const { tracks: rows } = (await res.json()) as { tracks: PublicTrack[] };

    const orphan = byTitle(rows, "orphan demo");
    expect(orphan.uploadedByName).toBeNull();
  });

  // The branch's most-repeated lesson: a name is not an id, and adding one must
  // not smuggle the other along. Asserted on the raw payload the way
  // membership.test.ts does.
  //
  // `ownerId` is deliberately NOT asserted on: tracks and playlists have
  // carried the locker owner's id since long before this branch, and
  // lib/public-playlist.ts records that it is being left for one sweep rather
  // than fixed piecemeal. What must never appear is the UPLOADER's id, which is
  // the one a locker full of collaborators would otherwise harvest off each
  // other's rows.
  it("still serializes no raw uploader id anywhere in the payload", async () => {
    const res = await app.request("/tracks", { headers: auth(collabToken) }, env);
    const body = await res.text();
    expect(body).toContain("jimmys demo");
    expect(body).toContain("Jimmy");
    expect(body).not.toContain(collabId);
    expect(body).not.toContain('"uploadedBy"');
  });
});

describe("GET /playlists attribution", () => {
  it("names the collaborator who created a playlist", async () => {
    const res = await app.request("/playlists", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { playlists: rows } = (await res.json()) as { playlists: PublicPlaylist[] };

    const pl = rows.find((p) => p.id === playlistId);
    expect(pl, "the seeded playlist is missing from the response").toBeDefined();
    expect(pl!.createdByName).toBe("Jimmy");
    expect(pl!.createdByMe).toBe(false);
  });

  it("serves null when no creator is recorded", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "unattributed" })
      .returning();

    const res = await app.request("/playlists", { headers: auth(ownerToken) }, env);
    const { playlists: rows } = (await res.json()) as { playlists: PublicPlaylist[] };

    const row = rows.find((p) => p.id === pl.id);
    expect(row, "the unattributed playlist is missing from the response").toBeDefined();
    expect(row!.createdByName).toBeNull();
  });

  it("serializes no raw user id", async () => {
    const res = await app.request("/playlists", { headers: auth(ownerToken) }, env);
    const body = await res.text();
    expect(body).toContain("attr demos");
    expect(body).not.toContain(collabId);
    expect(body).not.toContain("createdBy\"");
  });
});

// A share link is handed to people OUTSIDE the locker. The invite label is a
// band member's name and there is no reason a listener needs it, so a reader
// with no locker session gets null — the same shape, no disclosure.
describe("attribution and anonymous share holders", () => {
  it("gives an anonymous share holder no names at all", async () => {
    const shareToken = "attr-share-token";
    await db
      .insert(shares)
      .values({ playlistId, token: shareToken, permission: "listen" });

    const res = await app.request(`/playlists/${playlistId}?token=${shareToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    expect(body.playlist.createdByName).toBeNull();
    const jimmys = byTitle(body.tracks, "jimmys demo");
    expect(jimmys.uploadedByName).toBeNull();
  });

  it("gives a locker session reading the same route the names", async () => {
    const res = await app.request(
      `/playlists/${playlistId}`,
      { headers: auth(ownerToken) },
      env
    );
    const body = (await res.json()) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    expect(body.playlist.createdByName).toBe("Jimmy");
    expect(byTitle(body.tracks, "jimmys demo").uploadedByName).toBe("Jimmy");
  });
});

describe("GET /collab/members", () => {
  it("returns the display name alongside the email", async () => {
    const res = await app.request("/collab/members", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as {
      members: { id: string; email: string; displayName: string | null }[];
    };

    const jimmy = members.find((m) => m.email === COLLAB_EMAIL);
    expect(jimmy, "the collaborator is missing from the members list").toBeDefined();
    expect(jimmy!.displayName).toBe("Jimmy");
  });
});

// The label the owner typed is the name everyone else reads, so it has to be
// copied onto the account at the moment the invite is claimed. A join through
// collaboratorInvites.acceptedBy would not survive: DELETE /collab/invites/:id
// is not restricted to pending invites.
describe("POST /auth/signup with an invite", () => {
  it("copies the invite label into the new account's display name", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "attr-invite-token", label: "Nina" });

    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nina@test.dev",
          password: "correct horse",
          inviteToken: "attr-invite-token",
        }),
      },
      env
    );
    expect(res.status).toBe(201);

    const [nina] = await db.select().from(users).where(eq(users.email, "nina@test.dev"));
    expect(nina.displayName).toBe("Nina");
  });
});
