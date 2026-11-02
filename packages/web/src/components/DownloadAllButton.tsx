import { useState, type CSSProperties } from "react";
import type { Track } from "../lib/api";
import { buildPlaylistZip, saveBlob, zipFileName } from "../lib/download-all";

// [↓ all] — the whole playlist's originals as one zip, in playlist order.
// Shown to anyone who can see the per-track [↓] (owner, collaborators and
// share-link listeners alike), since it fetches through that same route.
export default function DownloadAllButton({
  tracks,
  playlistName,
  style,
}: {
  tracks: Track[];
  playlistName: string;
  style?: CSSProperties;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (tracks.length === 0) return null;

  async function run() {
    setError("");
    setProgress(`0/${tracks.length}`);
    try {
      const blob = await buildPlaylistZip(tracks, (done, total) => setProgress(`${done}/${total}`));
      saveBlob(blob, zipFileName(playlistName));
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't build the zip");
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={progress !== null}
        aria-label={`Download all ${tracks.length} tracks as a zip`}
        title="Download every original in this playlist as one zip"
        style={{
          background: "none",
          border: "none",
          fontFamily: "var(--font)",
          fontSize: "13px",
          padding: 0,
          cursor: progress ? "progress" : "pointer",
          color: "var(--accent)",
          ...style,
        }}
      >
        {progress ? `[zipping ${progress}…]` : "[↓ all]"}
      </button>
      {error && (
        <span role="alert" style={{ color: "#f44", fontSize: "12px", flexBasis: "100%" }}>
          {error}
        </span>
      )}
    </>
  );
}
