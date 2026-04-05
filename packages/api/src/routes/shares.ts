import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { shares, playlists, tracks } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import type { Env } from "../types.js";

const sharesRouter = new Hono<Env>();

const FREE_TIER_MAX_COLLABORATORS = 4;

// Create a share link
sharesRouter.post("/", requireAuth, async (c) => {
  const { playlistId, permission, email } = await c.req.json();
  const userId = c.get("user").id;

  if (!playlistId || !permission) {
    return c.json({ error: "playlistId and permission required" }, 400);
  }
  if (permission !== "listen" && permission !== "edit") {
    return c.json({ error: "permission must be 'listen' or 'edit'" }, 400);
  }

  // verify playlist ownership
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  // check collaborator limit (free tier)
  const existing = await db
    .select()
    .from(shares)
    .where(eq(shares.playlistId, playlistId));

  if (existing.length >= FREE_TIER_MAX_COLLABORATORS) {
    return c.json(
      { error: `free tier limited to ${FREE_TIER_MAX_COLLABORATORS} collaborators` },
      403
    );
  }

  const token = randomBytes(16).toString("hex");
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

// List shares for a playlist
sharesRouter.get("/playlist/:playlistId", requireAuth, async (c) => {
  const playlistId = c.req.param("playlistId");
  const userId = c.get("user").id;

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

// Revoke a share
sharesRouter.delete("/:id", requireAuth, async (c) => {
  const shareId = c.req.param("id");
  const userId = c.get("user").id;

  const [share] = await db
    .select()
    .from(shares)
    .where(eq(shares.id, shareId))
    .limit(1);

  if (!share) return c.json({ error: "not found" }, 404);

  // verify ownership through playlist
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

// Resolve an invite token — public, no auth required
sharesRouter.get("/invite/:token", async (c) => {
  const token = c.req.param("token");

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
