import { useState } from "react";
import { tracks as tracksApi } from "./api";
import { extractPeaks } from "./peaks";
import { randomId } from "./ids";

export type PendingUpload = {
  id: string;
  file: File;
  title: string;
  progress: number; // 0..1
  status: "decoding" | "ready" | "uploading" | "error";
  error?: string;
  waveformData?: string;
  duration?: number;
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

    // decode peaks in the background so they're ready by the time the user
    // hits [upload] — failures here are non-fatal, the upload still works
    // without waveform data.
    items.forEach(async (item) => {
      try {
        const { peaks, duration } = await extractPeaks(item.file);
        update(item.id, {
          status: "ready",
          waveformData: JSON.stringify(peaks),
          duration,
        });
      } catch {
        update(item.id, { status: "ready" });
      }
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

