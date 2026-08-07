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
// no consumer can turn a UUID into a name. The only question a client asks of
// this column is "may I delete this track?", and `uploadedByMe` is exactly
// that question, answered without disclosing anything about anyone else.
//
// One serializer, not two. The previous split (`publicTrack` stripping the
// field, `lockerTrack` keeping it) existed solely because of `uploadedBy`, and
// it made `GET /playlists/:id` — which admits both anonymous share tokens and
// locker sessions through one gate — unable to serve either reader correctly.
// `actingUserId` is data, not a mode switch: it does not select WHICH fields
// are stripped (the strip list is unconditional), it supplies the value the
// comparison needs. Pass null for a reader with no session; they get false.
//
// Server-side authorisation never reads this. Delete guards compare
// `track.uploadedBy` from the database directly — a client-supplied
// `uploadedByMe` is not evidence of anything.
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
