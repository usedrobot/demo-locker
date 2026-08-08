// Collaborators: people who share this locker's library.
//
// Every route here is owner-only. A collaborator can use the library but
// cannot change who else is in it — no invite chaining, no removing peers.
// Denials return the same non-enumerable 404 the rest of the private API uses.

import { Hono } from "hono";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, collaboratorInvites, comments } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { isLockerOwner } from "../lib/locker.js";
import { getLimits, isLimited } from "../lib/limits.js";
import type { Env } from "../types.js";

const collabRouter = new Hono<Env>();

const MAX_LABEL_CHARS = 100;

collabRouter.post("/invites", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const { label } = await c.req.json();
  if (!label || typeof label !== "string" || !label.trim()) {
    return c.json({ error: "label required" }, 400);
  }
  if (label.length > MAX_LABEL_CHARS) {
    return c.json({ error: `label must be ${MAX_LABEL_CHARS} characters or fewer` }, 400);
  }

  const db = getDb(c.env.DB);

  // The cap counts people who are already in plus invitations still
  // outstanding — otherwise an owner could mint unlimited invites and blow
  // past the limit at redemption time.
  const limits = getLimits(c.env);
  if (isLimited(limits.maxCollaborators)) {
    const [members] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.lockerOwnerId, user.id));
    const [pending] = await db
      .select({ count: sql<number>`count(*)` })
      .from(collaboratorInvites)
      .where(
        and(eq(collaboratorInvites.ownerId, user.id), isNull(collaboratorInvites.acceptedAt))
      );

    const used = Number(members?.count ?? 0) + Number(pending?.count ?? 0);
    if (used >= limits.maxCollaborators) {
      return c.json(
        { error: `this instance limits lockers to ${limits.maxCollaborators} collaborators` },
        403
      );
    }
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  const [invite] = await db
    .insert(collaboratorInvites)
    .values({ ownerId: user.id, token, label: label.trim() })
    .returning();

  return c.json({ invite }, 201);
});

collabRouter.get("/invites", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const invites = await db
    .select({
      id: collaboratorInvites.id,
      label: collaboratorInvites.label,
      token: collaboratorInvites.token,
      createdAt: collaboratorInvites.createdAt,
      acceptedAt: collaboratorInvites.acceptedAt,
    })
    .from(collaboratorInvites)
    .where(eq(collaboratorInvites.ownerId, user.id));

  return c.json({ invites });
});

collabRouter.delete("/invites/:id", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const [invite] = await db
    .select({ id: collaboratorInvites.id })
    .from(collaboratorInvites)
    .where(
      and(
        eq(collaboratorInvites.id, c.req.param("id")),
        eq(collaboratorInvites.ownerId, user.id)
      )
    )
    .limit(1);
  if (!invite) return c.json({ error: "not found" }, 404);

  await db.delete(collaboratorInvites).where(eq(collaboratorInvites.id, invite.id));
  return c.json({ ok: true });
});

collabRouter.get("/members", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const members = await db
    // displayName is the name this person's uploads carry everywhere else, so
    // the panel can show "Jimmy" rather than a login address. Email stays: this
    // is the owner's own member-management view, where the address is the
    // useful identifier, and it is the fallback for a member who redeemed
    // before display names existed.
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.lockerOwnerId, user.id));

  return c.json({ members });
});

// Removing a collaborator deletes their account: sessions cascade so they are
// signed out, while uploaded_by / created_by go SET NULL. Their music stays in
// the library and reads as the owner's — the files belong to the locker, not
// to the person who happened to upload them.
//
// The one thing that does NOT survive is what they handed out: shares.created_by
// is ON DELETE CASCADE, so every link they minted — listen as well as edit —
// dies with them. Nothing ever sets a share's expiresAt, so a leftover link
// would be permanent access, and a listen link can pull the lossless master.
collabRouter.delete("/members/:id", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, c.req.param("id")), eq(users.lockerOwnerId, user.id)))
    .limit(1);
  if (!member) return c.json({ error: "not found" }, 404);

  // comments.resolved_by is the one FK to users with no ON DELETE action, and
  // it cannot get one: changing a column's FK on SQLite needs a full table
  // rebuild, which this plan forbids on a live table. Without this the DELETE
  // below aborts with FOREIGN KEY constraint failed. It cannot fire today —
  // resolving a comment is owner-only, so no collaborator id is ever written
  // here — so this is defusing a landmine rather than fixing a live bug. It
  // stays because the day resolution opens up to collaborators, the failure
  // would be an unexplainable 500 on the revoke path.
  await db.update(comments).set({ resolvedBy: null }).where(eq(comments.resolvedBy, member.id));

  await db.delete(users).where(eq(users.id, member.id));
  return c.json({ ok: true });
});

export default collabRouter;
