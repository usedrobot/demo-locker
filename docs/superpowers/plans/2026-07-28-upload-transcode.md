# Upload-Time Transcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a 256 kbps AAC streaming rendition in the browser at upload time, keep the original untouched, and make the original downloadable — so playback survives a cellular connection without giving up the lossless master.

**Architecture:** The browser already decodes every upload to build its waveform (`peaks.ts`). That decode is reused to feed a `WebCodecs` `AudioEncoder`, muxed to MP4, and posted alongside the original as a second multipart part. The API stores both objects and points the existing `streamKey` column at the rendition; every consumer already reads `streamKey`, so the player, public API and embed need no changes. A new download route serves `originalKey`, which is currently unreachable by any route.

**Tech Stack:** TypeScript, React, Vite, Web Audio (`decodeAudioData`), WebCodecs (`AudioEncoder`), `mp4-muxer`, Hono, Drizzle, vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-upload-transcode-design.md`

## Global Constraints

- **Format: AAC-LC, 256 kbps, MP4 container.** Level with Spotify Premium's web player, 2× SoundCloud's free upload.
- **An upload must never fail because encoding failed.** Every failure path falls back to uploading the original alone, and the server then sets `streamKey = originalKey` — today's exact behaviour.
- **No migration.** `tracks.originalKey` (NOT NULL) and `tracks.streamKey` (nullable) already exist, and the delete path at `tracks.ts:195-198` already removes both when they differ.
- **Dual-deploy invariant:** every API change must work on BOTH the Cloudflare Worker (`index.ts`, bindings) and Node/standalone (`server.ts`, bindings via `app.fetch(request, bindings)`). Never rely on Hono middleware registration order — that caused a past production bug.
- **`packages/api/src/db/sqlite.ts` is the ONLY file allowed to import `better-sqlite3`.** It must never become reachable from `index.ts` or the Worker bundle breaks.
- **No secure-context-only APIs without a fallback.** Self-hosting over plain http is supported; `crypto.randomUUID` and `navigator.clipboard` are undefined there. Use `lib/ids.ts` and `lib/copy-text.ts`. **`WebCodecs` is also secure-context-only — its absence must hit the fallback path, not throw.**
- **Test commands:** `npm run typecheck && npm run lint` at the repo root (CI runs the root, which is stricter than a single workspace), plus `npm test -w packages/api` and `npm test -w packages/web`.
- **`Response.json()` is typed `unknown` under the api workspace config.** Cast it in tests or the root typecheck fails even when the workspace tests pass.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/web/src/lib/peaks.ts` | Decode an audio file; derive waveform peaks | Modify — export the decode so it can be shared |
| `packages/web/src/lib/transcode.ts` | Encode an `AudioBuffer` to 256k AAC/MP4 | Create |
| `packages/web/src/lib/use-upload-queue.ts` | Upload state machine | Modify — decode once, encode, new `encoding` status |
| `packages/web/src/lib/api.ts` | HTTP client | Modify — send the optional `stream` part |
| `packages/web/src/components/PendingTrackRow.tsx` | Per-file queue row | Modify — surface the encoding phase |
| `packages/web/src/components/TrackList.tsx` | Track rows | Modify — `[download]` affordance |
| `packages/api/src/routes/tracks.ts` | Upload, stream, download | Modify — accept `stream`; add `GET /:id/download` |
| `site/index.html`, `README.md`, `llms.txt` | Quality claims | Modify — streams reliably, downloads exactly |

---

### Task 1: API accepts an optional pre-encoded stream rendition

**Files:**
- Modify: `packages/api/src/routes/tracks.ts:30-91` (the upload handler)
- Test: `packages/api/src/routes/upload-rendition.test.ts` (create)

**Interfaces:**
- Produces: the upload endpoint accepts an optional multipart part named `stream`. When present it is stored at `<originalKey>.stream.m4a` and `streamKey` points at it. When absent, `streamKey === originalKey` exactly as today.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/routes/upload-rendition.test.ts`:

```ts
// The upload endpoint stores an optional pre-encoded rendition produced in the
// browser. Without it, behaviour must be byte-identical to before: one object,
// streamKey === originalKey.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, sessions } from "../db/schema.js";

