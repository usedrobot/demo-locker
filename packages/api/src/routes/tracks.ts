import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tracks, playlists } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import {
  requestCanAccessPlaylist,
  requestCanEditPlaylist,
  requestSessionUserId,
} from "../lib/playlist-access.js";
import { lockerIdOf, lockerIdForUserId, isLockerOwner } from "../lib/locker.js";
import { buildStreamResponse } from "../lib/stream-response.js";
import { publicTrack, type TrackRow } from "../lib/public-track.js";
import { resolveDisplayNames } from "../lib/display-name.js";
import { getLimits, isLimited } from "../lib/limits.js";
import { INERT_CONTENT_HEADERS, safeAudioType } from "../lib/media-type.js";
import type { Env } from "../types.js";

const tracksRouter = new Hono<Env>();

type Db = ReturnType<typeof getDb>;

async function nextPosition(db: Db, playlistId: string): Promise<number> {
  const existing = await db
    .select({ position: tracks.position })
    .from(tracks)
    .where(eq(tracks.playlistId, playlistId))
    .orderBy(tracks.position);
  return existing.length > 0 ? existing[existing.length - 1].position + 1 : 0;
}

// Upload a track — receives the file directly, stores in R2.
// Auth: a session (library or own-playlist uploads), OR an "edit" share token
// for the target playlist (collaborator uploads — attributed to the owner).
tracksRouter.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const streamFile = formData.get("stream") as File | null;
  const playlistId = formData.get("playlistId") as string | null;
  const customTitle = formData.get("title") as string | null;
  const waveformData = formData.get("waveformData") as string | null;
  const durationRaw = formData.get("duration") as string | null;
  const duration = durationRaw ? parseFloat(durationRaw) : null;

  // playlistId is optional — without it the track lands in the user's library
  if (!file) {
    return c.json({ error: "file required" }, 400);
  }

  const db = getDb(c.env.DB);
  const bucket = c.env.DEMOS_BUCKET;
  const limits = getLimits(c.env);

  const uploadBytes = file.size + (streamFile?.size ?? 0);
  if (file.size > limits.maxUploadBytes) {
    return c.json(
      { error: `file exceeds the ${limits.maxUploadBytes} byte upload limit` },
      413
    );
  }

  // Who is acting, if anyone. Null for an anonymous edit-share holder — they
  // are not a user and have no id to record.
  const actingUserId = await requestSessionUserId(c);

  let ownerId: string | null = null;
  let position = 0;
  if (playlistId) {
    // owner session, collaborator session, or edit share token — all resolve
    // to the locker owner's id
    ownerId = await requestCanEditPlaylist(c, playlistId);
    if (!ownerId) {
      return c.json({ error: "not found" }, 404);
    }
    position = await nextPosition(db, playlistId);
  } else {
    // library upload — session required. ownerId is the LOCKER, not the
    // uploader: a collaborator's library upload belongs to the owner's
    // library, exactly as a playlist upload does. actingUserId carries who.
    if (!actingUserId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    ownerId = await lockerIdForUserId(db, actingUserId);
  }

  // Enforced here rather than trusted from config: MAX_STORAGE_BYTES was read
  // from the env and surfaced in the docs for four releases without a single
  // call site, so an operator who set it believed uploads were capped when
  // nothing was checking. Rows uploaded before size_bytes existed count as 0 —
  // the quota starts measuring from here rather than guessing at history.
  if (isLimited(limits.maxStorageBytes)) {
    const [used] = await db
      .select({ total: sql<number>`coalesce(sum(${tracks.sizeBytes}), 0)` })
      .from(tracks)
      .where(eq(tracks.ownerId, ownerId));
    if (Number(used?.total ?? 0) + uploadBytes > limits.maxStorageBytes) {
      return c.json(
        { error: "this instance's storage limit is full" },
        413
      );
    }
  }

  const key = `${playlistId ?? "library"}/${crypto.randomUUID()}/${file.name}`;

  // store original in R2
  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "audio/mpeg" },
  });

  // A pre-encoded streaming rendition, produced in the browser at upload time.
  // Optional by design: if the browser couldn't decode or encode the file we
  // store the original alone and stream it directly, exactly as before.
  let streamKey = key;
  if (streamFile) {
    streamKey = `${key}.stream.m4a`;
    await bucket.put(streamKey, streamFile.stream(), {
      httpMetadata: { contentType: streamFile.type || "audio/mp4" },
    });
  }

  const title =
    (customTitle && customTitle.trim()) ||
    file.name.replace(/\.[^.]+$/, "");
  const [track] = await db
    .insert(tracks)
    .values({
      playlistId,
      ownerId,
      title,
      position,
      originalKey: key,
      streamKey,
      waveformData: waveformData || null,
      duration: duration && isFinite(duration) ? duration : null,
      sizeBytes: uploadBytes,
      uploadedBy: actingUserId,
    })
    .returning();

  const names = await resolveDisplayNames(db, actingUserId, [track.uploadedBy]);
  return c.json({ track: publicTrack(track, actingUserId, names) }, 201);
});

// List the locker's whole track library (every upload, in or out of
// playlists) — the owner's own uploads plus any collaborator's.
tracksRouter.get("/", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user");
  const rows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.ownerId, lockerIdOf(user)))
    .orderBy(desc(tracks.uploadedAt));
  // The reader is a locker member, but not necessarily the uploader of every
  // row here — a locker can hold several collaborators, and none of them may
  // learn each other's user id. publicTrack answers "is this mine" instead,
  // and carries a resolved NAME for whose it is — one lookup for the whole
  // page, not one per row (lib/display-name.ts).
  const names = await resolveDisplayNames(
    db,
    user.id,
    rows.map((t: TrackRow) => t.uploadedBy)
  );
  return c.json({ tracks: rows.map((t: TrackRow) => publicTrack(t, user.id, names)) });
});

