import { useState, useEffect } from "react";
import type { Track } from "../lib/api";
import { tracks as tracksApi } from "../lib/api";
import { player } from "../lib/audio";

type Props = {
  tracks: Track[];
  onReorder: (trackIds: string[]) => void;
  onDelete?: (trackId: string) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function ProgressBar({ trackId }: { trackId: string }) {
  const [state, setState] = useState(player.getState());

  useEffect(() => player.subscribe(setState), []);

  if (state.track?.id !== trackId || !state.duration) return null;

  const pct = (state.currentTime / state.duration) * 100;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "2px",
        background: "var(--border)",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "var(--accent)",
          transition: "width 0.3s linear",
        }}
      />
    </div>
  );
}

export default function TrackList({ tracks, onReorder, onDelete, selectedId, onSelect }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState(player.getState());

  useEffect(() => player.subscribe(setPlayerState), []);

  function handleDragStart(index: number) {
    setDragIndex(index);
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;

    const reordered = [...tracks];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(index, 0, moved);
    onReorder(reordered.map((t) => t.id));
    setDragIndex(index);
  }

  function handleDragEnd() {
    setDragIndex(null);
  }

  async function handleDelete(e: React.MouseEvent, trackId: string) {
    e.stopPropagation();
    if (confirmDeleteId !== trackId) {
      setConfirmDeleteId(trackId);
      return;
    }
    await tracksApi.delete(trackId);
    if (player.getState().track?.id === trackId) player.clear();
    setConfirmDeleteId(null);
    onDelete?.(trackId);
  }

  if (tracks.length === 0) {
    return (
      <div style={{ color: "var(--fg)", padding: "1rem 0" }}>
        no tracks yet
      </div>
    );
  }

  return (
    <div>
      {tracks.map((track, i) => {
        const isPlaying = playerState.track?.id === track.id && playerState.playing;
        const isSelected = selectedId === track.id;

        return (
          <div
            key={track.id}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            onClick={() => {
              onSelect?.(track.id);
              player.play(track.id);
            }}
            title="Click to play · Drag to reorder"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.5rem 0.25rem",
              borderBottom: "1px solid var(--border)",
              cursor: "grab",
              opacity: dragIndex === i ? 0.4 : 1,
              background: isSelected ? "rgba(68,170,255,0.06)" : "transparent",
              position: "relative",
            }}
          >
            {/* Drag handle */}
            <span
              style={{ color: "var(--fg-dim)", fontSize: "11px", cursor: "grab", userSelect: "none" }}
              title="Drag to reorder"
            >
              ⠿
            </span>

            {/* Track number */}
            <span style={{ color: "var(--fg-dim)", width: "2ch", textAlign: "right", fontSize: "12px" }}>
              {String(i + 1).padStart(2, "0")}
            </span>

            {/* Playing indicator */}
            <span style={{ width: "1.5ch", color: "var(--accent)", fontSize: "12px" }}>
              {isPlaying ? "▶" : ""}
            </span>

            {/* Title */}
            <span style={{ flex: 1, color: "var(--fg)" }}>{track.title}</span>

            {/* Status */}
            {!track.streamKey && (
              <span style={{ color: "var(--fg-dim)", fontSize: "11px" }}>
                processing...
              </span>
            )}

            {/* Duration */}
            <span style={{ color: "var(--fg-dim)", fontSize: "12px", width: "5ch", textAlign: "right" }}>
              {track.duration ? formatDuration(track.duration) : "--:--"}
            </span>

            {/* Download the original — the stream is a lossy rendition */}
            <a
              href={tracksApi.downloadUrl(track.id)}
              download
              onClick={(e) => e.stopPropagation()}
              title="Download the original file"
              aria-label={`Download original file for ${track.title}`}
              style={{
                color: "var(--fg-dim)",
                fontFamily: "var(--font)",
                fontSize: "12px",
                padding: "0 0.25rem",
                textDecoration: "none",
              }}
            >
              [↓]
            </a>

            {/* Delete button */}
            {onDelete && (
              <button
                onClick={(e) => handleDelete(e, track.id)}
                onMouseLeave={() => setConfirmDeleteId(null)}
                title={confirmDeleteId === track.id ? "Click again to remove" : "Remove track"}
                aria-label={`Remove track ${track.title}`}
                style={{
                  background: "none",
                  border: "none",
                  color: confirmDeleteId === track.id ? "var(--error)" : "var(--fg-dim)",
                  fontFamily: "var(--font)",
                  fontSize: "12px",
                  cursor: "pointer",
                  padding: "0 0.25rem",
                }}
              >
                {confirmDeleteId === track.id ? "[delete?]" : "[x]"}
              </button>
            )}

            {/* Progress bar for playing track */}
            <ProgressBar trackId={track.id} />
          </div>
        );
      })}
    </div>
  );
}
