// Unauthenticated read-only API for playlists marked public.
// Rule: private and nonexistent are indistinguishable — same 404 body.

import { Hono } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { buildStreamResponse } from "../lib/stream-response.js";
import type { Env } from "../types.js";

const publicRouter = new Hono<Env>();

const NOT_FOUND = { error: "not found" } as const;

publicRouter.get("/playlists/:id", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!playlist) return c.json(NOT_FOUND, 404);

  const trackRows = await db
    .select({ id: tracks.id, title: tracks.title, duration: tracks.duration })
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
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!playlist || !playlist.artworkKey) return c.json(NOT_FOUND, 404);

  const object = await c.env.DEMOS_BUCKET.get(playlist.artworkKey);
  if (!object) return c.json(NOT_FOUND, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

publicRouter.get("/tracks/:id/stream", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

  const [row] = await db
    .select({ streamKey: tracks.streamKey })
    .from(tracks)
    .innerJoin(playlists, eq(tracks.playlistId, playlists.id))
    .where(and(eq(tracks.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!row || !row.streamKey) return c.json(NOT_FOUND, 404);

  return buildStreamResponse(c.req.header("Range"), c.env.DEMOS_BUCKET, row.streamKey);
});

export default publicRouter;
