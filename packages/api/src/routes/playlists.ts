import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { limits, isLimited } from "../lib/limits.js";
import type { Env } from "../types.js";

const playlistsRouter = new Hono<Env>();

// List user's playlists
playlistsRouter.get("/", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const result = await db
    .select()
    .from(playlists)
    .where(eq(playlists.ownerId, userId))
    .orderBy(playlists.createdAt);

  return c.json({ playlists: result });
});

// Create playlist
playlistsRouter.post("/", requireAuth, async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "name required" }, 400);

  const userId = c.get("user").id;

  // check playlist limit
  if (isLimited(limits.maxPlaylists)) {
    const existing = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.ownerId, userId));
    if (existing.length >= limits.maxPlaylists) {
      return c.json(
        { error: `free tier limited to ${limits.maxPlaylists} playlist(s)` },
        403
      );
    }
  }

  const [playlist] = await db
    .insert(playlists)
    .values({ name, ownerId: userId })
    .returning();

  return c.json({ playlist }, 201);
});

// Get playlist with tracks
playlistsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

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

  return c.json({ playlist, tracks: trackList });
});

// Update playlist
playlistsRouter.patch("/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  const body = await c.req.json();

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.name = body.name;
  if (body.artworkKey !== undefined) updates.artworkKey = body.artworkKey;

  const [updated] = await db
    .update(playlists)
    .set(updates)
    .where(eq(playlists.id, id))
    .returning();

  return c.json({ playlist: updated });
});

// Delete playlist
playlistsRouter.delete("/:id", requireAuth, async (c) => {
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

// Reorder tracks in a playlist
playlistsRouter.patch("/:id/reorder", requireAuth, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  const { trackIds } = await c.req.json();

  if (!Array.isArray(trackIds)) {
    return c.json({ error: "trackIds array required" }, 400);
  }

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, id))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  // update each track's position
  for (let i = 0; i < trackIds.length; i++) {
    await db
      .update(tracks)
      .set({ position: i })
      .where(eq(tracks.id, trackIds[i]));
  }

  await db
    .update(playlists)
    .set({ updatedAt: new Date() })
    .where(eq(playlists.id, id));

  return c.json({ ok: true });
});

export default playlistsRouter;