let db: Database;
let env: Record<string, unknown>;
let token: string;

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  const root = await mkdtemp(join(tmpdir(), "dl-rendition-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [user] = await db
    .insert(users)
    .values({ email: "rendition@test.dev", passwordHash: "x" })
    .returning();
  token = "rendition-token";
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: new Date(Date.now() + 3600_000),
  });
});

function upload(form: FormData): Promise<Response> {
  return app.request(
    "/tracks/upload",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
    env,
  );
}

describe("upload with a stream rendition", () => {
  it("without a stream part, streamKey equals originalKey", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "song.wav", { type: "audio/wav" }));
    const res = await upload(form);
    expect(res.status).toBe(201);
    const { track } = (await res.json()) as { track: { originalKey: string; streamKey: string } };
    expect(track.streamKey).toBe(track.originalKey);
  });

  it("with a stream part, streamKey diverges and both objects are stored", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "song.wav", { type: "audio/wav" }));
    form.append("stream", new File([new Uint8Array([9, 9])], "song.m4a", { type: "audio/mp4" }));
    const res = await upload(form);
    expect(res.status).toBe(201);
    const { track } = (await res.json()) as {
      track: { id: string; originalKey: string; streamKey: string };
    };
    expect(track.streamKey).not.toBe(track.originalKey);
    expect(track.streamKey).toContain(".stream.m4a");

    // both objects really exist in the bucket
    const bucket = env.DEMOS_BUCKET as {
      get: (k: string) => Promise<{ body: unknown } | null>;
    };
    expect(await bucket.get(track.originalKey)).not.toBeNull();
    expect(await bucket.get(track.streamKey)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/api -- upload-rendition`
Expected: the second test FAILS — `streamKey` currently always equals `originalKey`.

- [ ] **Step 3: Read the rendition part in the handler**

In `packages/api/src/routes/tracks.ts`, alongside the other `formData.get` calls near line 32, add:

```ts
  const streamFile = formData.get("stream") as File | null;
```

- [ ] **Step 4: Store it and point streamKey at it**

Replace the `// store original in R2` block and the `streamKey: key` line. After the existing `bucket.put(key, ...)` call, add:

```ts
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
```

and change the insert to `streamKey,` (dropping the old comment).

- [ ] **Step 5: Run the tests**

Run: `npm test -w packages/api && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/tracks.ts packages/api/src/routes/upload-rendition.test.ts
git commit -m "feat(api): accept an optional pre-encoded stream rendition on upload"
```

---

### Task 2: Download route for the original

**Files:**
- Modify: `packages/api/src/routes/tracks.ts` (add a route after `/:id/stream`, which ends around line 139)
- Test: `packages/api/src/routes/download.test.ts` (create)

**Interfaces:**
- Consumes: `streamKey` may now differ from `originalKey` (Task 1).
- Produces: `GET /tracks/:id/download` → the object at `originalKey`, with `Content-Disposition: attachment`. Same gating as `/:id/stream`.

**Why this is required, not polish:** `originalKey` is currently referenced only by the delete path. The original is reachable today *purely because the two keys are identical*. Once Task 1 ships, the master is stored, billed and unreachable without this route.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/routes/download.test.ts`:

```ts
// The original upload must stay reachable once streamKey diverges from
// originalKey, and must be gated exactly like /stream — an unauthenticated
// caller gets the same non-enumerable 404, not a 401.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, sessions } from "../db/schema.js";

let db: Database;
let env: Record<string, unknown>;
let ownerToken: string;
let strangerToken: string;
let trackId: string;

const ORIGINAL_BYTES = new Uint8Array([11, 22, 33, 44, 55]);

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  const root = await mkdtemp(join(tmpdir(), "dl-download-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [owner] = await db
    .insert(users)
    .values({ email: "dl-owner@test.dev", passwordHash: "x" })
    .returning();
  const [stranger] = await db
    .insert(users)
    .values({ email: "dl-stranger@test.dev", passwordHash: "x" })
    .returning();
  ownerToken = "dl-owner-token";
  strangerToken = "dl-stranger-token";
  const expiresAt = new Date(Date.now() + 3600_000);
  await db.insert(sessions).values([
    { userId: owner.id, token: ownerToken, expiresAt },
    { userId: stranger.id, token: strangerToken, expiresAt },
  ]);

  // upload a library track with a distinct rendition, so original != stream
  const form = new FormData();
  form.append("file", new File([ORIGINAL_BYTES], "master.wav", { type: "audio/wav" }));
  form.append("stream", new File([new Uint8Array([7, 7])], "master.m4a", { type: "audio/mp4" }));
  const res = await app.request(
    "/tracks/upload",
    { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: form },
    env,
  );
  const body = (await res.json()) as { track: { id: string } };
  trackId = body.track.id;
});

describe("GET /tracks/:id/download", () => {
  it("serves the original bytes to the owner, not the rendition", async () => {
    const res = await app.request(
      `/tracks/${trackId}/download`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(ORIGINAL_BYTES));
  });

  it("404s for a stranger", async () => {
    const res = await app.request(
      `/tracks/${trackId}/download`,
      { headers: { Authorization: `Bearer ${strangerToken}` } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("404s with no credentials at all", async () => {
    const res = await app.request(`/tracks/${trackId}/download`, {}, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/api -- download`
Expected: FAIL — the route does not exist, so every request 404s including the owner's.

- [ ] **Step 3: Add the route**

In `packages/api/src/routes/tracks.ts`, immediately after the `/:id/stream` handler, add:

```ts
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
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w packages/api && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tracks.ts packages/api/src/routes/download.test.ts
git commit -m "feat(api): download route for the original upload"
```

---

### Task 3: Browser AAC encoder

**Files:**
- Modify: `packages/web/src/lib/peaks.ts` (export the decode step)
- Create: `packages/web/src/lib/transcode.ts`
- Create: `packages/web/src/lib/transcode.test.ts`
- Modify: `packages/web/package.json` (add `mp4-muxer`)

**Interfaces:**
- Produces:
  - `decodeAudioFile(file: File): Promise<AudioBuffer>` exported from `peaks.ts`
  - `peaksFromBuffer(buffer: AudioBuffer): PeaksResult` exported from `peaks.ts`
  - `encodeToAac(buffer: AudioBuffer, bitrate?: number): Promise<Blob | null>` exported from `transcode.ts` — resolves `null` whenever encoding is impossible or fails, never throws
  - `STREAM_BITRATE = 256_000` exported from `transcode.ts`

**On the dependency:** `AudioEncoder` emits raw AAC chunks; they need muxing into MP4 to get a seekable file with a duration index. `mp4-muxer` is ~10 kB and does exactly that. This is a `packages/web` dependency — the zero-runtime-dependency rule applies to `packages/cli`, not here. Do not reach for `MediaRecorder` instead: it records in real time, so a four-minute song would take four minutes.

- [ ] **Step 1: Add the dependency**

Run: `npm install mp4-muxer -w packages/web`

- [ ] **Step 2: Split the decode out of peaks.ts**

In `packages/web/src/lib/peaks.ts`, replace the body of `extractPeaks` so the decode and the peak derivation are separately callable, keeping `extractPeaks` working for existing callers:

```ts
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();

  // Some browsers still gate AudioContext behind the webkit prefix
  const Ctx: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    // close eagerly so we don't pile up contexts during multi-file uploads
    if (ctx.state !== "closed") {
      ctx.close().catch(() => {});
    }
  }
}

export async function extractPeaks(file: File): Promise<PeaksResult> {
  return peaksFromBuffer(await decodeAudioFile(file));
}
```

Then rename the remainder of the old `extractPeaks` body — everything from `const channelData = audioBuffer.getChannelData(0);` onward — into:

```ts
export function peaksFromBuffer(audioBuffer: AudioBuffer): PeaksResult {
```

using `audioBuffer` as the parameter name so the existing body needs no edits.

- [ ] **Step 3: Write the failing test**

Create `packages/web/src/lib/transcode.test.ts`:

```ts
// encodeToAac must NEVER throw: an upload is not allowed to fail because the
// browser couldn't encode. Every impossible or broken path resolves null and
// the caller uploads the original alone.
import { describe, it, expect, afterEach } from "vitest";
import { encodeToAac, STREAM_BITRATE } from "./transcode";

const originalAudioEncoder = (globalThis as Record<string, unknown>).AudioEncoder;

afterEach(() => {
  (globalThis as Record<string, unknown>).AudioEncoder = originalAudioEncoder;
});

function fakeBuffer(): AudioBuffer {
  return {
    numberOfChannels: 2,
    sampleRate: 44100,
    length: 44100,
    duration: 1,
    getChannelData: () => new Float32Array(44100),
  } as unknown as AudioBuffer;
}

describe("encodeToAac", () => {
  it("targets 256 kbps", () => {
    expect(STREAM_BITRATE).toBe(256_000);
  });

  it("resolves null when WebCodecs is unavailable", async () => {
    delete (globalThis as Record<string, unknown>).AudioEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });

  it("resolves null instead of throwing when the encoder errors", async () => {
    class ExplodingEncoder {
      constructor(private opts: { error: (e: Error) => void }) {}
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {
        throw new Error("unsupported config");
      }
      encode() {}
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = ExplodingEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -w packages/web -- transcode`
Expected: FAIL — `./transcode` does not exist.

- [ ] **Step 5: Implement the encoder**

Create `packages/web/src/lib/transcode.ts`:

```ts
// Encode a decoded AudioBuffer to AAC-LC in MP4, for streaming.
//
// Why this exists: uploads are streamed as they arrive, so a WAV streams at
// ~1.4 Mbit/s sustained — more than Spotify's own lossless tier — which breaks
// up on a cellular connection. 256k AAC is ~5.5x less data and matches what
// Spotify Premium serves on the web.
//
// Why in the browser: a Cloudflare Worker can't run ffmpeg. Doing this
// server-side would make good playback conditional on self-hosting under
// Docker, which breaks the "no hardware at all" promise.
//
// This function NEVER throws. WebCodecs is secure-context-only and its codec
// support varies; any failure resolves null and the caller uploads the
// original alone, which is exactly the behaviour that shipped before.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export const STREAM_BITRATE = 256_000;

export async function encodeToAac(
  buffer: AudioBuffer,
  bitrate: number = STREAM_BITRATE,
): Promise<Blob | null> {
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  if (!Encoder) return null;

  try {
    const numberOfChannels = Math.min(buffer.numberOfChannels, 2);
    const config: AudioEncoderConfig = {
      codec: "mp4a.40.2", // AAC-LC
      sampleRate: buffer.sampleRate,
      numberOfChannels,
      bitrate,
    };

    const support = await Encoder.isConfigSupported?.(config);
    if (support && support.supported === false) return null;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      audio: { codec: "aac", sampleRate: buffer.sampleRate, numberOfChannels },
      fastStart: "in-memory",
    });

    let failed = false;
    const encoder = new Encoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: () => {
        failed = true;
      },
    });
    encoder.configure(config);

    // Feed the whole buffer in ~1s slices; interleaved f32 is what
    // AudioData expects for this format.
    const frame = buffer.sampleRate;
    for (let offset = 0; offset < buffer.length && !failed; offset += frame) {
      const count = Math.min(frame, buffer.length - offset);
      const interleaved = new Float32Array(count * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < count; i++) {
          interleaved[i * numberOfChannels + ch] = data[offset + i];
        }
      }
      encoder.encode(
        new AudioData({
          format: "f32",
          sampleRate: buffer.sampleRate,
          numberOfFrames: count,
          numberOfChannels,
          timestamp: Math.round((offset / buffer.sampleRate) * 1_000_000),
          data: interleaved,
        }),
      );
    }

    await encoder.flush();
    encoder.close();
    if (failed) return null;

    muxer.finalize();
    return new Blob([target.buffer], { type: "audio/mp4" });
  } catch {
    // Encoding is an optimisation. Never let it fail an upload.
    return null;
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w packages/web && npm run typecheck && npm run lint`
Expected: PASS. If `AudioEncoderConfig` or `AudioData` are missing from the TS lib, add `"dom"` types as needed — do not silence with `any`.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/transcode.ts packages/web/src/lib/transcode.test.ts \
        packages/web/src/lib/peaks.ts packages/web/package.json package-lock.json
git commit -m "feat(web): 256k AAC encoder for streaming renditions"
```

---

### Task 4: Wire encoding into the upload queue

**Files:**
- Modify: `packages/web/src/lib/use-upload-queue.ts`
- Modify: `packages/web/src/lib/api.ts:175-192` (the `upload` client)
- Modify: `packages/web/src/components/PendingTrackRow.tsx`

**Interfaces:**
- Consumes: `decodeAudioFile`, `peaksFromBuffer` (peaks.ts), `encodeToAac` (transcode.ts) — all from Task 3.
- Produces: `PendingUpload.status` gains `"encoding"`; `tracksApi.upload` accepts `opts.stream?: Blob`.

**The decode is shared.** `extractPeaks` already decodes the whole file. Decoding a 24 MB WAV twice is wasteful, so the queue now decodes once and feeds both the peak extraction and the encoder.

- [ ] **Step 1: Send the rendition from the API client**

In `packages/web/src/lib/api.ts`, add `stream?: Blob;` to the `opts` type of `tracks.upload`, and after the `formData.append("file", file)` line add:

```ts
      if (opts?.stream) formData.append("stream", opts.stream, `${file.name}.m4a`);
```

- [ ] **Step 2: Add the encoding status and share the decode**

In `packages/web/src/lib/use-upload-queue.ts`, change the status union to:

```ts
  status: "decoding" | "encoding" | "ready" | "uploading" | "error";
```

add `stream?: Blob;` to `PendingUpload`, and replace the import line and the `items.forEach` block with:

```ts
import { decodeAudioFile, peaksFromBuffer } from "./peaks";
import { encodeToAac } from "./transcode";
```

```ts
    // Decode once, then derive both the waveform and the streaming rendition
    // from the same AudioBuffer — decoding a 24MB WAV twice is pure waste.
    // Both are optimisations: any failure still yields a working upload.
    items.forEach(async (item) => {
      let buffer: AudioBuffer | null = null;
      try {
        buffer = await decodeAudioFile(item.file);
        const { peaks, duration } = peaksFromBuffer(buffer);
        update(item.id, {
          status: "encoding",
          waveformData: JSON.stringify(peaks),
          duration,
        });
      } catch {
        // undecodable in this browser — upload the original as-is
        update(item.id, { status: "ready" });
        return;
      }
      const stream = await encodeToAac(buffer);
      update(item.id, { status: "ready", stream: stream ?? undefined });
    });
```

- [ ] **Step 3: Pass the rendition through on upload**

In the same file's `start()`, add `stream: item.stream,` to the `tracksApi.upload` options object.

- [ ] **Step 4: Surface the phase in the queue row — and gate the start button**

In `packages/web/src/components/PendingTrackRow.tsx`, add alongside the existing flags at line 17:

```tsx
  const isEncoding = item.status === "encoding";
```

After the existing `{isDecoding && (…)}` block (around line 102-113), add the matching branch:

```tsx
      {isEncoding && (
        <span
          className="dots"
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            position: "relative",
          }}
        >
          encoding
        </span>
      )}
```

**Then fix the start button, which is the part that matters.** Line 115 currently reads
`{!isUploading && !isDecoding && (` and renders the `[upload]` control. Left as-is, the button
appears *during* encoding and a user could start the upload before the rendition exists — the track
would silently ship without one. Change the condition to:

```tsx
      {!isUploading && !isDecoding && !isEncoding && (
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test -w packages/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/use-upload-queue.ts packages/web/src/lib/api.ts \
        packages/web/src/components/PendingTrackRow.tsx
git commit -m "feat(web): encode a streaming rendition during upload"
```

---

### Task 5: Download affordance on track rows

**Files:**
- Modify: `packages/web/src/lib/api.ts` (add a URL helper next to the existing stream-URL helper)
- Modify: `packages/web/src/components/TrackList.tsx`

**Interfaces:**
- Consumes: `GET /tracks/:id/download` (Task 2).

- [ ] **Step 1: Add the URL helper**

In `packages/web/src/lib/api.ts`, immediately after the existing `streamUrl` helper (line 225-229), add its sibling. Same `?token=` convention — a plain anchor can't send an Authorization header any more than a media element can:

```ts
  downloadUrl: (id: string) => {
    const t = mediaToken();
    const auth = t ? `?token=${encodeURIComponent(t)}` : "";
    return `${API_URL}/tracks/${id}/download${auth}`;
  },
```

- [ ] **Step 2: Add the link**

In `packages/web/src/components/TrackList.tsx`, immediately before the `{/* Delete button */}` block (around line 161), add:

```tsx
            {/* Download the original — the stream is a lossy rendition */}
            <a
              href={tracksApi.downloadUrl(track.id)}
              download
              onClick={(e) => e.stopPropagation()}
              title="Download the original file"
              aria-label={`Download ${track.title}`}
              style={{
                color: "var(--fg-dim)",
                fontFamily: "var(--font)",
                fontSize: "12px",
                padding: "0 0.25rem",
                textDecoration: "none",
              }}
            >
              [↓]
            </a>
```

`stopPropagation` matters: the row itself is clickable to select and play a track, and without it a
download click would also start playback.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm test -w packages/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/components/TrackList.tsx
git commit -m "feat(web): download the original from a track row"
```

---

### Task 6: Correct the quality claims

**Files:**
- Modify: `site/index.html`
- Modify: `README.md`
- Modify: `llms.txt`
- Modify: `docs/embed.md` if it repeats the claim

The product no longer streams the uploaded file byte-for-byte, and three surfaces currently say it does. Leaving them is shipping a false claim.

- [ ] **Step 1: Find every instance**

Run: `grep -rn "no transcode\|24-bit WAV comes back\|as you uploaded them\|no quality loss" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs/superpowers .`

- [ ] **Step 2: Rewrite each to the two-tier claim**

The replacement idea, adapted to each surface's voice: **streams reliably, downloads exactly.** For `site/index.html`, the "what you get" bullet becomes something of this shape:

```html
      <li><strong>Your masters, kept whole.</strong> Playback streams at 256k AAC so it holds up on a phone in a car — the same quality Spotify serves on the web. The original file is always one click away, untouched.</li>
```

Do not claim lossless *streaming* anywhere. Do not delete the quality story — the point is that the master survives, which is still true and still differentiating.

Leave everything under `docs/superpowers/` alone; those are dated records of past decisions.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Re-run the Step 1 grep and confirm only `docs/superpowers/` hits remain.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: streams reliably, downloads exactly"
```

---

### Task 7: Whole-branch review and real-file verification

- [ ] **Step 1: Run every check**

```bash
npm run typecheck && npm run lint
npm test -w packages/api && npm test -w packages/web && npm test -w packages/player && npm test -w packages/cli
```

- [ ] **Step 2: Verify against a real audio file in a real browser**

Unit tests cannot prove the encoder produces a playable file. Start the dev server pointed at a live instance, upload an actual WAV through the UI, then confirm:

- the queue shows `encoding…` then uploads
- `GET /tracks/:id/stream` returns `content-type: audio/mp4` and is roughly 5–6× smaller than the original
- the track plays and **seeks** correctly (this is what the MP4 muxing is for — a stream that plays but can't seek means the muxer output is wrong)
- `GET /tracks/:id/download` returns the original, byte-identical, with a sensible filename

Record the measured sizes and bitrates in the report.

- [ ] **Step 3: Verify the fallback path**

Upload a file the browser cannot decode (an AIFF, or rename a text file to `.wav`). Expected: the upload still succeeds, `streamKey === originalKey`, and playback behaves as it did before this branch. **An upload that fails here is a release blocker** — it breaks the "upload whatever audio" requirement.

- [ ] **Step 4: Measure on a phone**

Open the dev server on a real handset and upload a full-length WAV. Record how long encoding takes and whether the tab survives. If it's unusable, say so plainly in the report — the fallback exists, but silently taking two minutes on a phone is a product problem worth knowing before release, not after.

- [ ] **Step 5: Request a whole-branch review**

Use the `superpowers:requesting-code-review` skill against the full diff from the branch base.

- [ ] **Step 6: Address findings, then open the PR**

Include the measured before/after sizes and the phone timing in the PR body.

---

## Deliberate deviation from the spec

The spec called for a configurable `STREAM_BITRATE` "read by the client from the existing config
surface". **There is no such surface** — the web app has no runtime configuration mechanism, so this
would mean inventing one (an endpoint or a build-time variable, threaded into the bundle) to expose a
single number.

`STREAM_BITRATE` is therefore an exported constant in `transcode.ts`, and `encodeToAac` takes an
optional `bitrate` argument, so a self-hoster forking the project can change it in one line. Building
the config plumbing can wait until someone actually asks for a different bitrate. Recorded here
rather than silently dropped.

Existing tracks likewise need no work: they keep `streamKey === originalKey` and stream exactly as
they do now. There is no backfill, and on the Cloudflare target there is no server to run one on —
re-uploading a track is what produces a rendition.

## Release note

The web app ships inside the CLI tarball, so this reaches installed instances only via a new `demo-locker` release: bump `packages/cli/package.json`, tag `cli-vX.Y.Z`, push the tag. Existing instances then need the new assets deployed against their existing resources — the wizard has no upgrade path, so that is currently a manual `wrangler deploy` with a hand-written config pointing at the instance's Worker, D1 and R2 names.
