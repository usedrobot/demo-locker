import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { shares, playlists, tracks } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { getLimits, isLimited } from "../lib/limits.js";
import type { Env } from "../types.js";

const sharesRouter = new Hono<Env>();

sharesRouter.post("/", requireAuth, async (c) => {
  const { playlistId, permission, email } = await c.req.json();
  const userId = c.get("user").id;

  if (!playlistId || !permission) {
    return c.json({ error: "playlistId and permission required" }, 400);
  }
  if (permission !== "listen" && permission !== "edit") {
    return c.json({ error: "permission must be 'listen' or 'edit'" }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  const limits = getLimits(c.env);
  if (isLimited(limits.maxCollaborators)) {
    const existing = await db
      .select()
      .from(shares)
      .where(eq(shares.playlistId, playlistId));

    if (existing.length >= limits.maxCollaborators) {
      return c.json(
        { error: `limited to ${limits.maxCollaborators} collaborators on this plan` },
        403
      );
    }
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  const [share] = await db
    .insert(shares)
    .values({
      playlistId,
      token,
      permission,
      email: email || null,
    })
    .returning();

  return c.json({ share }, 201);
});

sharesRouter.get("/playlist/:playlistId", requireAuth, async (c) => {
  const playlistId = c.req.param("playlistId");
  const userId = c.get("user").id;
  const db = getDb(c.env.DATABASE_URL);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  const result = await db
    .select()
    .from(shares)
    .where(eq(shares.playlistId, playlistId));

  return c.json({ shares: result });
});

sharesRouter.delete("/:id", requireAuth, async (c) => {
  const shareId = c.req.param("id");
  const userId = c.get("user").id;
  const db = getDb(c.env.DATABASE_URL);

  const [share] = await db
    .select()
    .from(shares)
    .where(eq(shares.id, shareId))
    .limit(1);

  if (!share) return c.json({ error: "not found" }, 404);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, share.playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  await db.delete(shares).where(eq(shares.id, shareId));
  return c.json({ ok: true });
});

sharesRouter.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const db = getDb(c.env.DATABASE_URL);

  const [share] = await db
    .select()
    .from(shares)
    .where(eq(shares.token, token))
    .limit(1);

  if (!share) return c.json({ error: "invalid or expired invite" }, 404);

  if (share.expiresAt && share.expiresAt < new Date()) {
    return c.json({ error: "invite expired" }, 410);
  }

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, share.playlistId))
    .limit(1);

  if (!playlist) return c.json({ error: "playlist not found" }, 404);

  const trackList = await db
    .select()
    .from(tracks)
    .where(eq(tracks.playlistId, share.playlistId))
    .orderBy(tracks.position);

  return c.json({
    permission: share.permission,
    playlist,
    tracks: trackList,
  });
});

export default sharesRouter;
