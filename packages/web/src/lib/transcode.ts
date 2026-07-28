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
