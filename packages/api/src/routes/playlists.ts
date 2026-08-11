import { Hono } from "hono";
import { and, eq, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import {
  requestCanAccessPlaylist,
  requestCanReorderPlaylist,
  requestSessionUserId,
} from "../lib/playlist-access.js";
import { getLimits, isLimited, MAX_ARTWORK_BYTES } from "../lib/limits.js";
import { lockerIdOf, isLockerOwner } from "../lib/locker.js";
import { publicTrack, type TrackRow } from "../lib/public-track.js";
import { publicPlaylist, type PlaylistRow } from "../lib/public-playlist.js";
import { resolveDisplayNames } from "../lib/display-name.js";
import {
  INERT_CONTENT_HEADERS,
  isAllowedImageType,
  safeImageType,
} from "../lib/media-type.js";
import type { Env } from "../types.js";

const playlistsRouter = new Hono<Env>();

playlistsRouter.get("/", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user");
  const result = await db
    .select()
    .from(playlists)
    .where(eq(playlists.ownerId, lockerIdOf(user)))
    .orderBy(playlists.createdAt);

  // Every reader here is a locker member, but not necessarily the creator of
  // every row — a locker can hold several collaborators, and none of them may
  // learn each other's user id. publicPlaylist answers "is this mine" instead,
  // and carries a resolved NAME for whose it is — one lookup for the whole
  // page, not one per row (lib/display-name.ts).
  const names = await resolveDisplayNames(
    db,
    user.id,
    lockerIdOf(user),
    result.map((p: PlaylistRow) => p.createdBy)
  );
  return c.json({
    playlists: result.map((p: PlaylistRow) => publicPlaylist(p, user.id, names)),
  });
});

playlistsRouter.post("/", requireAuth, async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "name required" }, 400);

  const db = getDb(c.env.DB);
  const user = c.get("user");
  const lockerId = lockerIdOf(user);
  const limits = getLimits(c.env);

  if (isLimited(limits.maxPlaylists)) {
    const existing = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.ownerId, lockerId));
    if (existing.length >= limits.maxPlaylists) {
      return c.json(
        { error: `free tier limited to ${limits.maxPlaylists} playlist(s)` },
        403
      );
    }
  }

  const [playlist] = await db
    .insert(playlists)
    .values({ name, ownerId: lockerId, createdBy: user.id })
    .returning();

  const names = await resolveDisplayNames(db, user.id, lockerId, [playlist.createdBy]);
  return c.json({ playlist: publicPlaylist(playlist, user.id, names) }, 201);
});

playlistsRouter.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  // Gate: a session acting in the playlist's locker (owner or collaborator)
  // or a valid share token (see lib/playlist-access.ts). Anything else is
  // indistinguishable from a nonexistent playlist.
  if (!(await requestCanAccessPlaylist(c, id))) {
    return c.json({ error: "not found" }, 404);
  }

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist) return c.json({ error: "not found" }, 404);

  const trackList = await db
    .select()
    .from(tracks)
    .where(eq(tracks.playlistId, id))
    .orderBy(asc(tracks.position));

  // This route is reachable by an anonymous share-token holder, not just a
  // locker session — publicPlaylist() keeps createdBy (a collaborator's user
  // id) from leaking to them, and to the other collaborators in the locker,
  // replacing it with the createdByMe bit. Same for the tracks: nobody gets a
  // raw uploadedBy, but a session reader still learns which rows are their own
  // (both false here for a share holder, who has no id and therefore owns
  // nothing).
  const actingUserId = await requestSessionUserId(c);
  // One lookup covers the playlist's creator and every uploader on the page.
  // Resolves to nothing at all for a share holder, who has no session.
  const names = await resolveDisplayNames(db, actingUserId, playlist.ownerId, [
    playlist.createdBy,
    ...trackList.map((t: TrackRow) => t.uploadedBy),
  ]);
  return c.json({
    playlist: publicPlaylist(playlist, actingUserId, names),
    tracks: trackList.map((t: TrackRow) => publicTrack(t, actingUserId, names)),
  });
});

playlistsRouter.patch("/:id", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const user = c.get("user");
  const lockerId = lockerIdOf(user);
  const body = await c.req.json();

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.name = body.name;
  // Publishing is a locker-level decision, not library work: it puts the
  // playlist on the open web via /public/v1 and the embed. Only the owner may
  // change it — in EITHER direction. A non-owner attempting a real change is
  // refused rather than silently ignored: a collaborator trying to pull
  // something off the public web must find out they cannot, not be told the
  // request succeeded while it stays live.
  //
  // An echo of the current value is not a change and is ignored, so a client
  // that includes the field it already has does not fail an unrelated rename.
  //
  // This is the one deliberate exception to the blanket-404 convention. That
  // rule hides whether a resource exists; a collaborator reaching this line has
  // already passed the ownership check above, so they can list, open and rename
  // this playlist. A 404 would hide nothing and would actively mislead — it is
  // the same response as a deleted playlist, and a client following the
  // convention would navigate them out of a playlist they were just using. A
  // stranger never gets here: they are still 404'd above, because for them
  // existence genuinely is the secret.
  if (typeof body.isPublic === "boolean" && body.isPublic !== playlist.isPublic) {
    if (!isLockerOwner(user)) {
      return c.json(
        { error: "only the locker owner can publish a playlist" },
        403
      );
    }
    updates.isPublic = body.isPublic;
  }
  // artworkKey is deliberately NOT patchable. It is a pointer into the shared
  // bucket, so accepting it from a client let any authenticated user aim their
  // own artwork route at another account's object and read it — including the
  // lossless master, and including after their share had been revoked. It is
  // set server-side by POST /:id/artwork, which is the only writer that ever
  // needed it.

  const [updated] = await db
    .update(playlists)
    .set(updates)
    .where(eq(playlists.id, id))
    .returning();

  const names = await resolveDisplayNames(db, user.id, lockerId, [updated.createdBy]);
  return c.json({ playlist: publicPlaylist(updated, user.id, names) });
});

