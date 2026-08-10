// Strip the server-only field from a share row before it goes to a client —
// the same pattern, and the same reasoning, as publicTrack() and
// publicPlaylist().
//
// `createdBy` is stripped for EVERY reader and replaced by the computed
// per-request boolean `mintedByMe`. It is an internal user UUID (the locker
// member who minted the link), and a locker may hold several collaborators,
// none of whom may learn another's user id — the invariant spelled out in
// lib/public-track.ts. The column exists so the database can cascade a
// departing collaborator's links away (shares.created_by is ON DELETE
// CASCADE), not so a client can read it.
//
// What a client actually needs is the one bit the id was being reduced to: is
// this link mine? Nothing showed the owner WHO handed out a given link, so a
// locker with collaborators presented a list of grants with no way to tell
// which ones were the owner's own — and removing a collaborator silently takes
// theirs away with them.
//
// `mintedByMe` is ATTRIBUTION, not permission. Share links are locker-level
// state: any member may revoke or re-permission any link regardless of who
// minted it (see routes/shares.ts), so this must not be rendered as, or turned
// into, a control gate. Nothing server-side reads it back — authorisation is
// decided from stored columns on every request.
//
// False is ambiguous by construction and must not be rendered as "a
// collaborator minted this" on a locker that has none: it is also false when no
// minter is recorded (a state migration 0004 backfilled away, so it should not
// occur) and when the requester has no identity to compare.
//
// Generic over the row rather than typed to the full share row, because the
// routes select two different projections through here — one with the joined
// playlist name, one without — and both must keep their exact shapes.

export function publicShare<T extends { createdBy: string | null }>(
  row: T,
  actingUserId: string | null
): Omit<T, "createdBy"> & { mintedByMe: boolean } {
  const { createdBy, ...rest } = row;
  return {
    ...rest,
    // Never let a null actingUserId match a null createdBy.
    mintedByMe: actingUserId != null && createdBy === actingUserId,
  };
}
