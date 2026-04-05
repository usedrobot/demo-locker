import { useEffect, useState, useRef } from "react";
import { player } from "../lib/audio";

function formatTime(s: number): string {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function Player() {
  const [state, setState] = useState(player.getState());
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => player.subscribe(setState), []);

  function handleScrub(e: React.MouseEvent<HTMLDivElement>) {
    if (!barRef.current || !state.duration) return;
    const rect = barRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    player.seek(pct * state.duration);
  }

  if (!state.track) return null;

  const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        padding: "0.5rem 1rem",
        fontFamily: "var(--font)",
        fontSize: "13px",
        zIndex: 100,
      }}
    >
      {/* Scrub bar */}
      <div
        ref={barRef}
        onClick={handleScrub}
        title="Click to seek"
        style={{
          width: "100%",
          height: "4px",
          background: "var(--border)",
          cursor: "pointer",
          marginBottom: "0.5rem",
          borderRadius: "2px",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--accent)",
            borderRadius: "2px",
            transition: "width 0.2s linear",
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <button onClick={() => player.prev()} style={btnStyle} title="Previous track">
          [&lt;&lt;]
        </button>
        <button onClick={() => player.toggle()} style={btnStyle} title={state.playing ? "Pause" : "Play"}>
          {state.playing ? "[||]" : "[▶]"}
        </button>
        <button onClick={() => player.next()} style={btnStyle} title="Next track">
          [&gt;&gt;]
        </button>
        <span style={{ color: "var(--fg)" }}>{state.track.title}</span>
        <span style={{ color: "var(--fg-dim)", marginLeft: "auto" }}>
          {formatTime(state.currentTime)} / {formatTime(state.duration)}
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
