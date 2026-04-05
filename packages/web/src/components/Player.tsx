import { useEffect, useState } from "react";
import { player } from "../lib/audio";

function formatTime(s: number): string {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function progressBar(current: number, total: number, width = 30): string {
  if (!total) return "░".repeat(width);
  const filled = Math.round((current / total) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export default function Player() {
  const [state, setState] = useState(player.getState());

  useEffect(() => player.subscribe(setState), []);

  if (!state.track) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        padding: "0.75rem 1rem",
        fontFamily: "var(--font)",
        fontSize: "13px",
        zIndex: 100,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <button
          onClick={() => player.prev()}
          style={btnStyle}
          title="Previous"
        >
          [&lt;&lt;]
        </button>
        <button
          onClick={() => player.toggle()}
          style={btnStyle}
          title={state.playing ? "Pause" : "Play"}
        >
          {state.playing ? "[||]" : "[▶]"}
        </button>
        <button
          onClick={() => player.next()}
          style={btnStyle}
          title="Next"
        >
          [&gt;&gt;]
        </button>
        <span style={{ color: "var(--fg)" }}>{state.track.title}</span>
        <span style={{ color: "var(--fg-dim)", flex: 1, textAlign: "center" }}>
          {progressBar(state.currentTime, state.duration)}
        </span>
        <span style={{ color: "var(--fg-dim)" }}>
          {formatTime(state.currentTime)}/{formatTime(state.duration)}
        </span>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  cursor: "pointer",
  padding: 0,
};
