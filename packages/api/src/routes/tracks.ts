import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tracks, playlists } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import {
  requestCanAccessPlaylist,
  requestCanEditPlaylist,
  requestSessionUserId,
} from "../lib/playlist-access.js";
import { buildStreamResponse } from "../lib/stream-response.js";
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

  let ownerId: string | null = null;
  let position = 0;
  if (playlistId) {
    // owner session or edit share token — either resolves to the owner id
    ownerId = await requestCanEditPlaylist(c, playlistId);
    if (!ownerId) {
      return c.json({ error: "not found" }, 404);
    }
    position = await nextPosition(db, playlistId);
  } else {
    // library upload — session required
    ownerId = await requestSessionUserId(c);
    if (!ownerId) {
      return c.json({ error: "unauthorized" }, 401);
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
    })
    .returning();

  return c.json({ track }, 201);
});

// List the user's whole track library (every upload, in or out of playlists)
tracksRouter.get("/", requireAuth, async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.ownerId, c.get("user").id))
    .orderBy(desc(tracks.uploadedAt));
  return c.json({ tracks: rows });
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
    // Library track not in any playlist — owner only.
    const userId = await requestSessionUserId(c);
    if (!userId || userId !== track.ownerId) {
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
    const userId = await requestSessionUserId(c);
    if (!userId || userId !== track.ownerId) {
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
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
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
  const userId = c.get("user").id;

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (!track || track.ownerId !== userId) {
    return c.json({ error: "not found" }, 404);
  }

  let position = 0;
  if (playlistId) {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .limit(1);
    if (!playlist || playlist.ownerId !== userId) {
      return c.json({ error: "not found" }, 404);
    }
    position = await nextPosition(db, playlistId);
  }

  const [updated] = await db
    .update(tracks)
    .set({ playlistId: playlistId ?? null, position })
    .where(eq(tracks.id, trackId))
    .returning();

  return c.json({ track: updated });
});

// Delete a track
tracksRouter.delete("/:id", requireAuth, async (c) => {
  const trackId = c.req.param("id");
  const db = getDb(c.env.DB);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track || track.ownerId !== c.get("user").id) {
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