// Stream a track from R2 — gated by the parent playlist. <audio> can't send an
// Authorization header, so a `?token=` query param (session OR share token) is
// also accepted (see lib/playlist-access.ts). Public playlists stream anonymously
// via the separate /public/v1/tracks/:id/stream route.
tracksRouter.get("/:id/stream", async (c) => {
  const trackId = c.req.param("id");
  const db = getDb(c.env.DB);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track || !track.streamKey) {
    return c.json({ error: "not found" }, 404);
  }

  if (track.playlistId) {
    if (!(await requestCanAccessPlaylist(c, track.playlistId))) {
      return c.json({ error: "not found" }, 404);
    }
  } else {
    // Library track not in any playlist — locker only (owner or collaborator).
    const userId = await requestSessionUserId(c);
    const lockerId = userId && (await lockerIdForUserId(db, userId));
    if (!lockerId || lockerId !== track.ownerId) {
      return c.json({ error: "not found" }, 404);
    }
  }

  return buildStreamResponse(
    c.req.header("Range"),
    c.env.DEMOS_BUCKET,
    track.streamKey,
    "private, max-age=3600"
  );
});

// Builds an RFC 6266-compliant Content-Disposition header for an arbitrary
// (user-controlled) filename. `Headers`/`Response` header values must be
// valid ByteStrings — any codepoint above 0x7E throws — so a raw filename
// with emoji, CJK, or other non-Latin1 characters (all common in uploaded
// track titles) would crash the response entirely. Control characters (e.g.
// a bare newline) would either throw or, if they didn't, inject extra header
// syntax. We therefore emit BOTH parameters: an ASCII-sanitized `filename=`
// for old clients, and an RFC 5987 percent-encoded `filename*=UTF-8''...`
// carrying the real name for everything else.
export function contentDispositionHeader(filename: string): string {
  const asciiFallback =
    filename
      // eslint-disable-next-line no-control-regex -- deliberately stripping C0/C1 control chars
      .replace(/[\x00-\x1f\x7f-\uffff]/g, "")
      .replace(/["\\]/g, "")
      .trim() || "download";
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// The original upload, byte-for-byte. Gated identically to /stream: the
// streaming rendition is lossy, so this is the only way back to the master —
// and originalKey is referenced nowhere else outside the delete path.
tracksRouter.get("/:id/download", async (c) => {
  const trackId = c.req.param("id");
  const db = getDb(c.env.DB);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track) {
    return c.json({ error: "not found" }, 404);
  }

  if (track.playlistId) {
    if (!(await requestCanAccessPlaylist(c, track.playlistId))) {
      return c.json({ error: "not found" }, 404);
    }
  } else {
    // Library track not in any playlist — locker only (owner or collaborator).
    const userId = await requestSessionUserId(c);
    const lockerId = userId && (await lockerIdForUserId(db, userId));
    if (!lockerId || lockerId !== track.ownerId) {
      return c.json({ error: "not found" }, 404);
    }
  }

  const object = await c.env.DEMOS_BUCKET.get(track.originalKey);
  if (!object) {
    return c.json({ error: "not found" }, 404);
  }

  const filename = track.originalKey.split("/").pop() ?? "download";
  return new Response(object.body, {
    headers: {
      ...INERT_CONTENT_HEADERS,
      "Content-Type": safeAudioType(object.httpMetadata?.contentType),
      "Content-Disposition": contentDispositionHeader(filename),
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// Move a track into (or out of) a playlist. Body: { playlistId: string | null }
tracksRouter.patch("/:id", requireAuth, async (c) => {
  const trackId = c.req.param("id");
  const { playlistId } = await c.req.json<{ playlistId: string | null }>();
  const db = getDb(c.env.DB);
  const lockerId = lockerIdOf(c.get("user"));

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (!track || track.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  let position = 0;
  if (playlistId) {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .limit(1);
    if (!playlist || playlist.ownerId !== lockerId) {
      return c.json({ error: "not found" }, 404);
    }
    position = await nextPosition(db, playlistId);
  }

  const [updated] = await db
    .update(tracks)
    .set({ playlistId: playlistId ?? null, position })
    .where(eq(tracks.id, trackId))
    .returning();

  const actingUserId = c.get("user").id;
  const names = await resolveDisplayNames(db, actingUserId, [updated.uploadedBy]);
  return c.json({ track: publicTrack(updated, actingUserId, names) });
});

// Delete a track. The locker owner may delete anything in their locker; a
// collaborator may only delete their own upload.
tracksRouter.delete("/:id", requireAuth, async (c) => {
  const trackId = c.req.param("id");
  const db = getDb(c.env.DB);
  const user = c.get("user");
  const lockerId = lockerIdOf(user);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  // Wrong locker entirely — non-enumerable, same 404 a missing row gets.
  if (!track || track.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  // Deleting a track erases the lossless master from the bucket with no undo,
  // so a collaborator may only ever destroy their own upload. A null
  // uploadedBy predates attribution (or its uploader has been removed, the FK
  // being ON DELETE SET NULL, or the upload came from an anonymous edit-share
  // holder) and reads as the owner's — which means a collaborator may not
  // touch it. Fail closed: this runs before any bucket delete.
  if (!isLockerOwner(user) && track.uploadedBy !== user.id) {
    return c.json({ error: "not found" }, 404);
  }

  // delete from R2
  await c.env.DEMOS_BUCKET.delete(track.originalKey);
  if (track.streamKey && track.streamKey !== track.originalKey) {
    await c.env.DEMOS_BUCKET.delete(track.streamKey);
  }

  await db.delete(tracks).where(eq(tracks.id, trackId));
  return c.json({ ok: true });
});

export default tracksRouter;
