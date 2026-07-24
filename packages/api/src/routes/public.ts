// Unauthenticated read-only API for playlists marked public.
// Rule: private and nonexistent are indistinguishable — same 404 body.

import { Hono, type Context } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { buildStreamResponse } from "../lib/stream-response.js";
import type { Env } from "../types.js";

const publicRouter = new Hono<Env>();

const NOT_FOUND = { error: "not found" } as const;

// Intermediaries must never cache a pre-publish or post-revocation 404.
function notFound(c: Context<Env>) {
  c.header("Cache-Control", "no-store");
  return c.json(NOT_FOUND, 404);
}

publicRouter.get("/playlists/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!playlist) return notFound(c);

  const trackRows = await db
    .select({
      id: tracks.id,
      title: tracks.title,
      duration: tracks.duration,
      waveformData: tracks.waveformData,
    })
    .from(tracks)
    .where(eq(tracks.playlistId, id))
    .orderBy(asc(tracks.position));

  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    playlist: {
      id: playlist.id,
      name: playlist.name,
      artworkUrl: playlist.artworkKey ? `/public/v1/playlists/${playlist.id}/artwork` : null,
      tracks: trackRows,
    },
  });
});

publicRouter.get("/playlists/:id/artwork", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!playlist || !playlist.artworkKey) return notFound(c);

  const object = await c.env.DEMOS_BUCKET.get(playlist.artworkKey);
  if (!object) return notFound(c);

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

publicRouter.get("/tracks/:id/stream", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const [row] = await db
    .select({ streamKey: tracks.streamKey })
    .from(tracks)
    .innerJoin(playlists, eq(tracks.playlistId, playlists.id))
    .where(and(eq(tracks.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!row || !row.streamKey) return notFound(c);

  return buildStreamResponse(c.req.header("Range"), c.env.DEMOS_BUCKET, row.streamKey);
});

export default publicRouter;
