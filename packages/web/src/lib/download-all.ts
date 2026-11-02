// "Download all": zip a playlist's ORIGINALS in the browser, in playlist order.
//
// Client-side on purpose. Zipping on the Worker would spend CPU on every byte
// (CRC32 runs over the whole file) against a per-request CPU budget, and the
// browser can already fetch each original through the same route as the
// per-track [↓] — so access is exactly what that button already grants.
//
// Files are fetched ONE AT A TIME and stored, not deflated (audio does not
// compress). The finished zip is still held in memory until it is saved, so a
// very large playlist is a strain on a phone.
import { downloadZip } from "client-zip";
import { tracks as tracksApi, type Track } from "./api";

// Mirrors the API's AUDIO_TYPES (packages/api/src/lib/media-type.ts). Anything
// else falls back to the stored filename's extension.
const EXTENSION: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/aiff": "aif",
  "audio/x-aiff": "aif",
};

// Path separators, Windows-reserved characters and control characters. A
// title is free text; inside a zip a "/" would become a folder and "../" an
// escape attempt on extraction.
function safe(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-").trim();
  return cleaned || fallback;
}

function extensionFor(contentType: string | null, disposition: string | null): string {
  const bare = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXTENSION[bare]) return EXTENSION[bare];
  const fromName = disposition?.match(/filename\*?=(?:UTF-8'')?"?[^";]*\.([A-Za-z0-9]{1,5})"?/);
  return fromName ? fromName[1].toLowerCase() : "";
}

export function zipEntryName(
  index: number,
  total: number,
  title: string,
  contentType: string | null,
  disposition: string | null,
): string {
  const width = Math.max(2, String(total).length);
  const ext = extensionFor(contentType, disposition);
  const base = `${String(index + 1).padStart(width, "0")} - ${safe(title, "track")}`;
  return ext ? `${base}.${ext}` : base;
}

export function zipFileName(playlistName: string): string {
  return `${safe(playlistName, "playlist")}.zip`;
}

export async function buildPlaylistZip(
  list: Track[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  // A generator, so client-zip pulls the next file only once the previous one
  // has been written: one download in flight at a time.
  async function* entries() {
    for (const [i, track] of list.entries()) {
      onProgress?.(i + 1, list.length);
      const res = await fetch(tracksApi.downloadUrl(track.id));
      if (!res.ok) throw new Error(`couldn't download "${track.title}" (${res.status})`);
      yield {
        name: zipEntryName(
          i,
          list.length,
          track.title,
          res.headers.get("content-type"),
          res.headers.get("content-disposition"),
        ),
        lastModified: track.uploadedAt ? new Date(track.uploadedAt) : undefined,
        input: res,
      };
    }
  }
  return downloadZip(entries()).blob();
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the save in some browsers; give it a beat.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
