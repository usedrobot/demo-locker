import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { shares, playlists, tracks, users } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { getLimits, isLimited } from "../lib/limits.js";
import { publicTrack, type TrackRow } from "../lib/public-track.js";
import { publicPlaylist } from "../lib/public-playlist.js";
import { publicShare } from "../lib/public-share.js";
import { resolveDisplayNames } from "../lib/display-name.js";
import { requestSessionUserId } from "../lib/playlist-access.js";
import { lockerIdOf } from "../lib/locker.js";
import type { Env } from "../types.js";

const sharesRouter = new Hono<Env>();

// The INTERNAL projection for a share row. Spelled out rather than `select()`
// so the columns a client may see stay an explicit list.
//
// `created_by` is selected here but MUST NOT be serialized: it holds a raw
// internal user id, and this branch has three times now had to replace exactly
// such an id with a computed boolean (uploadedByMe, createdByMe, mintedByMe).
// It is read solely to compute `mintedByMe`, and publicShare() strips it —
// every response below goes through that function, never through this shape
// directly.
const SHARE_FIELDS = {
  id: shares.id,
  playlistId: shares.playlistId,
  token: shares.token,
  permission: shares.permission,
  email: shares.email,
  createdAt: shares.createdAt,
  expiresAt: shares.expiresAt,
  createdBy: shares.createdBy,
};

// The row SHARE_FIELDS produces. Needed because drizzle's select builder widens
// to `any` at the call sites, so a `.map((r) => ...)` there has no contextual
// type and would check nothing.
type ShareProjection = {
  id: string;
  playlistId: string;
  token: string;
  permission: string;
  email: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  createdBy: string | null;
};

sharesRouter.post("/", requireAuth, async (c) => {
  const { playlistId, permission, email } = await c.req.json();
  const lockerId = lockerIdOf(c.get("user"));

  if (!playlistId || !permission) {
    return c.json({ error: "playlistId and permission required" }, 400);
  }
  if (permission !== "listen" && permission !== "edit") {
    return c.json({ error: "permission must be 'listen' or 'edit'" }, 400);
  }

  const db = getDb(c.env.DB);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  const limits = getLimits(c.env);
  // MAX_SHARE_LINKS, not MAX_COLLABORATORS: this ceiling is per playlist and
  // has nothing to do with how many people are in the locker. They shared one
  // binding until 0.2.13, so an operator setting a collaborator seat count
  // silently capped every playlist's share links to the same number.
  if (isLimited(limits.maxShareLinks)) {
    const existing = await db
      .select({ id: shares.id })
      .from(shares)
      .where(eq(shares.playlistId, playlistId));

    if (existing.length >= limits.maxShareLinks) {
      return c.json(
        { error: `this instance limits playlists to ${limits.maxShareLinks} share links` },
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
      // Who minted it, so removing that person removes this grant (the FK is
      // ON DELETE CASCADE). Owner-minted links carry the owner's id and are
      // never affected — the owner's row is never deleted by /collab.
      createdBy: c.get("user").id,
    })
    .returning(SHARE_FIELDS);

  return c.json({ share: publicShare(share, c.get("user").id) }, 201);
});

// All share links across every playlist in the acting user's locker — the
// "who has access to my locker" view. Locker-scoped: a collaborator sees
// (and can act on) every token and recipient email the owner or any other
// collaborator has minted, not just their own. Includes the playlist name
// for display.
sharesRouter.get("/", requireAuth, async (c) => {
  const lockerId = lockerIdOf(c.get("user"));
  const db = getDb(c.env.DB);

  const rows = await db
    .select({
      id: shares.id,
      playlistId: shares.playlistId,
      playlistName: playlists.name,
      token: shares.token,
      permission: shares.permission,
      email: shares.email,
      createdAt: shares.createdAt,
      expiresAt: shares.expiresAt,
      createdBy: shares.createdBy,
    })
    .from(shares)
    .innerJoin(playlists, eq(shares.playlistId, playlists.id))
    .where(eq(playlists.ownerId, lockerId));

  // mintedByMe is per ACTING USER, not per locker: the owner and each
  // collaborator get different booleans on the same rows.
  return c.json({
    shares: rows.map((r: ShareProjection & { playlistName: string }) =>
      publicShare(r, c.get("user").id)
    ),
  });
});

// Change a share's permission (grant or revoke edit). Locker-scoped: any
// collaborator may re-permission a link, including one an owner minted.
sharesRouter.patch("/:id", requireAuth, async (c) => {
  const shareId = c.req.param("id");
  const lockerId = lockerIdOf(c.get("user"));
  const { permission } = await c.req.json();
  if (permission !== "listen" && permission !== "edit") {
    return c.json({ error: "permission must be 'listen' or 'edit'" }, 400);
  }
  const db = getDb(c.env.DB);

  const [share] = await db
    .select({ id: shares.id, playlistId: shares.playlistId })
    .from(shares)
    .where(eq(shares.id, shareId))
    .limit(1);
  if (!share) return c.json({ error: "not found" }, 404);

  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, share.playlistId))
    .limit(1);
  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  const [updated] = await db
    .update(shares)
    .set({ permission })
    .where(eq(shares.id, shareId))
    .returning(SHARE_FIELDS);

  return c.json({ share: publicShare(updated, c.get("user").id) });
});

