// The one way tests insert tracks. Before migration 0007 every test wrote
// `playlistId` and `position` straight onto the track row; now membership is
// a join row per playlist, and this helper writes both so no test has to know.
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { tracks, playlistTracks } from "../db/schema.js";
import type { TrackRow } from "../lib/public-track.js";
import { nextPosition } from "../lib/playlist-membership.js";

type SeedTrackInput = {
  ownerId: string;
  title?: string;
  originalKey?: string;
  streamKey?: string | null;
  uploadedBy?: string | null;
  uploadedByName?: string | null;
  duration?: number | null;
  waveformData?: string | null;
  sizeBytes?: number | null;
  playlistIds?: string[];
};

let seq = 0;

export async function seedTrack(db: Database, input: SeedTrackInput): Promise<TrackRow> {
  seq += 1;
  const { playlistIds = [], ...cols } = input;
  const originalKey = cols.originalKey ?? `seed/${seq}`;
  const [track] = await db
    .insert(tracks)
    .values({
      title: cols.title ?? `track ${seq}`,
      originalKey,
      streamKey: cols.streamKey === undefined ? originalKey : cols.streamKey,
      ownerId: cols.ownerId,
      uploadedBy: cols.uploadedBy ?? null,
      uploadedByName: cols.uploadedByName ?? null,
      duration: cols.duration ?? null,
      waveformData: cols.waveformData ?? null,
      sizeBytes: cols.sizeBytes ?? null,
    })
    .returning();
  for (const playlistId of playlistIds) {
    await db.insert(playlistTracks).values({
      playlistId,
      trackId: track.id,
      position: await nextPosition(db, playlistId),
    });
  }
  return track;
}

// Read back a track's position inside one playlist, for assertions. Null when
// the track is not in that playlist.
export async function positionIn(db: Database, playlistId: string, trackId: string): Promise<number | null> {
  const [row] = await db
    .select({ position: playlistTracks.position })
    .from(playlistTracks)
    .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)))
    .limit(1);
  return row ? row.position : null;
}
