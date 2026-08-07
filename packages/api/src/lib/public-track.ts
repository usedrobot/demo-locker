// Strip server-only fields from a track row before it goes to a client, the
// same way publicComment() strips deleteToken.
//
// originalKey/streamKey are bucket coordinates. Handing them to every client
// with read access — including listen-only share holders — published the
// storage layout and gave anyone who kept a copy a durable handle on the
// object, which is half of what made the artworkKey read primitive exploitable.
// Nothing outside the API ever needed the values: the web client only asked
// "is there a stream yet", which `hasStream` answers.
//
// `uploadedBy` is stripped for EVERY reader, and replaced by the computed
// per-request boolean `uploadedByMe`. A locker can hold several collaborators,
// so serializing the raw column let collaborator A harvest collaborator B's
// internal user UUID off B's uploads — and nothing else in this API exposes
// another user's id. The id was also useless to the client that received it:
// no consumer can turn a UUID into a name. What a client can actually use is
// the one bit the id was being reduced to anyway: is this row mine? That is
// what `uploadedByMe` answers, and it discloses nothing about anyone else.
//
// One serializer, not two. The previous split (`publicTrack` stripping the
// field, `lockerTrack` keeping it) existed solely because of `uploadedBy`, and
// it made `GET /playlists/:id` — which admits both anonymous share tokens and
// locker sessions through one gate — unable to serve either reader correctly.
// `actingUserId` is data, not a mode switch: it does not select WHICH fields
// are stripped (the strip list is unconditional), it supplies the value the
// comparison needs. Pass null for a reader with no session; they get false.
//
// `uploadedByMe` is ATTRIBUTION, not permission. It says whether the
// requesting session uploaded this track. It is not delete authority and must
// not be read as such — today it is close to the inverse of it. The DELETE
// guard below in routes/tracks.ts compares `track.ownerId` to the acting user,
// so a collaborator holding `uploadedByMe: true` on their own upload is still
// 404'd, while the locker owner — who can delete anything in the locker — sees
// `false` on every row a collaborator uploaded. A client rendering a delete
// affordance needs `uploadedByMe` OR locker ownership; this field alone has
// never been the answer.
//
// Nothing server-side reads it in either direction. Authorisation is decided
// from stored columns on every request; a client-supplied `uploadedByMe` is
// not evidence of anything.
//
// False is ambiguous by construction, and callers must not render it as
// "someone else uploaded this". It is also false when no uploader is recorded
// at all — rows predating the column, or an uploader since removed (the FK is
// ON DELETE SET NULL) — and when the requester has no identity to compare,
// which includes an anonymous edit-share holder receiving the 201 for their
// OWN upload.
//
// Takes a real track row (not `Record<string, unknown>`), so a caller that
// hands it something without these columns — e.g. an already-public track, or
// an unrelated object — is a compile error rather than a silently-inert Omit.

import type { tracks } from "../db/schema.js";

// Exported because the drizzle select builders these rows come from widen to
// `any` at the call sites, so `.map((t) => ...)` there has no contextual type.
// Annotating the callback parameter with this is what keeps the row shape
// actually checked rather than silently inferred away.
export type TrackRow = typeof tracks.$inferSelect;

export type PublicTrack = Omit<
  TrackRow,
  "originalKey" | "streamKey" | "uploadedBy"
> & {
  hasStream: boolean;
  uploadedByMe: boolean;
};

export function publicTrack(
  row: TrackRow,
  actingUserId: string | null
): PublicTrack {
  const {
    originalKey: _originalKey,
    streamKey,
    uploadedBy,
    ...rest
  } = row;
  return {
    ...rest,
    hasStream: streamKey != null,
    // An anonymous share holder has no id, so nothing can be theirs. Never
    // let a null actingUserId match a null uploadedBy.
    uploadedByMe: actingUserId != null && uploadedBy === actingUserId,
  };
}
