import { Hono } from "hono";
import { eq, and, isNull, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { comments, tracks, playlists, users } from "../db/schema.js";
import { generateToken } from "../lib/auth.js";
import { bearerToken, findSession } from "../lib/session.js";
import {
  MAX_COMMENT_BODY_CHARS,
  MAX_COMMENT_AUTHOR_CHARS,
} from "../lib/limits.js";
import {
  requestCanAccessPlaylist,
  requestSessionUserId,
} from "../lib/playlist-access.js";
import { lockerIdForUserId } from "../lib/locker.js";
import type { Env } from "../types.js";

const commentsRouter = new Hono<Env>();

// Resolve the bearer-authed user (if any). Returns null for anonymous.
async function resolveAuthedUser(c: any) {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return null;
  const db = getDb(c.env.DB);
  const session = await findSession(db, token);
  if (!session || session.expiresAt < new Date()) return null;
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  return user ?? null;
}

// Strip server-only fields from a comment row before returning to clients.
//
// `resolvedBy` is one of them. It is a real audit record and the column stays,
// but it holds a RAW internal user id — and once collaborators could resolve
// (Task 11c), that id stopped being the locker owner's (already on the wire as
// `playlists.ownerId`) and became any member's, which has never been
// serialized anywhere. These lists are readable with a share token, so it must
// not leave the server. Nothing renders it; `resolvedAt` is what the UI shows.
// If who-resolved-it is ever wanted on the wire, this branch's own precedent
// (`uploadedByMe`, `createdByMe`, `createdByName`) is how to add it: a
// computed value, never the id.
function publicComment(row: any) {
  const { deleteToken, resolvedBy, ...rest } = row;
  return rest;
}

// What a comment hangs off, for the moderation guards: which LOCKER owns it,
// and which playlist (if any) it is readable through.
//
// `playlists.ownerId` and `tracks.ownerId` hold the locker id, never the id of
// whoever created the row — which is why a collaborator matches here exactly
// as the owner does, and why moderation survives a member's removal.
//
// The track fallback mirrors POST /comments (above): a library track in no
// playlist belongs to its locker directly. Without it the product could create
// comments on such a track that nobody, not even the owner, could ever resolve
// or delete.
type CommentTarget = { lockerId: string; playlistId: string | null };

async function commentTarget(
  db: ReturnType<typeof getDb>,
  comment: { playlistId: string | null; trackId: string | null }
): Promise<CommentTarget | null> {
  let playlistId = comment.playlistId;
  if (!playlistId && comment.trackId) {
    const [track] = await db
      .select({ playlistId: tracks.playlistId, ownerId: tracks.ownerId })
      .from(tracks)
      .where(eq(tracks.id, comment.trackId))
      .limit(1);
    if (!track) return null;
    if (!track.playlistId) {
      return { lockerId: track.ownerId, playlistId: null };
    }
    playlistId = track.playlistId;
  }
  if (!playlistId) return null;

  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);
  if (!playlist) return null;
  return { lockerId: playlist.ownerId, playlistId };
}

