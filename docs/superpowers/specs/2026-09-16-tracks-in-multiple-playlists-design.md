# Tracks in multiple playlists

Date: 2026-09-16. Status: design, awaiting DL's review.

## Problem

A track lives in at most one playlist. This is structural, not a policy:
`tracks.playlist_id` is a single nullable foreign key (migration 0003) and
`tracks.position` sits on the track row itself. DL wants the same demo to sit in
several playlists, for example a rough-mix reel and a per-client selection, and
the playlist page's add-from-library picker currently hides every track that
is already in some other playlist.

## Decisions taken with DL

- Adding a track to a playlist happens from inside the playlist, via the
  existing add picker. That picker must list every library track that is not
  already in this playlist, regardless of how many other playlists hold it.
- The remove control inside a playlist removes the track from that playlist
  only. The track stays in every other playlist and in the library. Deleting
  the file itself stays a library action behind a confirm.
- Play counts are a follow-up branch. Their shape is noted at the end so the
  schema here does not have to change again.

## Approach

Replace the pointer with a join table. Rejected alternatives:

- Keep `tracks.playlist_id` as a "primary" playlist plus a side table for the
  rest. Two sources of truth; every access check would have to consult both.
- Copy the track row per playlist. Comments, storage accounting and the library
  all key on one track row.

## Schema: migration 0007

New table `playlist_tracks`:

| column | type | notes |
|---|---|---|
| playlist_id | text | FK playlists.id, ON DELETE CASCADE |
| track_id | text | FK tracks.id, ON DELETE CASCADE |
| position | integer | not null, order within this playlist |
| added_at | integer (timestamp_ms) | not null, default now |

Primary key `(playlist_id, track_id)`, so a track appears at most once per
playlist. Index on `track_id` for the access checks that walk from a track to
its playlists.

Migration steps, in one migration file:

1. Create the table.
2. Backfill: one row per track whose `playlist_id` is not null, copying
   `position` and using `uploaded_at` as `added_at`.
3. Drop `playlist_id` and `position` from `tracks`.

Deleting a playlist cascades its join rows and leaves the tracks in the
library, the same outcome as today's SET NULL. Deleting a track cascades its
join rows.

The Drizzle schema in `packages/api/src/db/schema.ts` gains a `playlistTracks`
table and loses the two columns on `tracks`. The CLI's mirrored migrations in
`packages/cli/assets/migrations/` get the same file.

## API

Routes in `packages/api/src/routes/`.

New:

- `POST /playlists/:id/tracks` body `{ trackId }`. Requires upload rights on
  the playlist (the same check upload uses, `requestCanUploadToPlaylist`).
  The track must belong to the same locker as the playlist, else 404. Position
  is appended. Adding a track that is already present returns 200 with no
  change.
- `DELETE /playlists/:id/tracks/:trackId`. Same rights check. Removes the join
  row only. Removing a track from its last playlist leaves it in the library;
  nothing else happens.

Changed:

- `POST /tracks/upload` with a `playlistId` inserts the track and one join
  row. Without one it inserts the track alone, as now.
- `PATCH /playlists/:id/reorder` updates `playlist_tracks.position` where
  `playlist_id = :id` and `track_id` is each id in turn. The scoping guard
  (playlists.ts, comment above the loop) is preserved exactly: edit rights on
  one playlist cannot rewrite positions in another.
- `GET /playlists/:id` and `GET /public/v1/playlists/:id` join through
  `playlist_tracks` ordered by `position`. Response shape unchanged.
- `GET /tracks` (library) returns each track with `playlistIds: string[]`.
  The web app uses this for the picker filter and for showing membership on
  the main page.
- `DELETE /playlists/:id` unchanged in behaviour; the cascade does the work.

Retired:

- `PATCH /tracks/:id` with `{ playlistId }`. Its two callers (the picker and
  the remove control) move to the new routes. Returns 410 for one release so a
  stale web bundle fails loudly rather than silently.

### Access checks

Today stream, download and comment access walk from a track to its one
playlist (`tracks.ts` around lines 211 and 269, `comments.ts` around line
66). With many-to-many the rule becomes:

> The requester may reach a track if they own or collaborate on its locker, or
> if any playlist containing the track is reachable to them (session or share
> token).

Implemented once in `packages/api/src/lib/playlist-access.ts` as
`requestCanAccessTrack(c, trackId)` and used by all three call sites. Share
tokens stay per playlist; a listen link to playlist A must not expose a track
through playlist B. The check therefore iterates the track's playlists and
tests each against the requester's tokens, rather than testing "any share for
this track".

Comments: a track comment is attached to the track and shows in every playlist
that holds it. A playlist comment (no track id) stays on its playlist. The
`comments.playlist_id` column keeps that meaning unchanged.

## Web

`packages/web/src/`.

- `pages/PlaylistView.tsx`: the picker filters library tracks by
  `!t.playlistIds.includes(playlistId)` instead of `t.playlistId === null`.
  `addTrack` calls the new add route.
- `components/TrackList.tsx`: `handleRemove` calls the new remove route. Copy
  already says "remove from this playlist"; it stays.
- `pages/Home.tsx`: each library track shows the names of the playlists it is
  in, small and dim, so DL can see membership at a glance. Needs playlist
  names, which the page already loads.
- `lib/api.ts`: `attach` goes away; `playlists.addTrack` and
  `playlists.removeTrack` arrive. `Track` type gains `playlistIds`.

## Embed player

`packages/player/src/player.ts` fetches the public playlist endpoint by the
`playlist` attribute and reads tracks from the response. The response shape
does not change, so no player release is expected. Verification step: run the
player against a playlist that shares a track with another playlist and
confirm it lists and streams normally.

## Testing

Vitest in `packages/api`:

- Add a track to two playlists; both list it in their own order.
- Remove from one; the other still lists it. Remove from the last; the track
  still appears in the library.
- Reorder with an id from another playlist leaves that playlist's positions
  untouched.
- Stream with a listen token for playlist A on a track that is in A and B
  succeeds; the same token on a track only in B is 404.
- Track comments on a shared track appear under both playlists.
- Backfill: a fixture with tracks in playlists and in the library migrates to
  the matching join rows and an equal count.

Vitest in `packages/web`: picker lists library tracks absent from the current
playlist and hides ones already present.

## Rollout

1. Merge on its own branch, off `main`.
2. Export the dlisok D1 before applying migration 0007 there. Confirm the join
   row count equals the pre-migration count of tracks with a playlist before
   the column drop, and abort if not.
3. Cut a CLI release so self-hosters pick up the migration. DL tags releases.

## Follow-up: play counts

Not in this branch. Planned shape so nothing here has to move:

`plays` table: `id`, `track_id` (FK cascade), `playlist_id` (nullable, FK set
null), `listener_key` (hash of session or share token), `played_at`. One row
per play once the player passes a threshold (30 s or half the track, whichever
is smaller). Main page: count per track. Playlist view: count per track where
`playlist_id` matches. Owner-play dedupe is an open question for that branch.
