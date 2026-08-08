// Strip server-only fields from a playlist row before it goes to a client —
// the same pattern, and the same reasoning, as publicTrack().
//
// `createdBy` is stripped for EVERY reader and replaced by the computed
// per-request boolean `createdByMe`. It is an internal user UUID (the locker
// member who created the playlist, per Task 3), and a locker may hold several
// collaborators, none of whom may learn another's user id — the invariant
// spelled out in lib/public-track.ts. Serializing the raw column let
// collaborator A harvest collaborator B's id off a playlist B created, and
// handed the same id to anonymous listen/edit-share holders and the invite
// view, who otherwise never learn a collaborator exists. The id was useless to
// every one of them: no consumer can turn a UUID into a name. The one bit it
// was being reduced to — is this row mine? — is what `createdByMe` answers,
// and it discloses nothing about anyone else.
//
// One serializer, not two. Locker-scoped reads (list, create, patch, artwork
// upload) and share-facing reads (GET /playlists/:id, the invite view) all go
// through here. `actingUserId` is data, not a mode switch: it does not select
// WHICH fields are stripped — the strip list is unconditional — it supplies
// the value the comparison needs. Pass null for a reader with no session;
// they get false.
//
// `createdByMe` is ATTRIBUTION, not permission, exactly as `uploadedByMe` is.
// DELETE /playlists/:id authorises on locker ownership OR own-creation, so the
// locker owner sees `false` on every playlist a collaborator created and may
// delete all of them anyway. The client rule is `createdByMe || isOwner`.
// Nothing server-side reads the field back: authorisation is decided from
// stored columns on every request.
//
// False is ambiguous by construction and must not be rendered as "someone else
// created this". It is also false when no creator is recorded at all — rows
// predating the column — and when the requester has no identity to compare,
// which includes every anonymous share holder.
//
// ownerId and artworkKey also leak on these same responses (a raw user id,
// a bucket pointer) but predate this branch — deliberately left alone here
// so they get fixed in one sweep rather than piecemeal.
//
// `createdByName` is the counterpart of publicTrack's `uploadedByName`, with
// the same reasoning and the same rules: a NAME resolved server-side from
// users.display_name (falling back to the email, see lib/display-name.ts), not
// the id under a new key; null when there is nothing to attribute, and null for
// a reader with no locker session; attribution rather than permission; present
// on the caller's own rows, which the client renders as "you".
//
// And the same two-step resolution: the live account first, then
// `playlists.created_by_name` — the creator's name as it read when they were
// removed from the locker, written by DELETE /collab/members/:id just before
// created_by goes SET NULL. The snapshot column is stripped from the response
// and the field is computed, so the fallback passes through the session gate
// rather than around it: a reader with no locker session is served neither.
//
// Typed against the real playlists row (not Record<string, unknown>), so a
// route that hands this an object missing these columns — or the wrong
// object entirely — is a compile error, same as publicTrack.

import type { playlists } from "../db/schema.js";
import { type DisplayNames } from "./display-name.js";

export type PlaylistRow = typeof playlists.$inferSelect;

export type PublicPlaylist = Omit<PlaylistRow, "createdBy" | "createdByName"> & {
  createdByMe: boolean;
  createdByName: string | null;
};

export function publicPlaylist(
  row: PlaylistRow,
  actingUserId: string | null,
  names: DisplayNames
): PublicPlaylist {
  const { createdBy, createdByName: departedName, ...rest } = row;
  return {
    ...rest,
    // An anonymous share holder has no id, so nothing can be theirs. Never
    // let a null actingUserId match a null createdBy.
    createdByMe: actingUserId != null && createdBy === actingUserId,
    // Gated on the session here as well as in resolveDisplayNames — see the
    // matching note in lib/public-track.ts.
    createdByName:
      actingUserId == null
        ? null
        : createdBy != null
          ? names.get(createdBy) ?? null
          : departedName,
  };
}
