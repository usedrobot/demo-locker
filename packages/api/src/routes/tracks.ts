import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { tracks, playlists } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { getUploadUrl, getDownloadUrl, getObjectStream, putObject } from "../lib/storage.js";
import { transcodeToAAC, generateWaveform } from "../lib/transcode.js";
import type { Env } from "../types.js";

const tracksRouter = new Hono<Env>();

// Get a presigned upload URL
tracksRouter.post("/upload-url", requireAuth, async (c) => {
  const { playlistId, filename, contentType } = await c.req.json();

  if (!playlistId || !filename || !contentType) {
    return c.json({ error: "playlistId, filename, and contentType required" }, 400);
  }

  // verify playlist ownership
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== c.get("user").id) {
    return c.json({ error: "not found" }, 404);
  }

  const key = `originals/${playlistId}/${randomBytes(8).toString("hex")}/${filename}`;
  const url = await getUploadUrl(key, contentType);

  // get next position
  const existing = await db
    .select({ position: tracks.position })
    .from(tracks)
    .where(eq(tracks.playlistId, playlistId))
    .orderBy(tracks.position);

  const position = existing.length > 0
    ? existing[existing.length - 1].position + 1
    : 0;

  // create track record (pending processing)
  const [track] = await db
    .insert(tracks)
    .values({
      playlistId,
      title: filename.replace(/\.[^.]+$/, ""),
      position,
      originalKey: key,
    })
    .returning();

  return c.json({ uploadUrl: url, track });
});

// Confirm upload and trigger processing
tracksRouter.post("/:id/confirm", requireAuth, async (c) => {
  const trackId = c.req.param("id");

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track) return c.json({ error: "not found" }, 404);

  // verify ownership through playlist
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, track.playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== c.get("user").id) {
    return c.json({ error: "not found" }, 404);
  }

  // process in background (don't block the response)
  processTrack(track.id, track.originalKey).catch((err) => {
    console.error(`failed to process track ${track.id}:`, err);
  });

  return c.json({ ok: true, message: "processing started" });
});

// Get stream URL for a track
tracksRouter.get("/:id/stream", async (c) => {
  const trackId = c.req.param("id");

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track || !track.streamKey) {
    return c.json({ error: "not found or not yet processed" }, 404);
  }

  const url = await getDownloadUrl(track.streamKey);
  return c.json({ url });
});

async function processTrack(trackId: string, originalKey: string) {
  // download original from S3
  const stream = await getObjectStream(originalKey);
  if (!stream) throw new Error("original file not found in storage");

  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const inputBuffer = Buffer.concat(chunks);

  // transcode to AAC
  const { buffer: aacBuffer, duration } = await transcodeToAAC(inputBuffer);

  // generate waveform
  const waveformData = await generateWaveform(inputBuffer);

  // upload transcoded file
  const streamKey = originalKey.replace("originals/", "streams/").replace(/\.[^.]+$/, ".m4a");
  await putObject(streamKey, aacBuffer, "audio/mp4");

  // update track record
  await db
    .update(tracks)
    .set({
      streamKey,
      duration,
      waveformData: JSON.stringify(waveformData),
    })
    .where(eq(tracks.id, trackId));

  console.log(`track ${trackId} processed: ${duration}s`);
}

export default tracksRouter;
