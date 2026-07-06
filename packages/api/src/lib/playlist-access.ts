// Single access-control seam for the legacy (non-`/public/v1`) playlist,
// track, and comment routes. Phase B publishes playlist IDs on the open web,
// so an unguessable ID is no longer a capability. A request may read/write
// private playlist data iff it presents:
//   (a) a valid session whose user OWNS the playlist, OR
//   (b) a valid, unexpired share/invite token that maps to the playlist.
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
import { playlists, sessions, shares } from "../db/schema.js";
import type { Env } from "../types.js";

type AccessCreds = {
  // Already-resolved session user (e.g. from a requireAuth-style middleware).
  sessionUser?: { id: string } | null;
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

  // (a) already-resolved owner session
  if (creds.sessionUser && creds.sessionUser.id === playlist.ownerId) {
    return true;
  }

  const token = creds.token;
  if (!token) return false;

  // (b) token as a share/invite token mapping to THIS playlist
  const [share] = await db
    .select({ expiresAt: shares.expiresAt })
    .from(shares)
    .where(and(eq(shares.token, token), eq(shares.playlistId, playlistId)))
    .limit(1);
  if (share && (!share.expiresAt || share.expiresAt >= new Date())) {
    return true;
  }

  // token as a session token whose user owns the playlist
  const [session] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.token, token))
    .limit(1);
  if (session && session.expiresAt >= new Date() && session.userId === playlist.ownerId) {
    return true;
  }

  return false;
}

// Convenience wrapper used by the six gated routes: pulls every candidate
// credential off the request (the `?token=` query param and any Bearer header)
// and returns whether ANY of them grants access to `playlistId`.
export async function requestCanAccessPlaylist(
  c: Context<Env>,
  playlistId: string | null | undefined
): Promise<boolean> {
  const db = getDb(c.env.DATABASE_URL);
  const queryToken = c.req.query("token") || null;
  const bearer = c.req.header("Authorization")?.replace("Bearer ", "") || null;

  for (const token of [queryToken, bearer]) {
    if (token && (await canAccessPlaylist(db, playlistId, { token }))) {
      return true;
    }
  }
  return false;
}
