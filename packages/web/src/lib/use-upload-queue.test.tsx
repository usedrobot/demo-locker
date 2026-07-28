// @vitest-environment happy-dom
//
// This layer decides whether a streaming rendition is attached at all, and a
// regression here is invisible: the upload still succeeds, it just silently
// reverts to streaming the multi-Mbit original. So the wiring itself is worth
// asserting, not just encodeToAac in isolation.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useUploadQueue, MAX_CONCURRENT_PREPARES } from "./use-upload-queue";

vi.mock("./peaks", () => ({
  decodeAudioFile: vi.fn(),
  peaksFromBuffer: vi.fn(),
}));
vi.mock("./transcode", () => ({
  encodeToAac: vi.fn(),
}));
vi.mock("./api", () => ({
  tracks: { upload: vi.fn() },
}));

import { decodeAudioFile, peaksFromBuffer } from "./peaks";
import { encodeToAac } from "./transcode";
import { tracks as tracksApi } from "./api";

const decodeMock = vi.mocked(decodeAudioFile);
const peaksMock = vi.mocked(peaksFromBuffer);
const encodeMock = vi.mocked(encodeToAac);
const uploadMock = vi.mocked(tracksApi.upload);

const fakeAudioBuffer = { sampleRate: 48000 } as unknown as AudioBuffer;

function wavFile(name = "demo.wav") {
  return new File([new Uint8Array(8)], name, { type: "audio/wav" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type QueueApi = ReturnType<typeof useUploadQueue>;

// Drives the hook from a throwaway root and records every rendered `pending`
// array, so the status *sequence* — not just the final state — is assertable.
function renderQueue(playlistId: string | null = "playlist-1") {
  // Every render's hook return value, appended in order. Recorded by pushing
  // rather than by assignment: react-hooks' purity rules (rightly) forbid a
  // component writing to an outer variable, and the last element is the
  // current API anyway.
  const renders: QueueApi[] = [];
  const onUploaded = vi.fn();

  function Probe() {
    const queue = useUploadQueue(playlistId, onUploaded);
    renders.push(queue);
    return null;
  }

  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(<Probe />);
  });

  return {
    renders,
    onUploaded,
    get api() {
      return renders[renders.length - 1];
    },
    // Consecutive-deduped status history for the single queued item.
    statuses() {
      const seen: string[] = [];
      for (const render of renders) {
        for (const item of render.pending) {
          if (seen[seen.length - 1] !== item.status) seen.push(item.status);
        }
      }
      return seen;
    },
  };
}

// Lets pending microtasks (the prepare() chain) run to completion.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  decodeMock.mockResolvedValue(fakeAudioBuffer);
  peaksMock.mockReturnValue({ peaks: [0.5, 0.25], duration: 12.5 });
  encodeMock.mockResolvedValue(null);
  uploadMock.mockResolvedValue({ track: { id: "t1" } } as Awaited<ReturnType<typeof tracksApi.upload>>);
});

