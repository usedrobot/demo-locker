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
