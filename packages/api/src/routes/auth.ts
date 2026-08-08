import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "../db/index.js";
import { users, sessions, collaboratorInvites } from "../db/schema.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  needsRehash,
} from "../lib/auth.js";
import {
  requireAuth,
  bearerToken,
  createSession,
  deleteSession,
  findSession,
} from "../lib/session.js";
import { isValidAccent } from "../lib/accent.js";
import {
  signupAllowed,
  resolveInvite,
  claimInvite,
  releaseInvite,
  countLockerMembers,
  isDuplicateEmailError,
  type ClaimedInvite,
  type PendingInvite,
} from "../lib/signup.js";
import { getLimits, isLimited } from "../lib/limits.js";
import { rateLimit, LOGIN_RULE, SIGNUP_RULE } from "../lib/rate-limit.js";
import type { Env } from "../types.js";

const auth = new Hono<Env>();

// Hand a claimed invite back after the account it was claimed for failed to
// materialise. Best-effort on purpose: the error that triggered this is the one
// worth reporting, and a release that cannot land leaves a spent invite — the
// safe direction, since nobody got in.
async function release(db: Database, invite: ClaimedInvite): Promise<void> {
  try {
    if (!(await releaseInvite(db, invite.id, invite.claimedAt))) {
      console.error("invite", invite.id, "was not released — it may already be redeemed");
    }
  } catch (err) {
    console.error("failed to release invite", invite.id, err);
  }
}

auth.post("/signup", rateLimit("signup", SIGNUP_RULE), async (c) => {
  const { email, password, inviteToken } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const db = getDb(c.env.DB);

  // Two ways in, and only two.
  //
  // A collaborator invite is its own authorisation to create an account, so it
  // gets past the closed-registration gate — but an invalid, spent or expired
  // token fails outright here. It must never fall through to the ordinary
  // path, or a spent invite would quietly become a normal registration attempt
  // on an instance that has reopened signup via ALLOW_SIGNUP.
  //
  // Registration otherwise closes automatically once the instance has an
  // owner. A Demo Locker is one person's locker; every deployment used to
  // accept registrations from the open internet forever, with no flag to turn
  // it off.
  //
  // This is only a pre-flight look at the invite. It is checked before the
  // duplicate-email query below so a caller holding a garbage token cannot use
  // "email already registered" as an account-enumeration oracle; the binding
  // claim itself happens after, once nothing else can refuse the request.
  //
  // A non-string token is refused rather than handed to the query layer, which
  // would bind an object as a parameter and 500.
  if (inviteToken != null && typeof inviteToken !== "string") {
    return c.json({ error: "this invite is not valid" }, 403);
  }

  // Re-check the seat cap at redemption, not only where the invite was minted.
  // getLimits reads the env per request, so an operator who lowers
  // MAX_COLLABORATORS while invites are outstanding would otherwise see every
  // one of them redeemed anyway and end up permanently over the cap they just
  // set. Redemption is where a seat is actually taken.
  //
  // The count is read TWICE, at two positions, because they buy different
  // things and neither alone is enough:
  //
  //   - Here, before the duplicate-email 409, so a caller holding a valid
  //     invite to a full locker gets the same 403 whatever address they send.
  //     Only here does that hold: after the 409, signup becomes a free,
  //     repeatable registered/not-registered oracle for anyone with an invite,
  //     since a refusal never spends the invite and can be run all day.
  //   - Again below, immediately before claimInvite, so the interval between
  //     the last count and the INSERT that consumes the seat does not span
  //     PBKDF2 — which is by far the slowest thing on this route, and which
  //     made "two invitees redeem at once" reliably reproducible rather than a
  //     sub-millisecond race.
  //
  // Both sit BEFORE the claim, which is what keeps refusing free: nothing has
  // been claimed, so nothing needs releasing, and release() is best-effort by
  // design — a transient failure there would leave accepted_at set and
  // accepted_by NULL, which resolveInvite refuses forever. An operator
  // lowering a cap must not thereby void the invites already out.
  //
  // It remains a SOFT cap. Redemptions of DIFFERENT tokens interleaved between
  // the second count and the INSERT can still both get in; claimInvite's
  // conditional update does not help, being per-token. The mint-time check in
  // routes/collab.ts has the same character. Closing it entirely would need a
  // conditional INSERT ... SELECT ... WHERE (count) < n — which SQLite can in
  // fact express — but a zero-row insert then has to release the claim it just
  // made, putting the fragile compensation back on the path for the sake of an
  // advisory limit. Two cheap counts get most of the benefit and none of that.
  const limits = getLimits(c.env);
  const capped = isLimited(limits.maxCollaborators);
  const lockerFull = async (ownerId: string) =>
    capped && (await countLockerMembers(db, ownerId)) >= limits.maxCollaborators;
  const fullResponse = () =>
    c.json(
      { error: `this locker is full — it allows ${limits.maxCollaborators} collaborators` },
      403
    );

  let pending: PendingInvite | null = null;
  if (inviteToken) {
    pending = await resolveInvite(db, inviteToken);
    if (!pending) {
      return c.json({ error: "this invite is not valid" }, 403);
    }
    if (await lockerFull(pending.ownerId)) {
      return fullResponse();
    }
  } else if (!(await signupAllowed(db, c.env))) {
    return c.json({ error: "registration is closed on this instance" }, 403);
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return c.json({ error: "email already registered" }, 409);
  }

  // Hash before claiming: PBKDF2 is the slowest thing on this path, and every
  // step taken after the claim is a step that can burn the invite.
  const passwordHash = await hashPassword(password);

  // The second seat count — see the note above. Still before the claim, so a
  // refusal here is as free as the first one, and this is the position that
  // keeps PBKDF2 out of the count-to-insert interval.
  if (pending && (await lockerFull(pending.ownerId))) {
    return fullResponse();
  }

  // Now take the invite. This is the atomic conditional update — the winner of
  // two concurrent redemptions, not merely a caller who read the row while it
  // was still open. The loser is refused exactly like a spent invite, and
  // creates nothing.
  //
  // Claim before creating, not after, because the two orderings fail in very
  // different directions. Claiming first means a failure leaves nobody in the
  // locker and, at worst, a spent invite — which the release below undoes.
  // Creating first would mean a lost race leaves an account already bound to
  // someone else's locker, and if the cleanup delete then failed, that is
  // standing access nobody granted. A lost seat is recoverable; unauthorised
  // access is not.
  let invite: ClaimedInvite | null = null;
  if (inviteToken) {
    invite = await claimInvite(db, inviteToken);
    if (!invite) {
      return c.json({ error: "this invite is not valid" }, 403);
    }
  }

  // The binding is set in the INSERT, never in a follow-up UPDATE. There is no
  // transaction here — D1 has none to offer across a request — so an account
  // created unbound and bound afterwards is an account that survives with
  // locker_owner_id NULL if anything in between fails. isLockerOwner() is
  // exactly that test, so such an orphan would be a full independent locker
  // owner, able to log in with the password it just chose and mint invites of
  // its own, on an instance where registration is closed.
  let user;
  try {
    [user] = await db
      .insert(users)
      .values({ email, passwordHash, lockerOwnerId: invite?.ownerId ?? null })
      .returning({
        id: users.id,
        email: users.email,
        accent: users.accent,
        lockerOwnerId: users.lockerOwnerId,
      });
  } catch (err) {
    // The account did not happen, so the invite must not stay spent.
    if (invite) await release(db, invite);

    // The duplicate-email check above is a plain read with no transaction, so
    // two concurrent signups on one address both pass it and the loser only
    // finds out here. That is the same taken-address condition the check above
    // answers with 409, and it is what the API documents, so it answers the
    // same way rather than surfacing as an opaque 500.
    if (isDuplicateEmailError(err)) {
      return c.json({ error: "email already registered" }, 409);
    }
    throw err;
  }

  // From here the account exists and the claim must stand. Attribution is the
  // only thing left, and it is not worth failing a successful signup over: the
  // collaborator is already in the locker and shows up in GET /collab/members,
  // which reads users.locker_owner_id rather than this column.
  if (invite) {
    try {
      await db
        .update(collaboratorInvites)
        .set({ acceptedBy: user.id })
        .where(eq(collaboratorInvites.id, invite.id));
    } catch (err) {
      console.error("failed to record who redeemed invite", invite.id, err);
    }
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await createSession(db, user.id, token, expiresAt);

  return c.json({ user, token }, 201);
});

auth.post("/login", rateLimit("login", LOGIN_RULE), async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }

  const db = getDb(c.env.DB);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  // Upgrade the stored hash in place when it predates the current PBKDF2 cost.
  // This is the only moment the plaintext password is available, so it is the
  // only place the migration can happen without a forced reset.
  if (needsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id));
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await createSession(db, user.id, token, expiresAt);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      accent: user.accent,
      lockerOwnerId: user.lockerOwnerId,
    },
    token,
  });
});

