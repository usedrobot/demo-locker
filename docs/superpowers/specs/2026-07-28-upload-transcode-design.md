# Upload-Time Transcode — Design

**Date:** 2026-07-28
**Deliverable:** a 256k AAC streaming rendition produced at upload, with the original preserved and downloadable

## Problem

Playback breaks up in a car. Measured rather than assumed:

- The source master (`Midnight Under the Palms 9.17.25.wav`) is **2 ch, 44100 Hz, Int16 — 1,411,200 bps**. Already CD quality, so capping sample rate or bit depth would be a no-op.
- The master is **clean**: peak −0.71 dB, flat factor 0.000, peak count 2. The pops are not in the file.
- **Range requests work**: both WAV and AAC tracks return `206` with correct `content-range` and `accept-ranges`. Not a partial-content bug.

That leaves bandwidth. Demo Locker performs **no transcoding on any target** — `tracks.ts:83` sets `streamKey = key` with the comment "serve original directly until transcoding is added" — so a WAV streams at 1.41 Mbit/s sustained. For scale, Spotify Premium's web player is 256k AAC and its *lossless* tier is FLAC at roughly 900 kbps. We were asking a browser to sustain more data than Spotify's premium lossless tier, over cellular, in a moving car.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Format | **AAC-LC, 256 kbps, in MP4** | Level with Spotify Premium web, 2× SoundCloud's free upload. AAC at 256k outperforms Vorbis at 320k in most listening tests. Broadest playback support, including car head units via a phone. |
| When | **At upload**, once | On-the-fly transcoding breaks seeking (you cannot range-request a stream you are generating), redoes the work every play, and spikes CPU per listener. |
| Where | **In the browser** | Works on every deploy target. A Worker cannot run ffmpeg, so a server-side-only design would make good playback conditional on choosing Docker — which breaks the "no hardware at all, deploy to Cloudflare" promise the brochure makes. |
| Original | **Kept, and made downloadable** | Lossless is the product's quality story. Costs ~1.15× storage. |
| Undecodable input | **Fall back to serving the original** | "Upload whatever audio" is a requirement. An upload must never fail because we could not encode it. |
| Server-side transcode on Docker | **Not now** | Two implementations of one job, and a locker that behaves differently depending on hosting. Revisit only if upload time becomes a real complaint. |

## The schema already supports this

`tracks` has `originalKey` (NOT NULL) and `streamKey` (nullable) as separate columns, and the delete path at `tracks.ts:195-198` already removes both when they differ. **No migration is required.**

## Architecture

**Upload, in the browser:**

1. Decode the selected file with `AudioContext.decodeAudioData`.
2. Encode to AAC-LC 256k via `WebCodecs` `AudioEncoder`, muxed to MP4.
3. Post both files in the existing multipart upload: `file` (original, unchanged) and a new optional `stream` part.

**Upload, on the server** (`tracks.ts`):

- Store `file` at the existing key → `originalKey`.
- If a `stream` part is present, store it at a sibling key → `streamKey`.
- If absent, set `streamKey = originalKey`, exactly as today.

Everything downstream already reads `streamKey`, so the player, the public API and the embed all get the compressed rendition with no changes.

### Required: a download route

**`GET /tracks/:id/download` serving `originalKey`.**

This is not optional polish. `originalKey` is currently referenced only by the delete path — the original is reachable today *purely because the two keys are identical*. The moment `streamKey` diverges, the master becomes stored, billed, and unreachable. The route needs the same access gating as `/:id/stream` (owner session or share token, `?token=` query supported since media elements cannot send headers), and should set `Content-Disposition: attachment` with the original filename.

A `[download]` affordance goes on the track row for anyone with access.

### Fallback

If `decodeAudioData` throws, `AudioEncoder` is unavailable, or encoding fails for any reason, the client uploads the original alone and the server sets `streamKey = originalKey`. The user sees a quiet note that the file will stream at full size; the upload succeeds. Browser coverage is good for WAV, MP3, AAC, FLAC and OGG, and patchy for AIFF and unusual sample rates — the fallback is what makes "upload whatever audio" true.

### UI

Encoding a 24 MB WAV is not instant, and the upload queue already renders per-file progress (`PendingTrackRow`). Add an "encoding…" phase ahead of the existing upload progress so the wait is legible rather than a stalled bar.

## Existing tracks

Tracks already uploaded keep `streamKey = originalKey` and continue to stream as they do now. There is no backfill: on the Cloudflare target there is no server to run one on, which is itself an argument for doing this at upload. Re-uploading a track produces a rendition.

## Configuration

`STREAM_BITRATE` (default `256k`), read by the client from the existing config surface, so a self-hoster on a thin connection can lower it. Values are advisory — an unparseable value falls back to the default rather than failing the upload.

## Copy that must change

`site/index.html` currently claims "Rough mixes, streamed as you uploaded them. No transcode, no quality loss — a 24-bit WAV comes back a 24-bit WAV." That stops being true of playback. It becomes two tiers: **streams reliably, downloads exactly.** The same claim appears in `README.md` and `llms.txt` and needs the same treatment.

## Testing

- API: `stream` part present → `streamKey` diverges from `originalKey`; absent → they match; delete removes both objects; `/download` serves the original and enforces the same gating as `/stream` (owner, share token, and a 404 for neither).
- Web: encode helper produces a decodable MP4 at approximately the target bitrate; a decode failure falls back without failing the upload.
- Manual: upload a WAV, confirm `/stream` returns `audio/mp4` at ~256k and `/download` returns the byte-identical original.

## Risks

| Risk | Mitigation |
|---|---|
| The original becomes unreachable | The download route ships in the same change, not later |
| `WebCodecs` unsupported or partial on a target browser | Feature-detect and fall back to original-only; never block an upload |
| Mobile encode is slow or memory-hungry on a large WAV | Surface an encoding phase in the queue; fall back on failure. Measure on a real phone before shipping |
| 256k still pops in the car | The A/B in the *Car Test* playlist answers this first. If B pops too, the cause is Bluetooth or the head unit and no bitrate fixes it |
| Quality claim overstated after the change | Copy updated across site, README and llms.txt in the same change |