describe("useUploadQueue", () => {
  it("walks decoding → encoding → ready and hands the rendition to upload()", async () => {
    const rendition = new Blob([new Uint8Array(4)], { type: "audio/mp4" });
    // Gated so each transition renders separately — React would otherwise
    // batch the whole run into one commit and the sequence would be untestable.
    const decodeGate = deferred<AudioBuffer>();
    const encodeGate = deferred<Blob | null>();
    decodeMock.mockReturnValue(decodeGate.promise);
    encodeMock.mockReturnValue(encodeGate.promise);

    const q = renderQueue();
    act(() => {
      q.api.queue([wavFile()]);
    });
    expect(q.api.pending[0].status).toBe("decoding");

    decodeGate.resolve(fakeAudioBuffer);
    await flush();
    expect(q.api.pending[0].status).toBe("encoding");

    encodeGate.resolve(rendition);
    await flush();

    expect(q.statuses()).toEqual(["decoding", "encoding", "ready"]);
    expect(encodeMock).toHaveBeenCalledWith(fakeAudioBuffer);

    const item = q.api.pending[0];
    expect(item.stream).toBe(rendition);
    expect(item.waveformData).toBe(JSON.stringify([0.5, 0.25]));
    expect(item.duration).toBe(12.5);

    await act(async () => {
      await q.api.start(item.id);
    });

    // The whole point: the encoded blob actually reaches the API call.
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [playlistId, file, opts] = uploadMock.mock.calls[0];
    expect(playlistId).toBe("playlist-1");
    expect(file.name).toBe("demo.wav");
    expect(opts?.stream).toBe(rendition);
    expect(opts?.waveformData).toBe(JSON.stringify([0.5, 0.25]));
    expect(q.api.pending).toHaveLength(0);
    expect(q.onUploaded).toHaveBeenCalledTimes(1);
  });

  it("skips encoding entirely when the decode fails, and still uploads the original", async () => {
    const decodeGate = deferred<AudioBuffer>();
    decodeMock.mockReturnValue(decodeGate.promise);

    const q = renderQueue(null);
    act(() => {
      q.api.queue([wavFile("weird.aif")]);
    });
    expect(q.api.pending[0].status).toBe("decoding");

    decodeGate.reject(new Error("unsupported format"));
    await flush();

    expect(q.statuses()).toEqual(["decoding", "ready"]);
    expect(encodeMock).not.toHaveBeenCalled();

    const item = q.api.pending[0];
    expect(item.stream).toBeUndefined();
    expect(item.waveformData).toBeUndefined();

    await act(async () => {
      await q.api.start(item.id);
    });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [playlistId, file, opts] = uploadMock.mock.calls[0];
    expect(playlistId).toBeNull();
    expect(file.name).toBe("weird.aif");
    expect(opts?.stream).toBeUndefined();
  });

  it("lands in ready with no rendition if encodeToAac ever throws", async () => {
    // encodeToAac is contractually null-on-failure, but if that contract were
    // ever broken the item would sit in "encoding" forever and
    // PendingTrackRow would never show [upload] — the file becomes
    // un-uploadable. This is the backstop for that.
    const decodeGate = deferred<AudioBuffer>();
    const encodeGate = deferred<Blob | null>();
    decodeMock.mockReturnValue(decodeGate.promise);
    encodeMock.mockReturnValue(encodeGate.promise);

    const q = renderQueue();
    act(() => {
      q.api.queue([wavFile()]);
    });

    decodeGate.resolve(fakeAudioBuffer);
    await flush();
    expect(q.api.pending[0].status).toBe("encoding");

    encodeGate.reject(new Error("boom"));
    await flush();

    expect(q.statuses()).toEqual(["decoding", "encoding", "ready"]);
    const item = q.api.pending[0];
    expect(item.status).toBe("ready");
    expect(item.stream).toBeUndefined();

    await act(async () => {
      await q.api.start(item.id);
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("prepares at most MAX_CONCURRENT_PREPARES files at a time", async () => {
    // Each decode holds its AudioBuffer for the whole encode; five 4-minute
    // WAVs decoded at once is an OOM on a tablet, which loses the queue.
    const gates = Array.from({ length: 5 }, () => deferred<AudioBuffer>());
    let started = 0;
    decodeMock.mockImplementation(() => gates[started++].promise);

    const q = renderQueue();
    await act(async () => {
      q.api.queue(gates.map((_, i) => wavFile(`take-${i}.wav`)));
    });
    await flush();

    expect(MAX_CONCURRENT_PREPARES).toBeLessThanOrEqual(2);
    expect(started).toBe(MAX_CONCURRENT_PREPARES);

    // Releasing one slot admits exactly one more file, never the whole batch.
    await act(async () => {
      gates[0].resolve(fakeAudioBuffer);
      await gates[0].promise;
    });
    await flush();
    expect(started).toBe(MAX_CONCURRENT_PREPARES + 1);

    // Drain the rest so every file still reaches ready.
    for (let i = 1; i < gates.length; i++) {
      await act(async () => {
        gates[i].resolve(fakeAudioBuffer);
      });
      await flush();
    }
    expect(started).toBe(gates.length);
    expect(q.api.pending.every((p) => p.status === "ready")).toBe(true);
  });
});
