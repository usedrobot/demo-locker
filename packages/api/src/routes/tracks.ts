import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tracks, playlists } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import type { Env } from "../types.js";

const tracksRouter = new Hono<Env>();

// Upload a track — receives the file directly, stores in R2
tracksRouter.post("/upload", requireAuth, async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const playlistId = formData.get("playlistId") as string | null;

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
  const title = file.name.replace(/\.[^.]+$/, "");
  const [track] = await db
    .insert(tracks)
    .values({
      playlistId,
      title,
      position,
      originalKey: key,
      streamKey: key, // serve original directly until transcoding is added
    })
    .returning();

  return c.json({ track }, 201);
});

// Stream a track from R2
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

  const object = await c.env.DEMOS_BUCKET.get(track.streamKey);
  if (!object) return c.json({ error: "file not found" }, 404);

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "audio/mpeg");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=3600");

  // handle range requests for seeking
  const range = c.req.header("Range");
  if (range && object.size) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : object.size - 1;
      const sliced = await c.env.DEMOS_BUCKET.get(track.streamKey, {
        range: { offset: start, length: end - start + 1 },
      });
      if (sliced) {
        headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
        headers.set("Content-Length", String(end - start + 1));
        return new Response(sliced.body, { status: 206, headers });
      }
    }
  }

  if (object.size) {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { headers });
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
