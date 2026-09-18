// Unauthenticated read-only API for playlists marked public.
// Rule: private and nonexistent are indistinguishable — same 404 body.

import { Hono, type Context } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, playlistTracks, tracks } from "../db/schema.js";
import { buildStreamResponse } from "../lib/stream-response.js";
import { recordPlay } from "../lib/plays.js";
import { INERT_CONTENT_HEADERS, safeImageType } from "../lib/media-type.js";
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
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .where(eq(playlistTracks.playlistId, id))
    .orderBy(asc(playlistTracks.position));

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

  // The anonymous route, so the most exposed one: an artwork stored as
  // text/html was served from the instance's own origin, where the web app's
  // session token lives in localStorage.
  return new Response(object.body, {
    headers: {
      ...INERT_CONTENT_HEADERS,
      "Content-Type": safeImageType(object.httpMetadata?.contentType),
      "Cache-Control": "public, max-age=3600",
    },
  });
});

publicRouter.get("/tracks/:id/stream", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  // Public iff ANY playlist holding the track is public.
  const [row] = await db
    .select({ streamKey: tracks.streamKey })
    .from(tracks)
    .innerJoin(playlistTracks, eq(playlistTracks.trackId, tracks.id))
    .innerJoin(playlists, eq(playlistTracks.playlistId, playlists.id))
    .where(and(eq(tracks.id, id), eq(playlists.isPublic, true)))
    .limit(1);
  if (!row || !row.streamKey) return notFound(c);

  return buildStreamResponse(c.req.header("Range"), c.env.DEMOS_BUCKET, row.streamKey);
});

// Anonymous play record, the twin of POST /tracks/:id/plays for the share
// page and the embed player. Same gate as the public stream: the track must
// be in at least one public playlist. A playlistId is only attributed when it
// names a PUBLIC playlist the track is in — naming a private one is not a way
// to learn it exists, nor to inflate its count.
publicRouter.post("/tracks/:id/plays", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const publicPlaylistIds = (
    await db
      .select({ playlistId: playlists.id })
      .from(playlistTracks)
      .innerJoin(playlists, eq(playlistTracks.playlistId, playlists.id))
      .where(and(eq(playlistTracks.trackId, id), eq(playlists.isPublic, true)))
  ).map((r: { playlistId: string }) => r.playlistId);
  if (publicPlaylistIds.length === 0) return notFound(c);

  const body = await c.req.json().catch(() => ({}));
  const requested = typeof body?.playlistId === "string" ? body.playlistId : null;
  const playlistId = requested && publicPlaylistIds.includes(requested) ? requested : null;
  await recordPlay(db, id, playlistId);
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true }, 201);
});

export default publicRouter;
