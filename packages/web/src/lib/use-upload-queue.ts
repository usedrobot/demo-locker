import { useRef, useState } from "react";
import { tracks as tracksApi } from "./api";
import { decodeAudioFile, peaksFromBuffer } from "./peaks";
import { encodeToAac } from "./transcode";
import { randomId } from "./ids";

export type PendingUpload = {
  id: string;
  file: File;
  title: string;
  progress: number; // 0..1
  status: "decoding" | "encoding" | "ready" | "uploading" | "error";
  error?: string;
  waveformData?: string;
  duration?: number;
  stream?: Blob;
};

// How many files we decode/encode at once. Preparing a file holds its decoded
// AudioBuffer in memory for the whole encode — a 4-minute 48k stereo WAV is
// ~90MB decoded — so an unbounded fan-out over a dropped folder is an OOM on a
// tablet, which loses the entire queue. Two in flight keeps the main thread
// busy without letting resident memory scale with the drop size.
export const MAX_CONCURRENT_PREPARES = 2;

// Upload-queue state machine, shared by any page that accepts uploads.
// Pass playlistId: null to upload straight into the user's library.
export function useUploadQueue(playlistId: string | null, onUploaded: () => void) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const waitingRef = useRef<(() => Promise<void>)[]>([]);
  const activeRef = useRef(0);

  function update(id: string, patch: Partial<PendingUpload>) {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function remove(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  function queue(files: File[]) {
    const items: PendingUpload[] = files.map((file) => ({
      id: randomId(),
      file,
      title: file.name.replace(/\.[^.]+$/, ""),
      progress: 0,
      status: "decoding",
    }));
    setPending((prev) => [...prev, ...items]);

    waitingRef.current.push(...items.map((item) => () => prepare(item)));
    pump();
  }

  // Decode once, then derive both the waveform and the streaming rendition
  // from the same AudioBuffer — decoding a 24MB WAV twice is pure waste.
  // Both are optimisations: any failure still yields a working upload.
  async function prepare(item: PendingUpload) {
    let buffer: AudioBuffer;
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

    // encodeToAac is documented never to throw, but this is the only await
    // between "encoding" and "ready": a throw here would strand the item in
    // "encoding" forever, and PendingTrackRow gates [upload] on that status,
    // so the file could never be uploaded at all. Backstop it.
    let stream: Blob | null = null;
    try {
      stream = await encodeToAac(buffer);
    } catch {
      stream = null;
    }
    update(item.id, { status: "ready", stream: stream ?? undefined });
  }

  // Fixed-size worker pool over the waiting list.
  function pump() {
    while (activeRef.current < MAX_CONCURRENT_PREPARES && waitingRef.current.length > 0) {
      const task = waitingRef.current.shift()!;
      activeRef.current++;
      void task().finally(() => {
        activeRef.current--;
        pump();
      });
    }
  }

  async function start(id: string) {
    const item = pending.find((p) => p.id === id);
    if (!item) return;
    update(id, { status: "uploading", progress: 0, error: undefined });
    try {
      await tracksApi.upload(playlistId, item.file, {
        title: item.title.trim() || undefined,
        waveformData: item.waveformData,
        duration: item.duration,
        stream: item.stream,
        onProgress: (pct) => update(id, { progress: pct }),
      });
      remove(id);
      onUploaded();
    } catch (err) {
      update(id, {
        status: "error",
        error: err instanceof Error ? err.message : "upload failed",
      });
    }
  }

  return { pending, queue, start, remove, update };
}

