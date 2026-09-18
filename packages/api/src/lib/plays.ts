// Every read and write of the plays table, the way playlist-membership.ts
// owns playlist_tracks.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { plays, playlistTracks } from "../db/schema.js";

// Record one play of `trackId`. `playlistId` is what the client says it was
// playing from; it is kept only when the track really is in that playlist,
// otherwise the row is a library play. The caller has already decided the
// requester may reach the track (and, for the public route, that the playlist
// is one they may name) — this function does not gate.
export async function recordPlay(
  db: Database,
  trackId: string,
  playlistId: string | null
): Promise<void> {
  let attributed: string | null = null;
  if (playlistId) {
    const [member] = await db
      .select({ trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)))
      .limit(1);
    if (member) attributed = playlistId;
  }
  await db.insert(plays).values({ trackId, playlistId: attributed });
}

// Total plays per track (any playlist or none), one query. Every id in
// `trackIds` is present in the map, possibly as 0.
export async function playCountsForTracks(
  db: Database,
  trackIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>(trackIds.map((id) => [id, 0]));
  if (trackIds.length === 0) return out;
  const rows = await db
    .select({ trackId: plays.trackId, n: sql<number>`count(*)` })
    .from(plays)
    .where(inArray(plays.trackId, trackIds))
    .groupBy(plays.trackId);
  for (const r of rows as { trackId: string; n: number }[]) out.set(r.trackId, Number(r.n));
  return out;
}

// Plays that came through ONE playlist, per track. Tracks with no plays in
// that playlist are absent; callers default to 0.
export async function playCountsInPlaylist(
  db: Database,
  playlistId: string
): Promise<Map<string, number>> {
  const rows = await db
    .select({ trackId: plays.trackId, n: sql<number>`count(*)` })
    .from(plays)
    .where(eq(plays.playlistId, playlistId))
    .groupBy(plays.trackId);
  return new Map((rows as { trackId: string; n: number }[]).map((r) => [r.trackId, Number(r.n)]));
}
