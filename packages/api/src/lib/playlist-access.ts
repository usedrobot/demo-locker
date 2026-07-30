// Single access-control seam for the legacy (non-`/public/v1`) playlist,
// track, and comment routes. Phase B publishes playlist IDs on the open web,
// so an unguessable ID is no longer a capability. A request may read/write
// private playlist data iff it presents a valid, unexpired session or
// share/invite token that maps to the playlist (a session token only grants
// access when it belongs to the playlist's owner).
//
// NOTE on the data model: `shares` has no user column — "collaborators" are
// represented entirely by share tokens (shares.playlistId -> token), which map
// 1:1 to a playlist. There is no collaborator-*user* relation, so the only
// session-based access is ownership; every other grant is via a share token.
//
// Callers must translate a `false` result into the same non-enumerable
// `{ error: "not found" }` 404 the public API uses — never 401/403.

import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb, type Database } from "../db/index.js";
import { playlists, shares } from "../db/schema.js";
import { bearerToken, findSession } from "./session.js";
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

  // token as a session token whose user owns the playlist
  const session = await findSession(db, token);
  if (session && session.expiresAt >= new Date() && session.userId === playlist.ownerId) {
    return true;
  }

  return false;
}

// EDIT capability: the playlist owner's session, or a share token whose
// permission is "edit" (and not expired). Grants upload + reorder on that
// playlist. Returns the ownerId when allowed (uploads by collaborators are
// attributed to the locker owner), or null when denied.
export async function requestCanEditPlaylist(
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
    if (
      session &&
      session.expiresAt >= new Date() &&
      session.userId === playlist.ownerId
    ) {
      return playlist.ownerId;
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

// Resolve the request's session user (from `?token=` or Bearer), if any.
// Used for resources gated on ownership alone, e.g. library tracks that are
// not in any playlist.
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
