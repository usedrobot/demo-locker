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
// Two serializers, not one with a flag:
//   - `publicTrack` is for share-facing and anonymous responses (playlist
//     reads via a share/invite token). It also strips `uploadedBy` — an
//     internal user UUID — since an anonymous listen-share holder should
//     never learn a collaborator's id just by viewing a playlist.
//   - `lockerTrack` is for authenticated, locker-scoped responses (the
//     track library, upload, and patch routes). Those readers are already
//     inside the locker, and Task 6's delete guard / Task 11's UI both need
//     `uploadedBy` to decide what a collaborator may delete.
// A boolean parameter here would let a caller flip it and leak the field
// through the wrong route by accident; two named functions can't.
//
// Both take a real track row (not `Record<string, unknown>`), so a caller
// that hands them something without these columns — e.g. an already-public
// track, or an unrelated object — is a compile error rather than a
// silently-inert Omit.

import type { tracks } from "../db/schema.js";

type TrackRow = typeof tracks.$inferSelect;

type WithStream = { hasStream: boolean };

export type PublicTrack = Omit<
  TrackRow,
  "originalKey" | "streamKey" | "uploadedBy"
> &
  WithStream;

export type LockerTrack = Omit<TrackRow, "originalKey" | "streamKey"> &
  WithStream;

export function publicTrack(row: TrackRow): PublicTrack {
  const { originalKey: _originalKey, streamKey, uploadedBy: _uploadedBy, ...rest } = row;
  return { ...rest, hasStream: streamKey != null };
}

export function lockerTrack(row: TrackRow): LockerTrack {
  const { originalKey: _originalKey, streamKey, ...rest } = row;
  return { ...rest, hasStream: streamKey != null };
}
