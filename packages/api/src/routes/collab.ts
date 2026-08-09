// Collaborators: people who share this locker's library.
//
// Every route here is owner-only. A collaborator can use the library but
// cannot change who else is in it — no invite chaining, no removing peers.
// Denials return the same non-enumerable 404 the rest of the private API uses.

import { Hono } from "hono";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, collaboratorInvites, comments, tracks, playlists } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { isLockerOwner } from "../lib/locker.js";
import { validateDisplayName } from "../lib/display-name.js";
import { getLimits, isLimited } from "../lib/limits.js";
import type { Env } from "../types.js";

const collabRouter = new Hono<Env>();

collabRouter.post("/invites", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const { label } = await c.req.json();
  if (!label || typeof label !== "string" || !label.trim()) {
    return c.json({ error: "label required" }, 400);
  }
  // The label BECOMES the collaborator's display name at redemption, so it is
  // held to the same rules as POST /auth/display-name — the same cap and the
  // same refusal of line breaks and control characters — by the one validator
  // both doors call (lib/display-name.ts). A rule enforced at one door only is
  // not enforced at all.
  //
  // The one difference is deliberate: a whitespace-only label is MISSING here
  // (refused above), where the name route reads it as "unset". An owner is
  // naming someone else and needs to have typed something; a person clearing
  // their own name is asking for the email fallback.
  const checked = validateDisplayName(label, "label");
  if ("error" in checked) return c.json({ error: checked.error }, 400);

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
    .values({ ownerId: user.id, token, label: checked.trimmed })
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
// the library — the files belong to the locker, not to the person who happened
// to upload them — and so does WHOSE it is: the name they were going by is
// copied onto their tracks and playlists just before the account goes, so the
// demos do not go blank the moment they leave.
//
// The snapshot is written HERE and nowhere else. Writing it at upload time
// would go stale the instant that person renamed themselves (POST
// /auth/display-name makes that possible), and it would only cover rows created
// after the column existed; written at removal it is always the name that was
// current, and demos uploaded long before this shipped are covered with no
// backfill.
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
    // displayName and email because the name this person is leaving behind is
    // the one everything else resolves for them: displayName if set, otherwise
    // the address (lib/display-name.ts).
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.id, c.req.param("id")), eq(users.lockerOwnerId, user.id)))
    .limit(1);
  if (!member) return c.json({ error: "not found" }, 404);

  // Before the delete, not after: once the account is gone so is the name, and
  // uploaded_by / created_by are already NULL with nothing left to match on.
  // Scoped to this locker as well as this member, so the write can only ever
  // touch rows the owner making the request can already see.
  const departedName = member.displayName ?? member.email;
  await db
    .update(tracks)
    .set({ uploadedByName: departedName })
    .where(and(eq(tracks.uploadedBy, member.id), eq(tracks.ownerId, user.id)));
  await db
    .update(playlists)
    .set({ createdByName: departedName })
    .where(and(eq(playlists.createdBy, member.id), eq(playlists.ownerId, user.id)));

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
