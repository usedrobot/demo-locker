// encodeToAac must NEVER throw: an upload is not allowed to fail because the
// browser couldn't encode. Every impossible or broken path resolves null and
// the caller uploads the original alone.
import { describe, it, expect, afterEach, vi } from "vitest";
import { encodeToAac, STREAM_BITRATE } from "./transcode";

const originalAudioEncoder = (globalThis as Record<string, unknown>).AudioEncoder;
const originalAudioData = (globalThis as Record<string, unknown>).AudioData;
const originalEncodedAudioChunk = (globalThis as Record<string, unknown>).EncodedAudioChunk;

function restoreGlobal(name: string, original: unknown) {
  if (original === undefined) {
    // Delete rather than assign undefined, so `name in globalThis` goes back
    // to false instead of leaving a phantom own-property behind.
    Reflect.deleteProperty(globalThis, name);
  } else {
    (globalThis as Record<string, unknown>)[name] = original;
  }
}

afterEach(() => {
  restoreGlobal("AudioEncoder", originalAudioEncoder);
  restoreGlobal("AudioData", originalAudioData);
  restoreGlobal("EncodedAudioChunk", originalEncodedAudioChunk);
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
// so a fake encoder's `output` callback must hand it a real instance of this
// class (registered as the global) rather than a plain object.
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
    // Installed so that if the configure()-throw were ever neutralised, the
    // rest of the pipeline (AudioData/EncodedAudioChunk construction) would
    // actually run instead of masking the mutation behind an unrelated
    // ReferenceError.
    installFakeCodecTypes();
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

  it("resolves a valid MP4 Blob on a successful encode, closing each AudioData", async () => {
    installFakeCodecTypes();
    const capturedAudioData: FakeAudioData[] = [];
    class WorkingEncoder {
      output: (chunk: FakeEncodedAudioChunk, meta?: unknown) => void;
      constructor(opts: { output: (chunk: FakeEncodedAudioChunk, meta?: unknown) => void; error: (e: Error) => void }) {
        this.output = opts.output;
      }
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {}
      encode(data: FakeAudioData) {
        capturedAudioData.push(data);
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
    expect(result!.type).toBe("audio/mp4");
    expect(result!.size).toBeGreaterThan(0);
    // Proves muxer.finalize() actually ran: an unfinalized ArrayBufferTarget
    // has a null .buffer, and `new Blob([null], ...)` yields a 4-byte blob
    // containing the text "null" rather than MP4 box structure. A real
    // finalized MP4 starts with a box size (4 bytes) followed by "ftyp".
    const bytes = new Uint8Array(await result!.arrayBuffer());
    const ftypTag = String.fromCharCode(...bytes.slice(4, 8));
    expect(ftypTag).toBe("ftyp");

    // Proves finding 4: every AudioData handed to encode() gets closed.
    expect(capturedAudioData.length).toBeGreaterThan(0);
    expect(capturedAudioData.every((d) => d.closed)).toBe(true);
  });

  it("resolves null and closes the encoder when the error callback fires mid-encode", async () => {
    installFakeCodecTypes();
    const closeSpy = vi.fn();
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
      close() {
        closeSpy();
      }
    }
    (globalThis as Record<string, unknown>).AudioEncoder = FailingMidEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
    // Proves finding 2: the platform encoder is released even on a failure
    // path, not just on the success path.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves null when isConfigSupported rejects", async () => {
    // Installed for the same reason as the configure()-throws test above: if
    // the rejection were neutralised, execution should reach real encode
    // logic (and succeed) rather than accidentally returning null via an
    // unrelated missing-global ReferenceError.
    installFakeCodecTypes();
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

  it("resolves null when the muxer rejects an encoded chunk", async () => {
    // AudioData is installed, but EncodedAudioChunk deliberately is not: the
    // encoder's output callback hands the muxer a plain object, so
    // mp4-muxer's internal `instanceof EncodedAudioChunk` check throws. That
    // exercises the try/catch around muxer.addAudioChunk (finding 3) rather
    // than the outer catch-all around the whole function.
    (globalThis as Record<string, unknown>).AudioData = FakeAudioData;
    class ChunkRejectedEncoder {
      output: (chunk: unknown, meta?: unknown) => void;
      constructor(opts: { output: (chunk: unknown, meta?: unknown) => void; error: (e: Error) => void }) {
        this.output = opts.output;
      }
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {}
      encode() {
        this.output({}, {});
      }
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = ChunkRejectedEncoder;
    await expect(encodeToAac(fakeBuffer())).resolves.toBeNull();
  });

  it("resolves null for a degenerate buffer without ever constructing an encoder", async () => {
    let constructed = false;
    class UnusedEncoder {
      constructor() {
        constructed = true;
      }
      static isConfigSupported() {
        return Promise.resolve({ supported: true });
      }
      configure() {}
      encode() {}
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    (globalThis as Record<string, unknown>).AudioEncoder = UnusedEncoder;

    await expect(encodeToAac(fakeBuffer({ length: 0 }))).resolves.toBeNull();
    expect(constructed).toBe(false);

    await expect(encodeToAac(fakeBuffer({ numberOfChannels: 0 }))).resolves.toBeNull();
    expect(constructed).toBe(false);
  });
});