sharesRouter.get("/playlist/:playlistId", requireAuth, async (c) => {
  const playlistId = c.req.param("playlistId");
  const lockerId = lockerIdOf(c.get("user"));
  const db = getDb(c.env.DB);

  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);

  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  const result = await db
    .select(SHARE_FIELDS)
    .from(shares)
    .where(eq(shares.playlistId, playlistId));

  // The callback parameter is annotated because the drizzle select builder
  // widens to `any` here, so an unannotated `r` would silently opt this row out
  // of type checking — the same reason lib/public-track.ts exports TrackRow.
  return c.json({
    shares: result.map((r: ShareProjection) => publicShare(r, c.get("user").id)),
  });
});

sharesRouter.delete("/:id", requireAuth, async (c) => {
  const shareId = c.req.param("id");
  const lockerId = lockerIdOf(c.get("user"));
  const db = getDb(c.env.DB);

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

  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  await db.delete(shares).where(eq(shares.id, shareId));
  return c.json({ ok: true });
});

sharesRouter.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const db = getDb(c.env.DB);

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

  // Listeners get the owner's accent, so a shared locker looks the way its
  // owner set it up rather than defaulting to gold on every stranger's browser.
  const [owner] = await db
    .select({ accent: users.accent })
    .from(users)
    .where(eq(users.id, playlist.ownerId))
    .limit(1);

  // Usually null — this is the anonymous invite landing view. Resolved rather
  // than hardcoded so a signed-in visitor following an invite link gets a
  // truthful uploadedByMe instead of a blanket false.
  const actingUserId = await requestSessionUserId(c);

  // Names for a signed-in visitor following an invite link; nothing at all for
  // the anonymous listener this view usually serves, who is outside the locker
  // and has no business learning the band's names (lib/display-name.ts).
  const names = await resolveDisplayNames(db, actingUserId, [
    playlist.createdBy,
    ...trackList.map((t: TrackRow) => t.uploadedBy),
  ]);

  return c.json({
    permission: share.permission,
    // publicPlaylist here: an anonymous invite holder must not learn the id
    // of the collaborator who created the playlist.
    playlist: publicPlaylist(playlist, actingUserId, names),
    // publicTrack here too. Missing it broke this route twice over: listeners
    // got no `hasStream`, so the player refused to start any track on a share
    // link, and the raw rows still carried originalKey/streamKey — the exact
    // leak the 0.2.8 review closed everywhere except the one route that
    // listeners, not owners, actually use.
    tracks: trackList.map((t: TrackRow) => publicTrack(t, actingUserId, names)),
    accent: owner?.accent ?? null,
  });
});

export default sharesRouter;
