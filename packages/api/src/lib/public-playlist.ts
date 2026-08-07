// Strip server-only fields from a playlist row before it goes to a client
// that may not be a locker member — the same pattern as publicTrack().
//
// createdBy is an internal user UUID (the collaborator who created the
// playlist, per Task 3). Handing it to every reader — including an
// anonymous listen/edit-share holder on `GET /playlists/:id` or the invite
// view — leaks a collaborator's identity to someone who otherwise never
// learns it exists. Use this on share-facing responses only; locker-scoped
// authenticated responses (list, create, patch, artwork upload) may return
// the raw row.
//
// ownerId and artworkKey also leak on these same responses (a raw user id,
// a bucket pointer) but predate this branch — deliberately left alone here
// so they get fixed in one sweep rather than piecemeal.
//
// Typed against the real playlists row (not Record<string, unknown>), so a
// route that hands this an object missing these columns — or the wrong
// object entirely — is a compile error, same as publicTrack.

import type { playlists } from "../db/schema.js";

type PlaylistRow = typeof playlists.$inferSelect;

export type PublicPlaylist = Omit<PlaylistRow, "createdBy">;

export function publicPlaylist(row: PlaylistRow): PublicPlaylist {
  const { createdBy: _createdBy, ...rest } = row;
  return rest;
}