// The refusal a non-moderator gets.
//
// Non-enumerable by default: a caller who cannot even READ the comment learns
// nothing about whether the id exists — the same 404 a nonexistent comment
// gets. The documented exception applies to a caller who has already
// demonstrated read access (a share holder, who can list these very comments):
// for them existence is not a secret, and a 404 would only mislead.
//
// A library track in no playlist has no reader class beyond its locker
// members, so every refusal there is a 404.
async function refuseModeration(c: any, target: CommentTarget) {
  const readable = target.playlistId
    ? await requestCanAccessPlaylist(c, target.playlistId)
    : false;
  return readable
    ? c.json({ error: "forbidden" }, 403)
    : c.json({ error: "not found" }, 404);
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
  // Anyone holding a listen link can post, so the write path needs a ceiling —
  // there was none, in a table that is not otherwise rate limited.
  if (typeof body !== "string" || typeof authorName !== "string") {
    return c.json({ error: "authorName and body must be strings" }, 400);
  }
  if (body.length > MAX_COMMENT_BODY_CHARS) {
    return c.json(
      { error: `comment must be under ${MAX_COMMENT_BODY_CHARS} characters` },
      400
    );
  }
  if (authorName.length > MAX_COMMENT_AUTHOR_CHARS) {
    return c.json(
      { error: `name must be under ${MAX_COMMENT_AUTHOR_CHARS} characters` },
      400
    );
  }

  const db = getDb(c.env.DB);

  // Resolve the playlist this comment targets, then gate on it: only a
  // session acting in the locker (the owner, or a collaborator) or a valid
  // share token may comment (the invite-listener flow). Anonymous without a
  // token is indistinguishable from a nonexistent target -> the same
  // non-enumerable 404.
  let allowed = false;
  if (trackId) {
    const [track] = await db
      .select({ playlistId: tracks.playlistId, ownerId: tracks.ownerId })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    if (track?.playlistId) {
      allowed = await requestCanAccessPlaylist(c, track.playlistId);
    } else if (track) {
      // library track outside any playlist — locker only (owner or collaborator)
      const actingUserId = await requestSessionUserId(c);
      allowed =
        !!actingUserId &&
        (await lockerIdForUserId(db, actingUserId)) === track.ownerId;
    }
  } else if (playlistId) {
    allowed = await requestCanAccessPlaylist(c, playlistId);
  }

  if (!allowed) {
    return c.json({ error: "not found" }, 404);
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
  const db = getDb(c.env.DB);

  const [track] = await db
    .select({ playlistId: tracks.playlistId, ownerId: tracks.ownerId })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  let canAccess = false;
  if (track?.playlistId) {
    canAccess = await requestCanAccessPlaylist(c, track.playlistId);
  } else if (track) {
    // library track outside any playlist — locker only (owner or collaborator)
    const actingUserId = await requestSessionUserId(c);
    canAccess =
      !!actingUserId &&
      (await lockerIdForUserId(db, actingUserId)) === track.ownerId;
  }
  if (!canAccess) {
    return c.json({ error: "not found" }, 404);
  }

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
  const db = getDb(c.env.DB);

  if (!(await requestCanAccessPlaylist(c, playlistId))) {
    return c.json({ error: "not found" }, 404);
  }

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

// Toggle resolved state — any member of the comment's locker (the owner, or a
// collaborator). Moderation is band work, not administration (DL, 2026-08-08).
commentsRouter.patch("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const user = await resolveAuthedUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const db = getDb(c.env.DB);

  const [comment] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  if (!comment) return c.json({ error: "not found" }, 404);

  const target = await commentTarget(db, comment);
  if (!target) return c.json({ error: "not found" }, 404);
  if ((await lockerIdForUserId(db, user.id)) !== target.lockerId) {
    return refuseModeration(c, target);
  }

  const nowResolved = comment.resolvedAt == null;
  const [updated] = await db
    .update(comments)
    .set({
      resolvedAt: nowResolved ? new Date() : null,
      // An audit field about a PERSON, so it records the acting user — not the
      // locker id the guard above compares against.
      resolvedBy: nowResolved ? user.id : null,
    })
    .where(eq(comments.id, id))
    .returning();

  return c.json({ comment: publicComment(updated) });
});

// Delete a comment. Allowed if:
//   - The Bearer-authed user is a member of the comment's locker (the owner,
//     or a collaborator), OR
//   - The request supplies the matching X-Delete-Token (anonymous author).
commentsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const [comment] = await db
    .select()
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  if (!comment) return c.json({ error: "not found" }, 404);

  // Anon delete via per-comment token — orthogonal to membership, and the one
  // path an anonymous author has to their own words.
  const supplied = c.req.header("X-Delete-Token");
  const ownsToken =
    !!supplied && !!comment.deleteToken && supplied === comment.deleteToken;

  if (!ownsToken) {
    const target = await commentTarget(db, comment);
    if (!target) return c.json({ error: "not found" }, 404);
    const user = await resolveAuthedUser(c);
    const actingLockerId = user ? await lockerIdForUserId(db, user.id) : null;
    if (actingLockerId !== target.lockerId) {
      return refuseModeration(c, target);
    }
  }

  // Cascade delete replies first (no FK between parent/child, so do it manually)
  await db.delete(comments).where(eq(comments.parentId, id));
  await db.delete(comments).where(eq(comments.id, id));

  return c.json({ ok: true });
});

export default commentsRouter;
