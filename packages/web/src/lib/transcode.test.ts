// encodeToAac must NEVER throw: an upload is not allowed to fail because the
// browser couldn't encode. Every impossible or broken path resolves null and
// the caller uploads the original alone.
import { describe, it, expect, afterEach } from "vitest";
import { encodeToAac, STREAM_BITRATE } from "./transcode";

const originalAudioEncoder = (globalThis as Record<string, unknown>).AudioEncoder;
const originalAudioData = (globalThis as Record<string, unknown>).AudioData;
const originalEncodedAudioChunk = (globalThis as Record<string, unknown>).EncodedAudioChunk;

afterEach(() => {
  (globalThis as Record<string, unknown>).AudioEncoder = originalAudioEncoder;
  (globalThis as Record<string, unknown>).AudioData = originalAudioData;
  (globalThis as Record<string, unknown>).EncodedAudioChunk = originalEncodedAudioChunk;
});

function fakeBuffer(overrides: Partial<AudioBuffer> = {}): AudioBuffer {
  return {
    numberOfChannels: 2,
    sampleRate: 44100,
    length: 44100,
    duration: 1,
    getChannelData: () => new Float32Array(44100),
    ...overrides,
  } as unknown as AudioBuffer;
}

// Minimal stand-in for the platform AudioData so encoder.encode(...) has
// something real to hold and close(); mp4-muxer never touches this class.
class FakeAudioData {
  closed = false;
  close() {
    this.closed = true;
  }
}

// mp4-muxer's addAudioChunk() requires `sample instanceof EncodedAudioChunk`,
// so the fake encoder's `output` callback must hand it a real instance of
// this class (registered as the global) rather than a plain object.
class FakeEncodedAudioChunk {
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  byteLength: number;
  constructor(opts: { type: "key" | "delta"; timestamp: number; duration: number; byteLength: number }) {
    this.type = opts.type;
    this.timestamp = opts.timestamp;
    this.duration = opts.duration;
    this.byteLength = opts.byteLength;
  }
  copyTo(dest: Uint8Array) {
    dest.set(new Uint8Array(this.byteLength));
  }
}

function installFakeCodecTypes() {
  (globalThis as Record<string, unknown>).AudioData = FakeAudioData;
  (globalThis as Record<string, unknown>).EncodedAudioChunk = FakeEncodedAudioChunk;
}

describe("encodeToAac", () => {
  it("targets 256 kbps", () => {
    expect(STREAM_BITRATE).toBe(256_000);
  });

  it("resolves null when WebCodecs is unavailable", async () => {
    delete (globalThis as Record<string, unknown>).AudioEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });

  it("resolves null instead of throwing when configure() throws", async () => {
    class ExplodingEncoder {
      constructor() {}
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

  it("resolves a Blob on a successful encode", async () => {
    installFakeCodecTypes();
    class WorkingEncoder {
      output: (chunk: FakeEncodedAudioChunk, meta?: unknown) => void;
      constructor(opts: { output: (chunk: FakeEncodedAudioChunk, meta?: unknown) => void; error: (e: Error) => void }) {
        this.output = opts.output;
      }
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {}
      encode() {
        this.output(
          new FakeEncodedAudioChunk({ type: "key", timestamp: 0, duration: 1_000_000, byteLength: 4 }),
          {},
        );
      }
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = WorkingEncoder;
    const result = await encodeToAac(fakeBuffer());
    expect(result).toBeInstanceOf(Blob);
  });

  it("resolves null when the encoder's error callback fires mid-encode", async () => {
    installFakeCodecTypes();
    class FailingMidEncoder {
      error: (e: Error) => void;
      constructor(opts: { output: () => void; error: (e: Error) => void }) {
        this.error = opts.error;
      }
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {}
      encode() {
        this.error(new Error("hardware encoder reset"));
      }
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = FailingMidEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });

  it("resolves null when isConfigSupported rejects", async () => {
    class RejectingEncoder {
      constructor() {}
      static isConfigSupported() {
        return Promise.reject(new TypeError("invalid config"));
      }
      configure() {}
      encode() {}
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = RejectingEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });

  it("resolves null when flush() rejects", async () => {
    installFakeCodecTypes();
    class FlushRejectsEncoder {
      constructor() {}
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {}
      encode() {}
      flush() {
        return Promise.reject(new Error("flush failed"));
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = FlushRejectsEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });

  it("resolves null for a zero-length buffer without touching the encoder", async () => {
    class UnusedEncoder {
      constructor() {
        throw new Error("should never be constructed for a degenerate buffer");
      }
    }
    (globalThis as Record<string, unknown>).AudioEncoder = UnusedEncoder;
    await expect(encodeToAac(fakeBuffer({ length: 0 }))).resolves.toBeNull();
  });
});
