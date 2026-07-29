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

// Rates every AAC-LC decoder in the wild handles happily. Anything else gets
// rendered to CLAMP_RATE before encoding.
const SAFE_SAMPLE_RATES = new Set([44100, 48000]);
export const CLAMP_SAMPLE_RATE = 48000;

// How many AudioData frames we allow to sit in the encoder's queue before we
// stop feeding it. Without this the whole track goes in at once and the
// encoder's internal queue holds a second copy of a multi-hundred-MB decode.
const MAX_ENCODE_QUEUE = 8;

// Belt-and-braces bound so a codec that never fires `dequeue` can't spin here
// forever; we give up waiting and keep feeding rather than hanging the encode.
const MAX_DRAIN_WAITS = 200;

// The sample rate on the AudioBuffer is NOT the file's rate — it's the rate of
// the AudioContext that decoded it (see peaks.ts, which uses the default
// context), i.e. the *device's* rate. On an audio interface running at 96k
// that leaves two silent failure modes: either we ship 96 kHz AAC-LC, which
// older car head units handle badly, or isConfigSupported says no, we return
// null, and the upload quietly falls back to streaming the multi-Mbit
// original — exactly the bug this whole path exists to fix.
//
// Reading the true source rate would mean parsing the container, so we don't
// pretend to "match the source": we clamp anything unusual to 48 kHz, which is
// a rate every decoder handles and is at or above the rate of any real source.
// Channel count is preserved so this changes nothing but the rate.
async function clampSampleRate(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (SAFE_SAMPLE_RATES.has(buffer.sampleRate)) return buffer;
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext })
    .OfflineAudioContext;
  if (!Offline) return buffer;
  try {
    const frames = Math.max(1, Math.ceil(buffer.duration * CLAMP_SAMPLE_RATE));
    const ctx = new Offline(buffer.numberOfChannels, frames, CLAMP_SAMPLE_RATE);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    return await ctx.startRendering();
  } catch {
    // Resampling failed. Hand back the original: isConfigSupported still gets
    // the final say, so the worst case is the pre-existing behaviour.
    return buffer;
  }
}

// Wait until the encoder has chewed through most of its queue. Bounded, and a
// no-op on any implementation that doesn't expose encodeQueueSize.
async function drainEncodeQueue(encoder: AudioEncoder): Promise<void> {
  if (typeof encoder.encodeQueueSize !== "number") return;
  let waits = 0;
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE && waits < MAX_DRAIN_WAITS) {
    waits++;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        encoder.removeEventListener?.("dequeue", done);
        resolve();
      };
      encoder.addEventListener?.("dequeue", done, { once: true });
      // Safety net: some implementations don't fire `dequeue` at all.
      setTimeout(done, 20);
    });
  }
}

export async function encodeToAac(
  buffer: AudioBuffer,
  bitrate: number = STREAM_BITRATE,
): Promise<Blob | null> {
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  if (!Encoder) return null;
  if (buffer.length === 0 || buffer.numberOfChannels === 0) return null;

  let encoder: AudioEncoder | undefined;
  try {
    const source = await clampSampleRate(buffer);
    // NOTE: this is a channel *drop*, not a downmix — on a >2ch source the
    // extra channels (centre, LFE, surrounds) are discarded outright rather
    // than folded into L/R. Fine for the music this app takes; if multichannel
    // masters ever matter, this needs a real downmix matrix.
    const numberOfChannels = Math.min(source.numberOfChannels, 2);
    const config: AudioEncoderConfig = {
      codec: "mp4a.40.2", // AAC-LC
      sampleRate: source.sampleRate,
      numberOfChannels,
      bitrate,
    };

    const support = await Encoder.isConfigSupported?.(config);
    if (support && support.supported === false) return null;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      audio: { codec: "aac", sampleRate: source.sampleRate, numberOfChannels },
      fastStart: "in-memory",
    });

    let failed = false;
    encoder = new Encoder({
      output: (chunk, meta) => {
        try {
          muxer.addAudioChunk(chunk, meta);
        } catch {
          // A dropped/corrupt chunk means the muxed output can no longer be
          // trusted — fail the whole rendition rather than upload a
          // truncated MP4.
          failed = true;
        }
      },
      error: () => {
        failed = true;
      },
    });
    encoder.configure(config);

    // Feed the whole buffer in ~1s slices; interleaved f32 is what
    // AudioData expects for this format.
    const frame = source.sampleRate;
    for (let offset = 0; offset < source.length && !failed; offset += frame) {
      const count = Math.min(frame, source.length - offset);
      const interleaved = new Float32Array(count * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const data = source.getChannelData(ch);
        for (let i = 0; i < count; i++) {
          interleaved[i * numberOfChannels + ch] = data[offset + i];
        }
      }
      const audioData = new AudioData({
        format: "f32",
        sampleRate: source.sampleRate,
        numberOfFrames: count,
        numberOfChannels,
        timestamp: Math.round((offset / source.sampleRate) * 1_000_000),
        data: interleaved,
      });
      try {
        encoder.encode(audioData);
      } finally {
        // encode() copies the data it needs; release the underlying media
        // memory immediately rather than waiting on GC.
        audioData.close();
      }
      // Backpressure: an encoder slower than this loop would otherwise hold
      // the entire track queued up in parallel with the decoded buffer.
      await drainEncodeQueue(encoder);
    }

    await encoder.flush();
    if (failed) return null;

    muxer.finalize();
    return new Blob([target.buffer], { type: "audio/mp4" });
  } catch {
    // Encoding is an optimisation. Never let it fail an upload.
    return null;
  } finally {
    try {
      encoder?.close();
    } catch {
      // Chrome throws InvalidStateError closing an already-errored encoder.
    }
  }
}
