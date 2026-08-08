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
    })
    .from(collaboratorInvites)
    .where(and(eq(collaboratorInvites.token, token), isNull(collaboratorInvites.acceptedAt)))
    .limit(1);

  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt <= now) return null;
  return { id: invite.id, ownerId: invite.ownerId };
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

export type SignupUser = {
  id: string;
  email: string;
  accent: string | null;
  lockerOwnerId: string | null;
};

// The one sanctioned way to make an account a collaborator on someone else's
// locker. Everything that writes users.locker_owner_id should come through
// here, so the invariant below is checked once rather than remembered.
export async function bindToLocker(
  db: Database,
  userId: string,
  ownerId: string
): Promise<SignupUser> {
  await assertLockerBindingSafe(db, userId);

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
export async function assertLockerBindingSafe(db: Database, userId: string): Promise<void> {
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
