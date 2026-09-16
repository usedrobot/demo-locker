// Every read and write of playlist_tracks. Routes call these rather than
// touching the join table directly, so the "a track is in N playlists" rule
// has one home.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { playlistTracks, tracks } from "../db/schema.js";
import type { TrackRow } from "./public-track.js";

export async function playlistIdsForTrack(db: Database, trackId: string): Promise<string[]> {
  const rows = await db
    .select({ playlistId: playlistTracks.playlistId })
    .from(playlistTracks)
    .where(eq(playlistTracks.trackId, trackId));
  return rows.map((r: { playlistId: string }) => r.playlistId);
}

// Membership for a whole set of tracks in one query, keyed by track id.
// Every id in `trackIds` is present in the map, possibly with an empty list.
export async function playlistIdsForTracks(
  db: Database,
  trackIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(trackIds.map((id) => [id, []]));
  if (trackIds.length === 0) return out;
  const rows = await db
    .select({ playlistId: playlistTracks.playlistId, trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(inArray(playlistTracks.trackId, trackIds));
  for (const r of rows as { playlistId: string; trackId: string }[]) {
    out.get(r.trackId)?.push(r.playlistId);
  }
  return out;
}

export type TrackInPlaylist = TrackRow & { position: number };

export async function tracksInPlaylist(db: Database, playlistId: string): Promise<TrackInPlaylist[]> {
  const rows = await db
    .select({ track: tracks, position: playlistTracks.position })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position));
  return rows.map((r: { track: TrackRow; position: number }) => ({ ...r.track, position: r.position }));
}

export async function nextPosition(db: Database, playlistId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${playlistTracks.position})` })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId));
  return row?.max == null ? 0 : Number(row.max) + 1;
}

// Returns true when a row was inserted, false when the track was already in
// the playlist. Never throws on the duplicate: callers treat re-adding as a
// no-op 200, not an error.
export async function addTrackToPlaylist(db: Database, playlistId: string, trackId: string): Promise<boolean> {
  const [existing] = await db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)))
    .limit(1);
  if (existing) return false;
  await db.insert(playlistTracks).values({
    playlistId,
    trackId,
    position: await nextPosition(db, playlistId),
  });
  return true;
}

export async function removeTrackFromPlaylist(db: Database, playlistId: string, trackId: string): Promise<void> {
  await db
    .delete(playlistTracks)
    .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)));
}
