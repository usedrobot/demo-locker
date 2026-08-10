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
// not be read as such. The DELETE guard in routes/tracks.ts is locker
// ownership OR own-upload: the locker owner may delete anything in the locker,
// a collaborator only a row whose `uploadedBy` is theirs. So the locker owner
// sees `false` on every row a collaborator uploaded and may delete all of them
// anyway. A client rendering a delete affordance needs `uploadedByMe ||
// isOwner`; this field alone has never been the answer.
//
// For a collaborator the two now coincide — the tracks they may delete are
// exactly the ones this field is true for. That is a coincidence of the rule,
// not a licence to treat the field as the rule: the server decides from
// `tracks.uploaded_by` and the acting user, and a client that hard-codes
// "uploadedByMe means deletable" is wrong the moment it renders for the owner.
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
// `uploadedByName` is the same attribution said out loud, and it is what the
// booleans above could never say: with two songwriters in one locker, "not
// mine" does not identify whose demo it is. It is a NAME, resolved server-side
// from users.display_name (falling back to the email) — see
// lib/display-name.ts. It is not the id under another key: it cannot be used to
// address a user, and it does not vary per row the way a UUID does.
//
// Null when there is no attribution to show, and it must render as NOTHING —
// never "null", never "unknown". That covers a row predating the column and a
// reader with no locker session, who is given no names at all (see
// resolveDisplayNames).
//
// An uploader since REMOVED no longer falls in that hole. Removing a
// collaborator deletes their account, so uploaded_by goes SET NULL and the live
// lookup has nothing to find — which used to blank the name off every demo they
// left in the locker. `tracks.uploaded_by_name` is the name as it read at the
// moment they were removed, written there by DELETE /collab/members/:id, and it
// is the fallback for exactly that case. Live account first: while the person
// is still here their current name wins, so a rename propagates and the
// snapshot can never go stale behind it.
//
// The snapshot column is stripped from the response like uploadedBy is, and the
// field below is computed — so the fallback goes through the same session gate
// as the live name rather than around it. A reader with no locker session gets
// nothing by either path.
//
// It is attribution exactly as `uploadedByMe` is, with the same warning
// attached: it is not delete authority, and a client must not derive one from
// it. It is also present on the caller's OWN rows — deciding to render those as
// "you" is the client's job, not this serializer's.
//
// Takes a real track row (not `Record<string, unknown>`), so a caller that
// hands it something without these columns — e.g. an already-public track, or
// an unrelated object — is a compile error rather than a silently-inert Omit.

import type { tracks } from "../db/schema.js";
import { type DisplayNames } from "./display-name.js";

// Exported because the drizzle select builders these rows come from widen to
// `any` at the call sites, so `.map((t) => ...)` there has no contextual type.
// Annotating the callback parameter with this is what keeps the row shape
// actually checked rather than silently inferred away.
export type TrackRow = typeof tracks.$inferSelect;

export type PublicTrack = Omit<
  TrackRow,
  "originalKey" | "streamKey" | "uploadedBy" | "uploadedByName"
> & {
  hasStream: boolean;
  uploadedByMe: boolean;
  uploadedByName: string | null;
};

export function publicTrack(
  row: TrackRow,
  actingUserId: string | null,
  names: DisplayNames
): PublicTrack {
  const {
    originalKey: _originalKey,
    streamKey,
    uploadedBy,
    uploadedByName: departedName,
    ...rest
  } = row;
  return {
    ...rest,
    hasStream: streamKey != null,
    // An anonymous share holder has no id, so nothing can be theirs. Never
    // let a null actingUserId match a null uploadedBy.
    uploadedByMe: actingUserId != null && uploadedBy === actingUserId,
    // `names.allowed` is the membership gate, checked here as well as in
    // resolveDisplayNames, so a route that resolves names and then serves them
    // to a reader outside the locker cannot do so by accident. It covers BOTH
    // paths deliberately: the departed member's snapshot comes off the row, not
    // out of the map, so gating on the map alone would have handed an outsider
    // a name the map never contained. Absent from the map — an id the lookup
    // did not cover, including an uploader who is not in this locker — reads as
    // no attribution rather than as a stale name.
    uploadedByName: !names.allowed
      ? null
      : uploadedBy != null
        ? names.byId.get(uploadedBy) ?? null
        : departedName,
  };
}
