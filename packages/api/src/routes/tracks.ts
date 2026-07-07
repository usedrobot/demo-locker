import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tracks, playlists } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { requestCanAccessPlaylist } from "../lib/playlist-access.js";
import { buildStreamResponse } from "../lib/stream-response.js";
import type { Env } from "../types.js";

const tracksRouter = new Hono<Env>();

// Upload a track — receives the file directly, stores in R2
tracksRouter.post("/upload", requireAuth, async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const playlistId = formData.get("playlistId") as string | null;
  const customTitle = formData.get("title") as string | null;
  const waveformData = formData.get("waveformData") as string | null;
  const durationRaw = formData.get("duration") as string | null;
  const duration = durationRaw ? parseFloat(durationRaw) : null;

  if (!file || !playlistId) {
    return c.json({ error: "file and playlistId required" }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);
  const bucket = c.env.DEMOS_BUCKET;

  // verify playlist ownership
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== c.get("user").id) {
    return c.json({ error: "not found" }, 404);
  }

  // get next position
  const existing = await db
    .select({ position: tracks.position })
    .from(tracks)
    .where(eq(tracks.playlistId, playlistId))
    .orderBy(tracks.position);

  const position = existing.length > 0
    ? existing[existing.length - 1].position + 1
    : 0;

  const key = `${playlistId}/${crypto.randomUUID()}/${file.name}`;

  // store original in R2
  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "audio/mpeg" },
  });

  // create track — no transcoding for now, serve original
  const title =
    (customTitle && customTitle.trim()) ||
    file.name.replace(/\.[^.]+$/, "");
  const [track] = await db
    .insert(tracks)
    .values({
      playlistId,
      title,
      position,
      originalKey: key,
      streamKey: key, // serve original directly until transcoding is added
      waveformData: waveformData || null,
      duration: duration && isFinite(duration) ? duration : null,
    })
    .returning();

  return c.json({ track }, 201);
});

// Stream a track from R2 — gated by the parent playlist. <audio> can't send an
// Authorization header, so a `?token=` query param (session OR share token) is
// also accepted (see lib/playlist-access.ts). Public playlists stream anonymously
// via the separate /public/v1/tracks/:id/stream route.
tracksRouter.get("/:id/stream", async (c) => {
  const trackId = c.req.param("id");
  const db = getDb(c.env.DATABASE_URL);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track || !track.streamKey) {
    return c.json({ error: "not found" }, 404);
  }

  if (!(await requestCanAccessPlaylist(c, track.playlistId))) {
    return c.json({ error: "not found" }, 404);
  }

  return buildStreamResponse(
    c.req.header("Range"),
    c.env.DEMOS_BUCKET,
    track.streamKey,
    "private, max-age=3600"
  );
});

// Delete a track
tracksRouter.delete("/:id", requireAuth, async (c) => {
  const trackId = c.req.param("id");
  const db = getDb(c.env.DATABASE_URL);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track) return c.json({ error: "not found" }, 404);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, track.playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== c.get("user").id) {
    return c.json({ error: "not found" }, 404);
  }

  // delete from R2
  await c.env.DEMOS_BUCKET.delete(track.originalKey);
  if (track.streamKey && track.streamKey !== track.originalKey) {
    await c.env.DEMOS_BUCKET.delete(track.streamKey);
  }

  await db.delete(tracks).where(eq(tracks.id, trackId));
  return c.json({ ok: true });
});

export default tracksRouter;
