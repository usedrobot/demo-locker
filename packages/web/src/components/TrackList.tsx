import { useState } from "react";
import type { Track } from "../lib/api";
import { player } from "../lib/audio";

type Props = {
  tracks: Track[];
  onReorder: (trackIds: string[]) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
};

export default function TrackList({ tracks, onReorder, selectedId, onSelect }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

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

  if (tracks.length === 0) {
    return (
      <div style={{ color: "var(--fg-dim)", padding: "1rem 0" }}>
        no tracks yet
      </div>
    );
  }

  return (
    <div>
      {tracks.map((track, i) => (
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
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            padding: "0.5rem 0",
            borderBottom: "1px solid var(--border)",
            cursor: "pointer",
            opacity: dragIndex === i ? 0.5 : 1,
            background: selectedId === track.id ? "rgba(68,170,255,0.05)" : "transparent",
          }}
        >
          <span style={{ color: "var(--fg-dim)", width: "2ch", textAlign: "right" }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <span style={{ flex: 1, color: "var(--fg)" }}>{track.title}</span>
          <span style={{ color: "var(--fg-dim)", fontSize: "12px" }}>
            {track.streamKey ? "" : "processing..."}
          </span>
          <span style={{ color: "var(--fg-dim)" }}>
            {track.duration ? formatDuration(track.duration) : "--:--"}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
