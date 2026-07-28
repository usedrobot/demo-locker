import { useState } from "react";
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

// Upload-queue state machine, shared by any page that accepts uploads.
// Pass playlistId: null to upload straight into the user's library.
export function useUploadQueue(playlistId: string | null, onUploaded: () => void) {
  const [pending, setPending] = useState<PendingUpload[]>([]);

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

