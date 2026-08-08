// Collaboration, both sides: the owner mints an invite, sees who is pending
// and who has joined, and removes either — and the recipient redeems that
// invite at signup, which is the only thing anywhere that writes
// users.locker_owner_id.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { bindToLocker, releaseInvite, rowsAffected } from "../lib/signup.js";
import {
  users,
  sessions,
  tracks,
  collaboratorInvites,
  playlists,
  shares,
  comments,
} from "../db/schema.js";

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

  // comments.resolved_by is the one FK to users with no ON DELETE action and
  // cannot be given one without a full table rebuild, so the handler nulls it
  // by hand or the delete aborts on a foreign-key error. Nothing can write a
  // collaborator's id there today (resolving is owner-only), so this test
  // plants the row directly — it guards a landmine, not a live bug.
  it("survives a comment the departing member had resolved", async () => {
    const [resolver] = await db
      .insert(users)
      .values({ email: "resolver@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const [tr] = await db
      .insert(tracks)
      .values({ ownerId, title: "resolved", position: 0, originalKey: "lib/resolved" })
      .returning();
    const [comment] = await db
      .insert(comments)
      .values({
        trackId: tr.id,
        authorName: "someone",
        body: "fix the snare",
        resolvedAt: new Date(),
        resolvedBy: resolver.id,
      })
      .returning();

    const res = await app.request(
      `/collab/members/${resolver.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
    expect(row.resolvedBy).toBeNull();
    // Still resolved — only the attribution goes.
    expect(row.resolvedAt).not.toBeNull();
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

// MAX_COLLABORATORS used to be both the locker's seat count and the
// per-playlist share-link ceiling, so an operator allowing two bandmates also
// capped every playlist at two links and got a 403 about share links they had
// never configured. MAX_SHARE_LINKS is now the second one. These two tests
// exist to keep them apart.
describe("MAX_COLLABORATORS and MAX_SHARE_LINKS are separate caps", () => {
  const mint = (envOverride: Record<string, unknown>, playlistId: string) =>
    app.request(
      "/shares",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId, permission: "listen" }),
      },
      envOverride
    );

  it("does not cap share links with the seat count", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "seat cap fixture" })
      .returning();
    const capped = { ...env, MAX_COLLABORATORS: "1" };

    expect((await mint(capped, pl.id)).status).toBe(201);
    expect((await mint(capped, pl.id)).status).toBe(201);
  });

  it("caps share links with MAX_SHARE_LINKS", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "link cap fixture" })
      .returning();
    const capped = { ...env, MAX_SHARE_LINKS: "1" };

    expect((await mint(capped, pl.id)).status).toBe(201);
    const second = await mint(capped, pl.id);
    expect(second.status).toBe(403);
    const { error } = (await second.json()) as { error: string };
    expect(error).toContain("share links");
  });
});

// The recipient's side. Redeeming is the only thing in the codebase that
// writes users.locker_owner_id, so without it GET /collab/members is
// permanently empty on a real instance.
//
// Budget note: rateLimit("signup", SIGNUP_RULE) allows 5 requests per hour per
// client, and every request in this file with no CF-Connecting-IP shares the
// "unknown" bucket. This block spends 4 of them. A fifth signup test belongs
// under its own CF-Connecting-IP, or it will 429 instead of asserting.
describe("POST /auth/signup with an invite", () => {
  it("creates a collaborator bound to the inviting owner's locker", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "good-invite-token", label: "Dana" });

    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "dana@test.dev",
          password: "correct horse",
          inviteToken: "good-invite-token",
        }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: { id: string; lockerOwnerId: string } };
    expect(user.lockerOwnerId).toBe(ownerId);

    const [invite] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.token, "good-invite-token"));
    expect(invite.acceptedBy).toBe(user.id);
    expect(invite.acceptedAt).not.toBeNull();
  });

  it("refuses a second redemption of the same invite", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "second@test.dev",
          password: "correct horse",
          inviteToken: "good-invite-token",
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "second@test.dev"));
    expect(none).toBeUndefined();
  });

  it("refuses an unknown invite token rather than falling through to normal signup", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nobody@test.dev",
          password: "correct horse",
          inviteToken: "no-such-token",
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "nobody@test.dev"));
    expect(none).toBeUndefined();
  });

  it("still refuses an ordinary signup on a closed instance", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "walkup@test.dev", password: "correct horse" }),
      },
      env
    );
    expect(res.status).toBe(403);
  });
});

// Resolve-then-create is read-then-write with no transaction: two signups
// carrying the same token both pass the check and both become collaborators,
// silently exceeding MAX_COLLABORATORS. The per-IP limiter meters guessing, not
// a two-request burst, and a unique constraint on accepted_by cannot catch it
// either — both redemptions write the same invite row, so the second overwrites
// the first with no violation to trip on. The fix is to claim the invite first
// with a conditional UPDATE ... WHERE accepted_at IS NULL and check the
// affected-row count; this test is what proves the claim is atomic.
describe("two signups racing the same invite", () => {
  // Its own client bucket: these two requests would otherwise push the shared
  // "unknown" signup budget over SIGNUP_RULE's 5-per-hour and 429.
  const RACER_IP = "203.0.113.9";

  it("lets exactly one through and creates exactly one user", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "race-invite-token", label: "Race" });

    const attempt = (email: string) =>
      app.request(
        "/auth/signup",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": RACER_IP },
          body: JSON.stringify({
            email,
            password: "correct horse",
            inviteToken: "race-invite-token",
          }),
        },
        env
      );

    // Warm this client's rate-limit bucket first. isRateLimited() INSERTs the
    // row on a client's first ever hit, and rate_limits.key is the primary key,
    // so two genuinely concurrent first hits make the loser die on a UNIQUE
    // constraint and 500 — a pre-existing wart in the limiter, unrelated to
    // invites, that would otherwise mask what this test is measuring.
    const warm = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": RACER_IP },
        body: JSON.stringify({}),
      },
      env
    );
    expect(warm.status).toBe(400);

    const emails = ["racer-a@test.dev", "racer-b@test.dev"];
    const [a, b] = await Promise.all(emails.map(attempt));

    expect([a.status, b.status].sort()).toEqual([201, 403]);

    const created = await db.select().from(users).where(inArray(users.email, emails));
    expect(created).toHaveLength(1);
    expect(created[0].lockerOwnerId).toBe(ownerId);

    const [invite] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.token, "race-invite-token"));
    expect(invite.acceptedBy).toBe(created[0].id);
    expect(invite.acceptedAt).not.toBeNull();
  });
});

// The claim is only atomic if the affected-row count is real, so pin the shape
// it is read from. better-sqlite3 hands back a RunResult; D1 puts the same
// number under meta. rowsAffected() reads both and fails closed on anything
// else, because a driver we cannot count rows on must not hand out invites.
describe("rowsAffected", () => {
  it("reads the count off what the driver actually returns", async () => {
    const [inv] = await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "shape-probe-token", label: "shape" })
      .returning();

    const hit = await db
      .update(collaboratorInvites)
      .set({ label: "shape again" })
      .where(eq(collaboratorInvites.id, inv.id));
    // better-sqlite3's RunResult, verified rather than assumed.
    expect(hit).toHaveProperty("changes", 1);
    expect(rowsAffected(hit)).toBe(1);

    const miss = await db
      .update(collaboratorInvites)
      .set({ label: "nobody" })
      .where(eq(collaboratorInvites.id, "no-such-invite"));
    expect(rowsAffected(miss)).toBe(0);

    // D1Response, which is what production reads.
    expect(rowsAffected({ success: true, meta: { changes: 1 } })).toBe(1);
    expect(rowsAffected({ success: true, meta: { changes: 0 } })).toBe(0);
    // Anything else fails closed.
    expect(rowsAffected({})).toBe(0);
    expect(rowsAffected(null)).toBe(0);
  });
});

// Binding an account that already owns library rows would hide its own library
// from it — lockerIdOf() would answer with someone else's id while the rows
// still carry this one's. Unreachable through signup, which binds a
// milliseconds-old account, so this calls the guard directly. It is the
// tripwire for a future "convert an existing account" feature.
describe("bindToLocker", () => {
  it("refuses an account that already owns library rows, and writes nothing", async () => {
    const [incumbent] = await db
      .insert(users)
      .values({ email: "incumbent@test.dev", passwordHash: "x" })
      .returning();
    await db
      .insert(tracks)
      .values({
        ownerId: incumbent.id,
        title: "their own record",
        position: 0,
        originalKey: "lib/their-own",
      })
      .returning();

    await expect(bindToLocker(db, incumbent.id, ownerId)).rejects.toThrow(
      /already owns library rows/
    );

    const [unchanged] = await db.select().from(users).where(eq(users.id, incumbent.id));
    expect(unchanged.lockerOwnerId).toBeNull();
  });
});

// Nothing sets expiresAt today, but the column exists and the claim reads it.
describe("an expired invite", () => {
  it("is refused like a spent one", async () => {
    await db.insert(collaboratorInvites).values({
      ownerId,
      token: "expired-invite-token",
      label: "Late",
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
        body: JSON.stringify({
          email: "late@test.dev",
          password: "correct horse",
          inviteToken: "expired-invite-token",
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "late@test.dev"));
    expect(none).toBeUndefined();
  });
});

// The invite is checked before the duplicate-email query, not after. Otherwise
// anyone could send a junk token with a guessed address and read "email
// already registered" off a closed instance — signup would answer a question
// only the owner is entitled to ask. Both of these must 403, never 409.
describe("a bad invite never reaches the duplicate-email check", () => {
  const PROBER_IP = "203.0.113.11";

  const probe = (inviteToken: string) =>
    app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": PROBER_IP },
        body: JSON.stringify({
          // Registered by the redemption test above.
          email: "dana@test.dev",
          password: "correct horse",
          inviteToken,
        }),
      },
      env
    );

  it("refuses an unknown token without confirming the address", async () => {
    expect((await probe("still-no-such-token")).status).toBe(403);
  });

  it("refuses a spent token without confirming the address", async () => {
    expect((await probe("good-invite-token")).status).toBe(403);
  });
});

// A JSON body is whatever the caller says it is. A non-string token must be
// refused, not handed to the query layer, which would bind an object as a
// parameter and 500.
describe("a non-string invite token", () => {
  it("is refused rather than reaching the database", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.12" },
        body: JSON.stringify({
          email: "typed@test.dev",
          password: "correct horse",
          inviteToken: { $ne: null },
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "typed@test.dev"));
    expect(none).toBeUndefined();
  });
});

// Redemption is four writes with no transaction — D1 has none to offer across
// a request — so what matters is what a failure between them leaves behind.
// These tests inject the failure at each seam. The proxy fails one table's
// inserts or updates and passes everything else through, so the rate limiter
// (which reads and writes rate_limits on every request) still works.
describe("a partial failure during redemption", () => {
  const failing = (op: "insert" | "update", table: unknown) =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === op) {
          return (t: unknown) => {
            if (t === table) throw new Error(`injected ${op} failure`);
            return (target as Record<string, (t: unknown) => unknown>)[op](t);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

  const redeem = (email: string, token: string, ip: string) =>
    app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ email, password: "correct horse", inviteToken: token }),
      },
      env
    );

  // An account created unbound and bound by a follow-up UPDATE survives that
  // UPDATE failing — with locker_owner_id NULL. isLockerOwner() is exactly
  // that test, so the orphan is a full independent locker owner: it logs in
  // with the password it just chose, gets its own library, and can mint
  // invites, on an instance where registration is closed. The binding goes in
  // the INSERT so there is no window to fail in.
  it("never leaves an account that is not bound to the inviting locker", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "no-orphan-token", label: "Bound" });

    setDbFactory(() => failing("update", users));
    let res: Response;
    try {
      res = await redeem("no-orphan@test.dev", "no-orphan-token", "203.0.113.13");
    } finally {
      setDbFactory(() => db);
    }

    expect(res.status).toBe(201);
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.email, "no-orphan@test.dev"));
    expect(account).toBeDefined();
    expect(account.lockerOwnerId).toBe(ownerId);

    // The account must never be a locker owner, not even transiently — which
    // is what a failed follow-up UPDATE would have left.
    const orphans = await db
      .select()
      .from(users)
      .where(and(eq(users.email, "no-orphan@test.dev"), isNull(users.lockerOwnerId)));
    expect(orphans).toHaveLength(0);
  });

  // The claim happens before the account is created, so a failure to create
  // has to hand the invite back or it is spent forever: accepted_at set,
  // nobody in the locker, and the owner has to notice and re-mint.
  it("hands the invite back when the account cannot be created", async () => {
    const [inv] = await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "released-token", label: "Retry" })
      .returning();

    setDbFactory(() => failing("insert", users));
    let res: Response;
    try {
      res = await redeem("retry@test.dev", "released-token", "203.0.113.14");
    } finally {
      setDbFactory(() => db);
    }
    expect(res.status).toBe(500);

    const [after] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.id, inv.id));
    expect(after.acceptedAt).toBeNull();
    expect(after.acceptedBy).toBeNull();

    const [none] = await db.select().from(users).where(eq(users.email, "retry@test.dev"));
    expect(none).toBeUndefined();

    // And it is genuinely reusable, which is the point of releasing it.
    const second = await redeem("retry@test.dev", "released-token", "203.0.113.14");
    expect(second.status).toBe(201);
    const { user } = (await second.json()) as { user: { id: string; lockerOwnerId: string } };
    expect(user.lockerOwnerId).toBe(ownerId);
  });
});

// The release is only safe because it can undo exactly one claim: the one whose
// accepted_at it was given. Both of these are invites it must refuse to touch.
describe("releaseInvite", () => {
  it("refuses to release an invite that someone actually redeemed", async () => {
    const [member] = await db
      .insert(users)
      .values({ email: "already-in@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const claimedAt = new Date();
    const [inv] = await db
      .insert(collaboratorInvites)
      .values({
        ownerId,
        token: "spent-token",
        label: "Spent",
        acceptedAt: claimedAt,
        acceptedBy: member.id,
      })
      .returning();

    expect(await releaseInvite(db, inv.id, claimedAt)).toBe(false);

    const [after] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.id, inv.id));
    expect(after.acceptedAt).not.toBeNull();
    expect(after.acceptedBy).toBe(member.id);
  });

  // accepted_by is ON DELETE SET NULL, so once the owner removes a redeemed
  // collaborator the invite reads accepted_at set and accepted_by NULL —
  // byte-for-byte identical to a claim that never became an account. Matching
  // the claim's own timestamp is what tells them apart; `accepted_by IS NULL`
  // on its own cannot, and a cleanup sweep built on it would quietly un-spend
  // the invites of every removed member.
  it("refuses to release an invite whose redeemer has since been removed", async () => {
    const [member] = await db
      .insert(users)
      .values({ email: "removed-later@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const redeemedAt = new Date(Date.now() - 60_000);
    const [inv] = await db
      .insert(collaboratorInvites)
      .values({
        ownerId,
        token: "redeemer-removed-token",
        label: "Gone",
        acceptedAt: redeemedAt,
        acceptedBy: member.id,
      })
      .returning();

    await db.delete(users).where(eq(users.id, member.id));
    const [orphaned] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.id, inv.id));
    // Precondition: it now looks exactly like an abandoned claim.
    expect(orphaned.acceptedBy).toBeNull();
    expect(orphaned.acceptedAt).not.toBeNull();

    // Some later caller's claim, with its own timestamp.
    expect(await releaseInvite(db, inv.id, new Date())).toBe(false);

    const [after] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.id, inv.id));
    expect(after.acceptedAt?.getTime()).toBe(redeemedAt.getTime());
  });
});

// An invite pointing at an account that is not a locker owner cannot be
// honoured: lockerIdOf() would resolve to a user id that is not a locker, and
// the new account's reads would land on a library nobody owns. Unreachable
// today — POST /collab/invites is owner-gated and nothing demotes an owner —
// so both of these plant the row directly.
describe("an invite whose owner is not a locker owner", () => {
  it("is refused at redemption", async () => {
    const [notAnOwner] = await db
      .insert(users)
      .values({ email: "not-an-owner@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    await db
      .insert(collaboratorInvites)
      .values({ ownerId: notAnOwner.id, token: "chained-token", label: "Chain" });

    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.15" },
        body: JSON.stringify({
          email: "chained@test.dev",
          password: "correct horse",
          inviteToken: "chained-token",
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "chained@test.dev"));
    expect(none).toBeUndefined();
  });

  it("is refused by bindToLocker", async () => {
    const [target] = await db
      .insert(users)
      .values({ email: "bind-target@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const [candidate] = await db
      .insert(users)
      .values({ email: "bind-candidate@test.dev", passwordHash: "x" })
      .returning();

    await expect(bindToLocker(db, candidate.id, target.id)).rejects.toThrow(
      /itself a collaborator/
    );

    const [unchanged] = await db.select().from(users).where(eq(users.id, candidate.id));
    expect(unchanged.lockerOwnerId).toBeNull();
  });
});

// The seat cap is enforced where the seat is taken, not only where the invite
// was minted. getLimits reads the env per request, so an operator who lowers
// MAX_COLLABORATORS while invites are outstanding would otherwise watch every
// one of them redeem anyway and end up permanently over the cap they just set.
describe("MAX_COLLABORATORS at redemption", () => {
  it("refuses to seat a collaborator the locker no longer has room for", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "over-cap-token", label: "Too many" });

    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.16" },
        body: JSON.stringify({
          email: "over-cap@test.dev",
          password: "correct horse",
          inviteToken: "over-cap-token",
        }),
      },
      { ...env, MAX_COLLABORATORS: "1" }
    );
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("full");

    const [none] = await db.select().from(users).where(eq(users.email, "over-cap@test.dev"));
    expect(none).toBeUndefined();

    // Refused before anything was claimed, so the invite is untouched — an
    // operator lowering the cap must not also destroy the invites already out.
    const [invite] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.token, "over-cap-token"));
    expect(invite.acceptedAt).toBeNull();
    expect(invite.acceptedBy).toBeNull();
  });

  // Untouched is not the same as usable. A refusal that claimed and then
  // compensated would leave accepted_at null on a good day and spent forever
  // on a bad one, since the release is best-effort and swallows throws. The
  // only way to show the invite really survived is to redeem it.
  it("leaves the invite redeemable once the operator makes room", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.16" },
        body: JSON.stringify({
          email: "over-cap@test.dev",
          password: "correct horse",
          inviteToken: "over-cap-token",
        }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: { id: string; lockerOwnerId: string } };
    expect(user.lockerOwnerId).toBe(ownerId);

    const [invite] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.token, "over-cap-token"));
    expect(invite.acceptedBy).toBe(user.id);
  });
});

// Every invite-related refusal has to come before the duplicate-email 409, or
// signup becomes an account-enumeration oracle: a caller holding one valid
// invite to a full locker could tell a registered address from an unregistered
// one, free and repeatably, because the refusal never spends the invite. The
// full-locker check is the one that has to be watched — it is the only invite
// refusal that depends on state other than the token.
describe("a full locker refuses identically whatever the address", () => {
  const PROBER_IP = "203.0.113.18";

  const probe = (email: string) =>
    app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": PROBER_IP },
        body: JSON.stringify({
          email,
          password: "correct horse",
          inviteToken: "full-locker-token",
        }),
      },
      { ...env, MAX_COLLABORATORS: "1" }
    );

  it("cannot be used to tell a registered address from an unregistered one", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "full-locker-token", label: "Prober" });

    // dana@test.dev was registered by the redemption suite above.
    const registered = await probe("dana@test.dev");
    const unknown = await probe("nobody-at-all@test.dev");

    expect(registered.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await registered.json()).toEqual(await unknown.json());

    // And probing cost the prober nothing — the invite is still unspent, so
    // this is repeatable rather than self-limiting.
    const [invite] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.token, "full-locker-token"));
    expect(invite.acceptedAt).toBeNull();
  });
});

// The duplicate-email check is a plain read with no transaction, so two
// concurrent signups on one address both pass it and the loser only finds out
// at the INSERT. That is the same taken-address condition, so it gets the same
// documented 409 rather than an opaque 500 — and the loser's invite goes back.
describe("two signups racing the same email", () => {
  const RACER_IP = "203.0.113.17";

  it("answers the loser with 409 and hands its invite back", async () => {
    const tokens = ["dupe-a-token", "dupe-b-token"];
    for (const token of tokens) {
      await db.insert(collaboratorInvites).values({ ownerId, token, label: `Dupe ${token}` });
    }

    // Warm this client's bucket — see the same note on the token race above.
    const warm = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": RACER_IP },
        body: JSON.stringify({}),
      },
      env
    );
    expect(warm.status).toBe(400);

    const attempt = (inviteToken: string) =>
      app.request(
        "/auth/signup",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": RACER_IP },
          body: JSON.stringify({
            email: "contested@test.dev",
            password: "correct horse",
            inviteToken,
          }),
        },
        env
      );

    const [a, b] = await Promise.all(tokens.map(attempt));
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const created = await db
      .select()
      .from(users)
      .where(eq(users.email, "contested@test.dev"));
    expect(created).toHaveLength(1);
    expect(created[0].lockerOwnerId).toBe(ownerId);

    const invites = await db
      .select()
      .from(collaboratorInvites)
      .where(inArray(collaboratorInvites.token, tokens));
    const spent = invites.filter((i: { acceptedAt: Date | null }) => i.acceptedAt !== null);
    const returned = invites.filter((i: { acceptedAt: Date | null }) => i.acceptedAt === null);
    expect(spent).toHaveLength(1);
    expect(returned).toHaveLength(1);
    expect(spent[0].acceptedBy).toBe(created[0].id);
  });
});
