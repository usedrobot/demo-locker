// Who is allowed to create an account.
//
// Registration used to be open on every instance forever, with no way to close
// it: anyone who found the URL could sign up on someone's personal locker. The
// default is now "first account only" — which is exactly what the install
// wizard needs (it creates the owner immediately after deploy) and nothing
// more. Operators running a shared instance can reopen it with ALLOW_SIGNUP.

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { collaboratorInvites, playlists, tracks, users } from "../db/schema.js";
import type { Bindings } from "../types.js";

export function signupExplicitlyAllowed(env: Bindings): boolean {
  return (env.ALLOW_SIGNUP ?? "").toLowerCase() === "true";
}

export async function signupAllowed(
  db: Database,
  env: Bindings
): Promise<boolean> {
  if (signupExplicitlyAllowed(env)) return true;

  // Count rather than "select one": the bootstrap case is specifically "this
  // instance has no owner yet".
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users);
  return Number(row?.count ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// Invites: the second way in.
//
// A collaborator invite is its own authorisation to create an account, so it
// gets past the closed-registration gate above. Everything here exists to make
// that exactly one account per invite.
// ---------------------------------------------------------------------------

export type ClaimedInvite = { id: string; ownerId: string };

// How many rows an UPDATE touched, across both SQLite drivers this codebase
// runs on. better-sqlite3 returns a RunResult — `{ changes, lastInsertRowid }`
// — while D1 returns a D1Response that carries the same number at
// `meta.changes`. Unknown shapes read as 0, which fails the claim closed: a
// driver we cannot count rows on must not be allowed to hand out invites.
export function rowsAffected(result: unknown): number {
  const r = result as { changes?: unknown; meta?: { changes?: unknown } } | null | undefined;
  const raw = typeof r?.changes === "number" ? r.changes : r?.meta?.changes;
  return typeof raw === "number" ? raw : 0;
}

// A read-only look at an invite: unredeemed and unexpired, or null. Unknown,
// spent and expired are indistinguishable to the caller on purpose, and the
// caller must NOT fall back to the ordinary signup path for any of them, or a
// spent invite would quietly become a normal registration attempt on an
// instance that has reopened signup.
//
// This is a pre-flight check only. It cannot decide a redemption — two callers
// can pass it at once — so `claimInvite` below is the authority. It exists so
// a bad token is refused before the duplicate-email check, which would
// otherwise answer "email already registered" to anyone holding a garbage
// token and turn signup into an account-enumeration oracle.
export async function resolveInvite(
  db: Database,
  token: string,
  now: Date = new Date()
): Promise<ClaimedInvite | null> {
  const [invite] = await db
    .select({
      id: collaboratorInvites.id,
      ownerId: collaboratorInvites.ownerId,
      expiresAt: collaboratorInvites.expiresAt,
      // The invite is only worth anything if the account it points at still
      // owns a locker. Redeeming one that points at a collaborator would bind
      // the new account to a user id that is not a locker: lockerIdOf() would
      // resolve to it, and every read would land on a library nobody owns.
      // Unreachable today — POST /collab/invites is isLockerOwner-gated and
      // nothing demotes an owner — so this is the same kind of tripwire as
      // assertLockerBindingSafe, and 403 is the honest answer for an invite
      // that cannot be honoured.
      ownerIsLockerOwner: users.lockerOwnerId,
    })
    .from(collaboratorInvites)
    .innerJoin(users, eq(users.id, collaboratorInvites.ownerId))
    .where(and(eq(collaboratorInvites.token, token), isNull(collaboratorInvites.acceptedAt)))
    .limit(1);

  if (!invite) return null;
  if (invite.ownerIsLockerOwner !== null) return null;
  if (invite.expiresAt && invite.expiresAt <= now) return null;
  return { id: invite.id, ownerId: invite.ownerId };
}

// Members already seated in a locker. The mint-time cap in routes/collab.ts
// counts members plus outstanding invites; this counts only who is actually
// in, because the invite being redeemed is one of those outstanding ones.
export async function countLockerMembers(db: Database, ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.lockerOwnerId, ownerId));
  return Number(row?.count ?? 0);
}

