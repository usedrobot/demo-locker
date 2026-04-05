import { Hono } from "hono";
import { eq, and, isNull, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { comments, tracks, playlists } from "../db/schema.js";
import type { Env } from "../types.js";

const commentsRouter = new Hono<Env>();

commentsRouter.post("/", async (c) => {
  const { trackId, playlistId, authorName, body, timestampSec, parentId } =
    await c.req.json();

  if (!authorName || !body) {
    return c.json({ error: "authorName and body required" }, 400);
  }
  if (!trackId && !playlistId) {
    return c.json({ error: "trackId or playlistId required" }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);

  if (trackId) {
    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    if (!track) return c.json({ error: "track not found" }, 404);
  }
  if (playlistId && !trackId) {
    const [playlist] = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .limit(1);
    if (!playlist) return c.json({ error: "playlist not found" }, 404);
  }

  const [comment] = await db
    .insert(comments)
    .values({
      trackId: trackId || null,
      playlistId: playlistId || null,
      authorName,
      body,
      timestampSec: trackId ? (timestampSec ?? null) : null,
      parentId: parentId || null,
    })
    .returning();

  return c.json({ comment }, 201);
});

commentsRouter.get("/track/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  const db = getDb(c.env.DATABASE_URL);

  const all = await db
    .select()
    .from(comments)
    .where(eq(comments.trackId, trackId))
    .orderBy(asc(comments.createdAt));

  const topLevel = all.filter((row: any) => !row.parentId);
  const replies = all.filter((row: any) => row.parentId);

  const threaded = topLevel.map((comment: any) => ({
    ...comment,
    replies: replies.filter((r: any) => r.parentId === comment.id),
  }));

  return c.json({ comments: threaded });
});

commentsRouter.get("/playlist/:playlistId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const db = getDb(c.env.DATABASE_URL);

  const all = await db
    .select()
    .from(comments)
    .where(
      and(eq(comments.playlistId, playlistId), isNull(comments.trackId))
    )
    .orderBy(asc(comments.createdAt));

  const topLevel = all.filter((row: any) => !row.parentId);
  const replies = all.filter((row: any) => row.parentId);

  const threaded = topLevel.map((comment: any) => ({
    ...comment,
    replies: replies.filter((r: any) => r.parentId === comment.id),
  }));

  return c.json({ comments: threaded });
});

export default commentsRouter;
