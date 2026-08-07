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

export type PublicPlaylist = Omit<Record<string, unknown>, "createdBy">;

export function publicPlaylist<T extends Record<string, unknown>>(
  row: T
): PublicPlaylist {
  const { createdBy: _createdBy, ...rest } = row;
  return rest;
}
