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

// "Names are locker-internal" is a question about MEMBERSHIP, not about having
// a session. Every route that resolves names admits a caller on a share token
// while separately resolving whatever Bearer session the same request carries,
// so a signed-in account from ANOTHER locker who is handed a link arrives with
// a non-null acting user id and is not, by that fact, inside this locker.
//
// The outsider here has their own locker (lockerOwnerId null) and a display
// name they chose themselves — the spoofing shape: nothing stops them setting
// it to a name the band already uses.
describe("a signed-in outsider holding a share link", () => {
  let outsiderId: string;
  const OUTSIDER_EMAIL = "attr-outsider@test.dev";
  const OUTSIDER_TOKEN = "attr-outsider-session";
  const LISTEN_SHARE = "attr-outsider-listen";
  const EDIT_SHARE = "attr-outsider-edit";

  beforeAll(async () => {
    const [outsider] = await db
      .insert(users)
      .values({
        email: OUTSIDER_EMAIL,
        passwordHash: "x",
        displayName: "Jimmy",
      })
      .returning();
    outsiderId = outsider.id;
    await db.insert(sessions).values({
      userId: outsiderId,
      token: OUTSIDER_TOKEN,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await db.insert(shares).values([
      { playlistId, token: LISTEN_SHARE, permission: "listen" },
      { playlistId, token: EDIT_SHARE, permission: "edit" },
    ]);
  });

  it("is served no names on GET /playlists/:id, the route the web client renders", async () => {
    const res = await app.request(
      `/playlists/${playlistId}?token=${LISTEN_SHARE}`,
      { headers: auth(OUTSIDER_TOKEN) },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    expect(body.playlist.createdByName).toBeNull();
    const jimmys = byTitle(body.tracks, "jimmys demo");
    expect(jimmys.uploadedByName).toBeNull();
    // The acting id survives the gate — it answers "is this MINE", which is
    // safe for any caller and is what gates the delete control on an edit link.
    expect(jimmys.uploadedByMe).toBe(false);
  });

  it("is served no names on the invite landing view either", async () => {
    const res = await app.request(
      `/shares/invite/${LISTEN_SHARE}`,
      { headers: auth(OUTSIDER_TOKEN) },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    expect(body.playlist.createdByName).toBeNull();
    expect(byTitle(body.tracks, "jimmys demo").uploadedByName).toBeNull();
  });

  // Uploading through an edit link is the intended feature and is unchanged.
  // The ATTRIBUTION is what was wrong: recording the outsider's id put a name
  // they chose onto the band's rows, permanently and with no remedy — the
  // owner's only removal route matches accounts inside the locker.
  it("uploads through an edit link with no recorded uploader, exactly like an anonymous one", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9, 9, 9])], "outsider.wav"), "outsider.wav");
    form.append("title", "outsider upload");
    form.append("playlistId", playlistId);

    const res = await app.request(
      `/tracks/upload?token=${EDIT_SHARE}`,
      { method: "POST", headers: auth(OUTSIDER_TOKEN), body: form },
      env
    );
    expect(res.status).toBe(201);
    const { track } = (await res.json()) as {
      track: { id: string; uploadedByName: string | null };
    };
    expect(track.uploadedByName).toBeNull();

    const [row] = await db.select().from(tracks).where(eq(tracks.id, track.id));
    expect(row, "the upload did not land").toBeDefined();
    expect(row.ownerId).toBe(ownerId);
    expect(row.uploadedBy).toBeNull();
  });

  // Belt to the braces above: even if a non-member id is already sitting in
  // uploaded_by — written before this was fixed, or by some future path — the
  // resolver refuses to put a name to it, because it only ever resolves
  // accounts inside the locker being read.
  it("has no name resolved for it even when a member reads a row it is already on", async () => {
    const [planted] = await db
      .insert(tracks)
      .values({
        ownerId,
        playlistId,
        title: "planted outsider row",
        position: 9,
        originalKey: "k-planted",
        uploadedBy: outsiderId,
      })
      .returning();
    expect(planted.uploadedBy).toBe(outsiderId);

    const res = await app.request(
      `/playlists/${playlistId}`,
      { headers: auth(ownerToken) },
      env
    );
    const body = (await res.json()) as { tracks: PublicTrack[] };
    expect(byTitle(body.tracks, "planted outsider row").uploadedByName).toBeNull();
    // The member's own rows still resolve — the filter is on the id being
    // named, not a blanket refusal.
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

// Removing a collaborator deletes their account, so uploaded_by / created_by
// go SET NULL and the name that was resolved from the live row vanishes — every
// demo they left behind went blank. DL's ruling: keep the name on the demos.
//
// The name is snapshotted at REMOVAL, not at upload. It is written once, at the
// only moment it is needed; it stays correct while the person is still here and
// renames themselves; and it needs no backfill, because demos uploaded long
// before this column existed are covered too.
describe("a departed collaborator keeps their name on the work they left", () => {
  let departedId: string;
  let departedPlaylistId: string;
  const DEPARTED_EMAIL = "attr-departed@test.dev";
  const DEPARTED_SHARE = "attr-departed-share";

  beforeAll(async () => {
    const [departed] = await db
      .insert(users)
      .values({
        email: DEPARTED_EMAIL,
        passwordHash: "x",
        lockerOwnerId: ownerId,
        displayName: "Departing",
      })
      .returning();
    departedId = departed.id;

    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "departed set", createdBy: departedId })
      .returning();
    departedPlaylistId = pl.id;

    await db.insert(tracks).values({
      ownerId,
      playlistId: departedPlaylistId,
      title: "departed demo",
      position: 1,
      originalKey: "k-departed",
      uploadedBy: departedId,
    });

    await db
      .insert(shares)
      .values({ playlistId: departedPlaylistId, token: DEPARTED_SHARE, permission: "listen" });

    const res = await app.request(
      `/collab/members/${departedId}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    // The account really is gone — otherwise every assertion below would pass
    // on the live-name path and prove nothing about the snapshot.
    const rows = await db.select().from(users).where(eq(users.id, departedId));
    expect(rows).toHaveLength(0);
  });

  it("still names them on a track they uploaded", async () => {
    const res = await app.request("/tracks", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { tracks: rows } = (await res.json()) as { tracks: PublicTrack[] };

    expect(byTitle(rows, "departed demo").uploadedByName).toBe("Departing");
  });

  it("still names them on a playlist they created", async () => {
    const res = await app.request("/playlists", { headers: auth(ownerToken) }, env);
    const { playlists: rows } = (await res.json()) as { playlists: PublicPlaylist[] };

    const pl = rows.find((p) => p.id === departedPlaylistId);
    expect(pl, "the departed member's playlist is missing from the response").toBeDefined();
    expect(pl!.createdByName).toBe("Departing");
  });

  it("leaves a still-present member resolving from their live account", async () => {
    // The snapshot is a tombstone, never a second source of truth: while the
    // account exists the live name wins, so a rename still propagates.
    await db
      .update(users)
      .set({ displayName: "Jim" })
      .where(eq(users.id, collabId));

    const res = await app.request("/tracks", { headers: auth(ownerToken) }, env);
    const { tracks: rows } = (await res.json()) as { tracks: PublicTrack[] };
    expect(byTitle(rows, "jimmys demo").uploadedByName).toBe("Jim");

    await db
      .update(users)
      .set({ displayName: "Jimmy" })
      .where(eq(users.id, collabId));
  });

  it("gives an anonymous share holder no name from the snapshot either", async () => {
    // The new fallback is a NEW path to a name, and the ruling it must not
    // route around is that a reader with no locker session is served none at
    // all — TrackList is shared with the invite page, so a forwarded listen
    // link would otherwise disclose the band's names.
    const res = await app.request(
      `/playlists/${departedPlaylistId}?token=${DEPARTED_SHARE}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    // Pins that this is the row that WOULD have been named: the same request
    // with a locker session gets "Departing" in the test below.
    expect(byTitle(body.tracks, "departed demo").uploadedByName).toBeNull();
    expect(body.playlist.createdByName).toBeNull();
    // Not under any other key either.
    expect(await (await app.request(
      `/playlists/${departedPlaylistId}?token=${DEPARTED_SHARE}`,
      {},
      env
    )).text()).not.toContain("Departing");
  });

  // DL's ruling: the snapshot is display_name ONLY. Everywhere else a nameless
  // account falls back to its email address, but this write cannot be undone —
  // once the account is deleted no route can edit uploaded_by_name — so the
  // fallback would freeze a login address into the locker permanently. A blank
  // row is the lesser harm, and it is rare: an invited collaborator arrives
  // already carrying the label the owner typed.
  it("leaves a blank row, not a frozen email, for a member who never set a name", async () => {
    const NAMELESS_EMAIL = "attr-nameless@test.dev";
    const [nameless] = await db
      .insert(users)
      .values({ email: NAMELESS_EMAIL, passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    expect(nameless.displayName).toBeNull();

    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "nameless set", createdBy: nameless.id })
      .returning();
    await db.insert(tracks).values({
      ownerId,
      playlistId: pl.id,
      title: "nameless demo",
      position: 1,
      originalKey: "k-nameless",
      uploadedBy: nameless.id,
    });

    const res = await app.request(
      `/collab/members/${nameless.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    // The stored snapshot is NULL — not the address, under any key.
    const [trackRow] = await db
      .select()
      .from(tracks)
      .where(eq(tracks.title, "nameless demo"));
    expect(trackRow, "the nameless member's track is gone entirely").toBeDefined();
    expect(trackRow.uploadedBy).toBeNull();
    expect(trackRow.uploadedByName).toBeNull();

    const [playlistRow] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(playlistRow, "the nameless member's playlist is gone entirely").toBeDefined();
    expect(playlistRow.createdByName).toBeNull();

    // and a member reading the locker is shown nothing rather than the address
    const read = await app.request(`/playlists/${pl.id}`, { headers: auth(ownerToken) }, env);
    const raw = await read.text();
    const body = JSON.parse(raw) as { playlist: PublicPlaylist; tracks: PublicTrack[] };
    expect(byTitle(body.tracks, "nameless demo").uploadedByName).toBeNull();
    expect(body.playlist.createdByName).toBeNull();
    expect(raw).not.toContain(NAMELESS_EMAIL);
  });

  // The signed-in half of the same rule. The snapshot comes off the ROW, not
  // out of the resolved-names map, so an outsider gate that only emptied the
  // map would leave this one path still handing over a departed member's name.
  it("gives a signed-in outsider holding the same link no name from the snapshot", async () => {
    const [stranger] = await db
      .insert(users)
      .values({ email: "attr-departed-stranger@test.dev", passwordHash: "x" })
      .returning();
    const strangerToken = "attr-departed-stranger-session";
    await db.insert(sessions).values({
      userId: stranger.id,
      token: strangerToken,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    const res = await app.request(
      `/playlists/${departedPlaylistId}?token=${DEPARTED_SHARE}`,
      { headers: auth(strangerToken) },
      env
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    expect(byTitle(body.tracks, "departed demo").uploadedByName).toBeNull();
    expect(body.playlist.createdByName).toBeNull();
    expect(raw).not.toContain("Departing");
  });

  it("gives a locker session reading that same route the snapshot name", async () => {
    const res = await app.request(
      `/playlists/${departedPlaylistId}`,
      { headers: auth(ownerToken) },
      env
    );
    const body = (await res.json()) as { playlist: PublicPlaylist; tracks: PublicTrack[] };

    expect(byTitle(body.tracks, "departed demo").uploadedByName).toBe("Departing");
    expect(body.playlist.createdByName).toBe("Departing");
  });
});
