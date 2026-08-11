// Single access-control seam for the legacy (non-`/public/v1`) playlist,
// track, and comment routes. Phase B publishes playlist IDs on the open web,
// so an unguessable ID is no longer a capability. A request may read/write
// private playlist data iff it presents a valid, unexpired session or
// share/invite token that maps to the playlist (a session token grants
// access when it acts in the playlist's locker — either the owner, or a
// collaborator whose `users.lockerOwnerId` points at that owner).
//
// NOTE on the data model: `shares` has no user column — share/invite tokens
// (shares.playlistId -> token) map 1:1 to a playlist and grant access to
// anyone holding the token, collaborator or not. The locker resolution for
// session tokens is done via `lib/locker.ts`'s `lockerIdForUserId`.
//
// Callers must translate a `false` result into the same non-enumerable
// `{ error: "not found" }` 404 the public API uses — never 401/403.

import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb, type Database } from "../db/index.js";
import { playlists, shares } from "../db/schema.js";
import { bearerToken, findSession } from "./session.js";
import { lockerIdForUserId } from "./locker.js";
import type { Env } from "../types.js";

type AccessCreds = {
  // A raw token that may be EITHER a session token or a share token. Media
  // elements (<audio>/<img>) send this as `?token=`; fetches may send it as a
  // Bearer header — both are treated identically here.
  token?: string | null;
};

export async function canAccessPlaylist(
  db: Database,
  playlistId: string | null | undefined,
  creds: AccessCreds
): Promise<boolean> {
  if (!playlistId) return false;

  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);
  if (!playlist) return false; // nonexistent — indistinguishable from private

  const token = creds.token;
  if (!token) return false;

  // token as a share/invite token mapping to THIS playlist
  const [share] = await db
    .select({ expiresAt: shares.expiresAt })
    .from(shares)
    .where(and(eq(shares.token, token), eq(shares.playlistId, playlistId)))
    .limit(1);
  if (share && (!share.expiresAt || share.expiresAt >= new Date())) {
    return true;
  }

  // token as a session token acting in the playlist's locker (the owner, or a
  // collaborator on that owner's locker)
  const session = await findSession(db, token);
  if (session && session.expiresAt >= new Date()) {
    const lockerId = await lockerIdForUserId(db, session.userId);
    if (lockerId === playlist.ownerId) return true;
  }

  return false;
}

// REORDER capability: a session acting in the playlist's locker (the owner, or
// a collaborator on that owner's locker), or a share token whose permission is
// "edit" (and not expired). Returns the ownerId when allowed, or null when
// denied.
//
// This used to grant upload as well, and was named for that broader meaning.
// It no longer does: putting a FILE in the band's locker (and on the owner's
// storage quota, permanently, with no attribution to anyone) is a different
// act from changing the running order of what is already there, and only
// members of the locker do it. See requestCanUploadToPlaylist below — a share
// link is a way to let someone HEAR the record and arrange it, not a way into
// the library.
//
// The stored permission value is still "edit" — the capability narrowed, the
// column did not, so existing links keep working with less power rather than
// needing a migration.
export async function requestCanReorderPlaylist(
  c: Context<Env>,
  playlistId: string
): Promise<string | null> {
  const db = getDb(c.env.DB);
  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);
  if (!playlist) return null;

  const queryToken = c.req.query("token") || null;
  const bearer = bearerToken(c.req.header("Authorization"));

  for (const token of [queryToken, bearer]) {
    if (!token) continue;

    const session = await findSession(db, token);
    if (session && session.expiresAt >= new Date()) {
      const lockerId = await lockerIdForUserId(db, session.userId);
      if (lockerId === playlist.ownerId) return playlist.ownerId;
    }

    const [share] = await db
      .select({ permission: shares.permission, expiresAt: shares.expiresAt })
      .from(shares)
      .where(and(eq(shares.token, token), eq(shares.playlistId, playlistId)))
      .limit(1);
    if (
      share &&
      share.permission === "edit" &&
      (!share.expiresAt || share.expiresAt >= new Date())
    ) {
      return playlist.ownerId;
    }
  }
  return null;
}

// UPLOAD capability: a session acting in the playlist's locker — the owner or a
// collaborator — and NOTHING else. Returns the ownerId when allowed (a
// collaborator's upload belongs to the locker owner, exactly as their library
// upload does), or null when denied.
//
// Deliberately does NOT consult `shares`. A share link is handed to people
// outside the band; letting one write files into the locker meant an
// anonymous holder could spend the owner's storage quota, and the row it left
// behind had no uploader to attribute it to or to revoke — DELETE
// /collab/members/:id only matches accounts inside the locker, so there was no
// remedy short of deleting the track. Reordering is reversible and leaves
// nothing behind; uploading is neither.
//
// Kept as its own function rather than a flag on requestCanReorderPlaylist, so
// that neither capability can be widened by accident while editing the other.
export async function requestCanUploadToPlaylist(
  c: Context<Env>,
  playlistId: string
): Promise<string | null> {
  const db = getDb(c.env.DB);
  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);
  if (!playlist) return null;

  const queryToken = c.req.query("token") || null;
  const bearer = bearerToken(c.req.header("Authorization"));

  for (const token of [queryToken, bearer]) {
    if (!token) continue;

    const session = await findSession(db, token);
    if (session && session.expiresAt >= new Date()) {
      const lockerId = await lockerIdForUserId(db, session.userId);
      if (lockerId === playlist.ownerId) return playlist.ownerId;
    }
  }
  return null;
}

// Resolve the request's session user (from `?token=` or Bearer), if any.
// Used for resources gated on ownership alone, e.g. library tracks that are
// not in any playlist. Returns who is acting, NOT which locker they act in —
// callers that need to compare against a locker (e.g. attributing an upload
// to the owner while recording who actually did it) must resolve that
// themselves via `lockerIdForUserId`; this function must keep returning the
// raw acting user id.
export async function requestSessionUserId(
  c: Context<Env>
): Promise<string | null> {
  const db = getDb(c.env.DB);
  const queryToken = c.req.query("token") || null;
  const bearer = bearerToken(c.req.header("Authorization"));

  for (const token of [queryToken, bearer]) {
    if (!token) continue;
    const session = await findSession(db, token);
    if (session && session.expiresAt >= new Date()) return session.userId;
  }
  return null;
}

// Convenience wrapper used by the six gated routes: pulls every candidate
// credential off the request (the `?token=` query param and any Bearer header)
// and returns whether ANY of them grants access to `playlistId`.
export async function requestCanAccessPlaylist(
  c: Context<Env>,
  playlistId: string | null | undefined
): Promise<boolean> {
  const db = getDb(c.env.DB);
  const queryToken = c.req.query("token") || null;
  const bearer = bearerToken(c.req.header("Authorization"));

  for (const token of [queryToken, bearer]) {
    if (token && (await canAccessPlaylist(db, playlistId, { token }))) {
      return true;
    }
  }
  return false;
}
