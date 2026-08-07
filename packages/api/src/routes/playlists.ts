import { Hono } from "hono";
import { and, eq, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import {
  requestCanAccessPlaylist,
  requestCanEditPlaylist,
} from "../lib/playlist-access.js";
import { getLimits, isLimited, MAX_ARTWORK_BYTES } from "../lib/limits.js";
import { lockerIdOf, isLockerOwner } from "../lib/locker.js";
import { publicTrack } from "../lib/public-track.js";
import {
  INERT_CONTENT_HEADERS,
  isAllowedImageType,
  safeImageType,
} from "../lib/media-type.js";
import type { Env } from "../types.js";

const playlistsRouter = new Hono<Env>();

playlistsRouter.get("/", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const lockerId = lockerIdOf(c.get("user"));
  const result = await db
    .select()
    .from(playlists)
    .where(eq(playlists.ownerId, lockerId))
    .orderBy(playlists.createdAt);

  return c.json({ playlists: result });
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

  return c.json({ playlist }, 201);
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

  return c.json({ playlist, tracks: trackList.map(publicTrack) });
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

  return c.json({ playlist: updated });
});

// Upload playlist artwork — multipart, stored in R2 under playlist-art/<id>
playlistsRouter.post("/:id/artwork", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const lockerId = lockerIdOf(c.get("user"));

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

  return c.json({ playlist: updated });
});

// Stream playlist artwork — gated to owner session or a valid share token.
// <img> can't send an Authorization header, so a `?token=` query param
// (session OR share token) is also accepted.
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

playlistsRouter.delete("/:id", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const userId = c.get("user").id;

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  await db.delete(playlists).where(eq(playlists.id, id));
  return c.json({ ok: true });
});

// Reorder: owner session OR an "edit" share token for this playlist.
playlistsRouter.patch("/:id/reorder", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const { trackIds } = await c.req.json();

  if (!Array.isArray(trackIds)) {
    return c.json({ error: "trackIds array required" }, 400);
  }

  if (!(await requestCanEditPlaylist(c, id))) {
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
