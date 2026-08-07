// The owner's side of collaboration: mint an invite, see who is pending and
// who has joined, and remove either. Redemption lives in auth.test coverage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, sessions, tracks, collaboratorInvites, playlists, shares } from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;
let ownerId: string;
let ownerToken: string;
let collabToken: string;

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-collab-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [owner] = await db
    .insert(users)
    .values({ email: "collab-owner@test.dev", passwordHash: "x" })
    .returning();
  ownerId = owner.id;
  const [collab] = await db
    .insert(users)
    .values({ email: "collab-member@test.dev", passwordHash: "x", lockerOwnerId: owner.id })
    .returning();

  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "collab-owner-token";
  collabToken = "collab-member-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: collab.id, token: collabToken, expiresAt: future });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("POST /collab/invites", () => {
  it("mints a labelled invite for the owner", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Jimmy" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { invite } = (await res.json()) as { invite: { label: string; token: string } };
    expect(invite.label).toBe("Jimmy");
    expect(invite.token).toMatch(/^[a-f0-9]{32}$/);
  });

  it("requires a label", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("refuses a collaborator inviting further collaborators", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "chain" }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("401s with no session", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "anon" }),
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it("enforces MAX_COLLABORATORS across members and pending invites", async () => {
    const capped = { ...env, MAX_COLLABORATORS: "1" };
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "one too many" }),
      },
      capped
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /collab/invites", () => {
  it("lists the owner's invites", async () => {
    const res = await app.request("/collab/invites", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { invites } = (await res.json()) as { invites: { label: string }[] };
    expect(invites.map((i) => i.label)).toContain("Jimmy");
  });

  it("404s for a collaborator", async () => {
    const res = await app.request("/collab/invites", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(404);
  });
});

describe("GET /collab/members", () => {
  it("lists the locker's collaborators without password hashes", async () => {
    const res = await app.request("/collab/members", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as { members: Record<string, unknown>[] };
    expect(members.map((m) => m.email)).toContain("collab-member@test.dev");
    expect(members[0]).not.toHaveProperty("passwordHash");
  });
});

describe("DELETE /collab/members/:id", () => {
  it("removes the collaborator but keeps their uploads in the library", async () => {
    const [gone] = await db
      .insert(users)
      .values({ email: "leaving@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "left behind",
        position: 0,
        originalKey: "lib/left-behind",
        uploadedBy: gone.id,
      })
      .returning();

    const res = await app.request(
      `/collab/members/${gone.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    const [user] = await db.select().from(users).where(eq(users.id, gone.id));
    expect(user).toBeUndefined();

    const [track] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(track).toBeDefined();
    expect(track.uploadedBy).toBeNull();
    expect(track.ownerId).toBe(ownerId);
  });

  it("404s removing a user who is not in this locker", async () => {
    const [outsider] = await db
      .insert(users)
      .values({ email: "outsider@test.dev", passwordHash: "x" })
      .returning();

    const res = await app.request(
      `/collab/members/${outsider.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(404);

    const [still] = await db.select().from(users).where(eq(users.id, outsider.id));
    expect(still).toBeDefined();
  });

  it("404s for a collaborator trying to remove a peer", async () => {
    const [peer] = await db
      .insert(users)
      .values({ email: "peer@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();

    const res = await app.request(
      `/collab/members/${peer.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(404);

    const [still] = await db.select().from(users).where(eq(users.id, peer.id));
    expect(still).toBeDefined();
    await db.delete(users).where(eq(users.id, peer.id));
  });
});

describe("DELETE /collab/invites/:id", () => {
  it("revokes a pending invite", async () => {
    const [inv] = await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "revoke-me-token", label: "nope" })
      .returning();

    const res = await app.request(
      `/collab/invites/${inv.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    const [gone] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.id, inv.id));
    expect(gone).toBeUndefined();
  });
});

// A share link outlives the person who minted it — nothing sets expiresAt —
// and a listen link can pull the lossless master. So removing a collaborator
// must take every link they minted with them, edit and listen alike. The
// database enforces it: shares.created_by is ON DELETE CASCADE.
describe("removing a collaborator kills the links they minted", () => {
  it("deletes their edit and listen links while leaving the owner's alone", async () => {
    const [minter] = await db
      .insert(users)
      .values({ email: "minter@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const minterToken = "collab-minter-token";
    await db.insert(sessions).values({
      userId: minter.id,
      token: minterToken,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    const [playlist] = await db
      .insert(playlists)
      .values({ ownerId, name: "cascade fixture" })
      .returning();

    const mint = async (token: string, permission: string) => {
      const res = await app.request(
        "/shares",
        {
          method: "POST",
          headers: { ...auth(token), "Content-Type": "application/json" },
          body: JSON.stringify({ playlistId: playlist.id, permission }),
        },
        env
      );
      expect(res.status).toBe(201);
      const { share } = (await res.json()) as { share: { id: string; token: string } };
      return share;
    };

    const collabEdit = await mint(minterToken, "edit");
    const collabListen = await mint(minterToken, "listen");
    const ownerListen = await mint(ownerToken, "listen");

    // Sanity: the links work before the removal.
    const before = await app.request(`/shares/invite/${collabEdit.token}`, {}, env);
    expect(before.status).toBe(200);

    const res = await app.request(
      `/collab/members/${minter.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    for (const share of [collabEdit, collabListen]) {
      const [row] = await db.select().from(shares).where(eq(shares.id, share.id));
      expect(row).toBeUndefined();
      const presented = await app.request(`/shares/invite/${share.token}`, {}, env);
      expect(presented.status).toBe(404);
    }

    const [survivor] = await db.select().from(shares).where(eq(shares.id, ownerListen.id));
    expect(survivor).toBeDefined();
    expect(survivor.createdBy).toBe(ownerId);
    const stillWorks = await app.request(`/shares/invite/${ownerListen.token}`, {}, env);
    expect(stillWorks.status).toBe(200);
  });
});
