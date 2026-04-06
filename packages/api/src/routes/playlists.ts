import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { playlists, tracks } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { getLimits, isLimited } from "../lib/limits.js";
import type { Env } from "../types.js";

const playlistsRouter = new Hono<Env>();

playlistsRouter.get("/", requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const userId = c.get("user").id;
  const result = await db
    .select()
    .from(playlists)
    .where(eq(playlists.ownerId, userId))
    .orderBy(playlists.createdAt);

  return c.json({ playlists: result });
});

playlistsRouter.post("/", requireAuth, async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "name required" }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const userId = c.get("user").id;
  const limits = getLimits(c.env);

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

playlistsRouter.get("/:id", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
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

playlistsRouter.patch("/:id", requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
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

// Upload playlist artwork — multipart, stored in R2 under playlist-art/<id>
playlistsRouter.post("/:id/artwork", requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
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

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file required" }, 400);

  const ext = file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] || "";
  const key = `playlist-art/${id}${ext}`;

  await c.env.DEMOS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "image/jpeg" },
  });

  const [updated] = await db
    .update(playlists)
    .set({ artworkKey: key, updatedAt: new Date() })
    .where(eq(playlists.id, id))
    .returning();

  return c.json({ playlist: updated });
});

// Stream playlist artwork — public so invitees can see it too
playlistsRouter.get("/:id/artwork", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param("id");

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

  const headers = new Headers();
  headers.set(
    "Content-Type",
    object.httpMetadata?.contentType || "image/jpeg"
  );
  headers.set("Cache-Control", "public, max-age=3600");
  if (object.size) headers.set("Content-Length", String(object.size));

  return new Response(object.body, { headers });
});

playlistsRouter.delete("/:id", requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
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

playlistsRouter.patch("/:id/reorder", requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
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