// Upload playlist artwork — multipart, stored in R2 under playlist-art/<id>
playlistsRouter.post("/:id/artwork", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const user = c.get("user");
  const lockerId = lockerIdOf(user);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file required" }, 400);

  if (!isAllowedImageType(file.type)) {
    return c.json(
      { error: "artwork must be a PNG, JPEG, GIF, WebP or AVIF image" },
      400
    );
  }
  if (file.size > MAX_ARTWORK_BYTES) {
    return c.json({ error: "artwork must be under 10MB" }, 413);
  }

  const ext = file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] || "";
  const key = `playlist-art/${id}${ext}`;

  await c.env.DEMOS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: safeImageType(file.type) },
  });

  const [updated] = await db
    .update(playlists)
    .set({ artworkKey: key, updatedAt: new Date() })
    .where(eq(playlists.id, id))
    .returning();

  const names = await resolveDisplayNames(db, user.id, lockerId, [updated.createdBy]);
  return c.json({ playlist: publicPlaylist(updated, user.id, names) });
});

// Stream playlist artwork — gated to a session acting in the locker (owner
// or collaborator) or a valid share token. <img> can't send an Authorization
// header, so a `?token=` query param (session OR share token) is also
// accepted.
playlistsRouter.get("/:id/artwork", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  if (!(await requestCanAccessPlaylist(c, id))) {
    return c.json({ error: "not found" }, 404);
  }

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || !playlist.artworkKey) {
    return c.json({ error: "not found" }, 404);
  }

  const object = await c.env.DEMOS_BUCKET.get(playlist.artworkKey);
  if (!object) return c.json({ error: "not found" }, 404);

  // Sanitised on the way out as well as in, so artwork stored before the
  // upload allowlist existed can't still be served as markup.
  const headers = new Headers(INERT_CONTENT_HEADERS);
  headers.set("Content-Type", safeImageType(object.httpMetadata?.contentType));
  headers.set("Cache-Control", "private, max-age=3600");
  if (object.size) headers.set("Content-Length", String(object.size));

  return new Response(object.body, { headers });
});

// Delete a playlist. The locker owner may delete any playlist in their locker;
// a collaborator may only delete one they created.
//
// This is not as destructive as DELETE /tracks/:id, but it is not free either.
// The tracks survive: `tracks.playlist_id` is ON DELETE set null
// (0000_init.sql:61 — not 0003, which only added created_by/uploaded_by), so
// they detach back into the locker's library rather than being deleted, and no
// audio is destroyed here.
//
// The playlist-level COMMENTS do not survive: `comments.playlist_id` is
// ON DELETE cascade (0000_init.sql:14). Deleting a playlist you created
// therefore takes its comments with it — which is consistent with
// DELETE /comments/:id, open to every locker member since comment moderation
// stopped being owner-only (routes/comments.ts).
playlistsRouter.delete("/:id", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const user = c.get("user");
  const lockerId = lockerIdOf(user);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  // A null createdBy predates attribution (or its creator has been removed)
  // and reads as the owner's, so a collaborator may not delete it.
  if (!isLockerOwner(user) && playlist.createdBy !== user.id) {
    return c.json({ error: "not found" }, 404);
  }

  await db.delete(playlists).where(eq(playlists.id, id));
  return c.json({ ok: true });
});

// Reorder: a locker session (owner or collaborator) OR an "edit" share token
// for this playlist.
playlistsRouter.patch("/:id/reorder", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const { trackIds } = await c.req.json();

  if (!Array.isArray(trackIds)) {
    return c.json({ error: "trackIds array required" }, 400);
  }

  if (!(await requestCanReorderPlaylist(c, id))) {
    return c.json({ error: "not found" }, 404);
  }

  // Scoped to this playlist's tracks. Without the playlistId predicate the
  // caller could pass any track ID they had ever seen and rewrite its position
  // in someone else's playlist — edit rights on one playlist are not edit
  // rights on every track ID in the instance.
  for (let i = 0; i < trackIds.length; i++) {
    await db
      .update(tracks)
      .set({ position: i })
      .where(and(eq(tracks.id, trackIds[i]), eq(tracks.playlistId, id)));
  }

  await db
    .update(playlists)
    .set({ updatedAt: new Date() })
    .where(eq(playlists.id, id));

  return c.json({ ok: true });
});

export default playlistsRouter;