// Take the invite, atomically, before creating anything.
//
// Reading the invite and then creating the account is read-then-write with no
// transaction: two concurrent signups carrying the same token both pass the
// read and both become collaborators, silently exceeding MAX_COLLABORATORS.
// The per-IP rate limiter meters guessing, not a two-request burst. A unique
// constraint on accepted_by would not catch it either — both redemptions write
// the same invite row, so the second overwrites the first and there is no
// violation to trip on.
//
// A single conditional UPDATE ... WHERE accepted_at IS NULL is atomic on both
// SQLite and D1, so exactly one caller can see it change a row. The loser gets
// null and must be refused exactly like a spent invite.
export async function claimInvite(
  db: Database,
  token: string,
  now: Date = new Date()
): Promise<ClaimedInvite | null> {
  const claim = await db
    .update(collaboratorInvites)
    .set({ acceptedAt: now })
    .where(
      and(
        eq(collaboratorInvites.token, token),
        isNull(collaboratorInvites.acceptedAt),
        or(isNull(collaboratorInvites.expiresAt), gt(collaboratorInvites.expiresAt, now))
      )
    );

  if (rowsAffected(claim) !== 1) return null;

  // Safe to read back unconditionally: the token is unique, and we are the one
  // who moved this row out of the unredeemed state.
  const [invite] = await db
    .select({ id: collaboratorInvites.id, ownerId: collaboratorInvites.ownerId })
    .from(collaboratorInvites)
    .where(eq(collaboratorInvites.token, token))
    .limit(1);

  return invite ? { id: invite.id, ownerId: invite.ownerId } : null;
}

// Give a claimed invite back.
//
// There is no transaction anywhere in this codebase — D1 has none to offer
// across a request — so a claim followed by a failed account creation would
// otherwise leave the invite spent forever: accepted_at set, nobody in the
// locker, and the owner has to notice and re-mint. Releasing is the
// compensating action.
//
// `accepted_by IS NULL` is what makes it safe to call: it can only ever undo a
// claim that never became an account, so a release arriving late can never
// unspend an invite that someone successfully redeemed. Best-effort by design
// — the caller logs a failure rather than raising it, because the error that
// triggered the release is the one worth reporting.
export async function releaseInvite(db: Database, inviteId: string): Promise<boolean> {
  const released = await db
    .update(collaboratorInvites)
    .set({ acceptedAt: null })
    .where(and(eq(collaboratorInvites.id, inviteId), isNull(collaboratorInvites.acceptedBy)));

  return rowsAffected(released) === 1;
}

export type SignupUser = {
  id: string;
  email: string;
  accent: string | null;
  lockerOwnerId: string | null;
};

// Bind an *existing* account to someone else's locker.
//
// Signup does not use this: it sets locker_owner_id in the INSERT, because a
// separate UPDATE means a transient failure between the two leaves an account
// with locker_owner_id NULL — and isLockerOwner() is exactly that test, so the
// orphan is a full independent locker owner on an instance where registration
// is closed. One statement, no window.
//
// This stays as the one sanctioned way to bind an account that already exists,
// which is what a future "convert an existing account to a collaborator"
// feature needs. It asserts both halves of the invariant before it writes.
export async function bindToLocker(
  db: Database,
  userId: string,
  ownerId: string
): Promise<SignupUser> {
  await assertLockerBindingSafe(db, userId, ownerId);

  const [user] = await db
    .update(users)
    .set({ lockerOwnerId: ownerId })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      email: users.email,
      accent: users.accent,
      lockerOwnerId: users.lockerOwnerId,
    });

  return user;
}

// Setting locker_owner_id on an account that already owns playlists or tracks
// would hide that account's own library from it: lockerIdOf() would start
// answering with someone else's id while the rows still carry this one's. That
// is unreachable today — redemption creates a brand-new account — so this is a
// tripwire, not a fix. It is here so a future "convert an existing account to a
// collaborator" feature cannot introduce the bug silently. It throws rather
// than returning a boolean because there is no sane way to continue.
//
// The target is checked too: binding to an account that is itself a
// collaborator would point lockerIdOf() at a user id that is not a locker, and
// the bound account's reads would land on a library nobody owns.
export async function assertLockerBindingSafe(
  db: Database,
  userId: string,
  ownerId: string
): Promise<void> {
  const [target] = await db
    .select({ lockerOwnerId: users.lockerOwnerId })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);

  if (!target) {
    throw new Error(`refusing to bind ${userId} to ${ownerId}: no such account`);
  }
  if (target.lockerOwnerId !== null) {
    throw new Error(
      `refusing to bind ${userId} to ${ownerId}: that account is itself a collaborator, not a locker owner`
    );
  }

  const [owned] = await db
    .select({ count: sql<number>`count(*)` })
    .from(playlists)
    .where(eq(playlists.ownerId, userId));
  const [held] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tracks)
    .where(eq(tracks.ownerId, userId));

  if (Number(owned?.count ?? 0) > 0 || Number(held?.count ?? 0) > 0) {
    throw new Error(
      `refusing to bind ${userId} to another locker: it already owns library rows, which would become unreachable to it`
    );
  }
}
