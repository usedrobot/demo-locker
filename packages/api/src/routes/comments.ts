import { Hono } from "hono";
import { eq, and, isNull, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { comments, tracks, playlists, sessions, users } from "../db/schema.js";
import { generateToken } from "../lib/auth.js";
import type { Env } from "../types.js";

const commentsRouter = new Hono<Env>();

// Resolve the bearer-authed user (if any). Returns null for anonymous.
async function resolveAuthedUser(c: any) {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const db = getDb(c.env.DATABASE_URL);
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, token))
    .limit(1);
  if (!session || session.expiresAt < new Date()) return null;
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  return user ?? null;
}

// Strip server-only fields from a comment row before returning to clients.
function publicComment(row: any) {
  const { deleteToken, ...rest } = row;
  return rest;
}

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

  const deleteToken = generateToken();

  const [comment] = await db
    .insert(comments)
    .values({
      trackId: trackId || null,
      playlistId: playlistId || null,
      authorName,
      body,
      timestampSec: trackId ? (timestampSec ?? null) : null,
      parentId: parentId || null,
      deleteToken,
    })
    .returning();

  // Return the deleteToken to the creator so they can delete their own
  // comment later (stored in their browser).
  return c.json({ comment: { ...publicComment(comment), deleteToken } }, 201);
});

commentsRouter.get("/track/:trackId", async (c) => {
  const trackId = c.req.param("trackId");
  const db = getDb(c.env.DATABASE_URL);

  const all = await db
    .select()
    .from(comments)
    .where(eq(comments.trackId, trackId))
    .orderBy(asc(comments.createdAt));

  const topLevel = all.filter((row: any) => !row.parentId).map(publicComment);
  const replies = all.filter((row: any) => row.parentId).map(publicComment);

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

  const topLevel = all.filter((row: any) => !row.parentId).map(publicComment);
  const replies = all.filter((row: any) => row.parentId).map(publicComment);

  const threaded = topLevel.map((comment: any) => ({
    ...comment,
    replies: replies.filter((r: any) => r.parentId === comment.id),
  }));

  return c.json({ comments: threaded });
});

// Toggle resolved state — owner of the comment's playlist only.
commentsRouter.patch("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const user = await resolveAuthedUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const db = getDb(c.env.DATABASE_URL);

  // Look up the comment and resolve its playlist (via comment.playlistId or
  // via the comment's track → playlist).
  const [comment] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  if (!comment) return c.json({ error: "not found" }, 404);

  let playlistId = comment.playlistId;
  if (!playlistId && comment.trackId) {
    const [track] = await db
      .select({ playlistId: tracks.playlistId })
      .from(tracks)
      .where(eq(tracks.id, comment.trackId))
      .limit(1);
    playlistId = track?.playlistId ?? null;
  }
  if (!playlistId) return c.json({ error: "not found" }, 404);

  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);
  if (!playlist || playlist.ownerId !== user.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  const nowResolved = comment.resolvedAt == null;
  const [updated] = await db
    .update(comments)
    .set({
      resolvedAt: nowResolved ? new Date() : null,
      resolvedBy: nowResolved ? user.id : null,
    })
    .where(eq(comments.id, id))
    .returning();

  return c.json({ comment: publicComment(updated) });
});

// Delete a comment. Allowed if:
//   - Bearer-authed user owns the playlist this comment belongs to, OR
//   - The request supplies the matching X-Delete-Token (anonymous author).
commentsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DATABASE_URL);

  const [comment] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  if (!comment) return c.json({ error: "not found" }, 404);

  let allowed = false;

  // Anon delete via per-comment token
  const supplied = c.req.header("X-Delete-Token");
  if (supplied && comment.deleteToken && supplied === comment.deleteToken) {
    allowed = true;
  }

  // Owner delete via Bearer
  if (!allowed) {
    const user = await resolveAuthedUser(c);
    if (user) {
      let playlistId = comment.playlistId;
      if (!playlistId && comment.trackId) {
        const [track] = await db
          .select({ playlistId: tracks.playlistId })
          .from(tracks)
          .where(eq(tracks.id, comment.trackId))
          .limit(1);
        playlistId = track?.playlistId ?? null;
      }
      if (playlistId) {
        const [playlist] = await db
          .select({ ownerId: playlists.ownerId })
          .from(playlists)
          .where(eq(playlists.id, playlistId))
          .limit(1);
        if (playlist?.ownerId === user.id) allowed = true;
      }
    }
  }

  if (!allowed) return c.json({ error: "forbidden" }, 403);

  // Cascade delete replies first (no FK between parent/child, so do it manually)
  await db.delete(comments).where(eq(comments.parentId, id));
  await db.delete(comments).where(eq(comments.id, id));

  return c.json({ ok: true });
});

export default commentsRouter;