auth.get("/me", requireAuth, async (c) => {
  return c.json({ user: c.get("user") });
});

// The accent is an account setting, not a browser setting: it is what listeners
// on a share link see, so it has to outlive the owner's localStorage.
auth.post("/accent", requireAuth, async (c) => {
  const { accent } = await c.req.json();

  if (!isValidAccent(accent)) {
    return c.json({ error: "unsupported accent" }, 400);
  }

  const db = getDb(c.env.DB);
  await db.update(users).set({ accent }).where(eq(users.id, c.get("user").id));

  return c.json({ accent });
});

auth.post("/change-password", requireAuth, async (c) => {
  const { currentPassword, newPassword } = await c.req.json();

  if (!currentPassword || !newPassword) {
    return c.json({ error: "currentPassword and newPassword required" }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const db = getDb(c.env.DB);
  const sessionUser = c.get("user");

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);

  // Require the current password even though the caller already holds a valid
  // session: a borrowed or stolen token shouldn't be enough to lock the real
  // owner out of their own locker.
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: "current password is incorrect" }, 401);
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.id, user.id));

  // Revoke every other session — changing a password is how you get an
  // intruder out, so any session opened with the old one has to die. The
  // caller's own token survives so they aren't logged out of the tab they
  // just did this in.
  // Compare by row id, not by token: tokens are stored hashed now, so the
  // caller's raw header no longer equals anything in the table.
  const currentToken = bearerToken(c.req.header("Authorization"));
  const current = currentToken ? await findSession(db, currentToken) : null;
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, user.id));

  for (const s of existing) {
    if (s.id !== current?.id) {
      await db.delete(sessions).where(eq(sessions.id, s.id));
    }
  }

  return c.json({ ok: true });
});

auth.post("/logout", requireAuth, async (c) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    await deleteSession(getDb(c.env.DB), token);
  }
  return c.json({ ok: true });
});

export default auth;
