import { useEffect, useState, useRef } from "react";
import { player } from "../lib/audio";
import { playlists as playlistsApi } from "../lib/api";

function formatTime(s: number): string {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function Player() {
  const [state, setState] = useState(player.getState());
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => player.subscribe(setState), []);

  const duration = state.duration;
  const currentTime = state.currentTime;
  const progress = duration > 0 ? currentTime / duration : 0;
  const waveformData = state.track?.waveformData ?? null;

  // draw mini waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let peaks: number[] = [];
    if (waveformData) {
      try {
        peaks = JSON.parse(waveformData);
      } catch {
        peaks = [];
      }
    }

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (peaks.length === 0) {
      // fallback: progress bar
      ctx.fillStyle = "#282828";
      ctx.fillRect(0, cssHeight / 2 - 1, cssWidth, 2);
      ctx.fillStyle = "#4af";
      ctx.fillRect(0, cssHeight / 2 - 1, cssWidth * progress, 2);
      return;
    }

    const barWidth = cssWidth / peaks.length;
    const maxPeak = Math.max(...peaks.map(Math.abs)) || 1;

    for (let i = 0; i < peaks.length; i++) {
      const x = i * barWidth;
      const normalized = Math.abs(peaks[i]) / maxPeak;
      const barHeight = normalized * (cssHeight * 0.85);
      const barProgress = i / peaks.length;
      ctx.fillStyle = barProgress < progress ? "#4af" : "#333";
      ctx.fillRect(x, (cssHeight - barHeight) / 2, Math.max(barWidth - 1, 1), barHeight);
    }
  }, [waveformData, progress]);

  function handleScrub(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    player.seek(pct * duration);
  }

  if (!state.track) return null;

  // playlistId is on the track; the player doesn't know whether artwork exists,
  // so always set src and hide on error
  const artworkSrc = playlistsApi.artworkUrlUnchecked(state.track.playlistId);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        fontFamily: "var(--font)",
        fontSize: "13px",
        zIndex: 100,
      }}
    >
      <div
        style={{
          maxWidth: "880px",
          margin: "0 auto",
          padding: "0.75rem 1.5rem 1rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        {/* Artwork thumb */}
        <div
          style={{
            width: "56px",
            height: "56px",
            flex: "none",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            overflow: "hidden",
          }}
        >
          {artworkSrc && (
            <img
              src={artworkSrc}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
        </div>

        {/* Controls + waveform column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
            <button onClick={() => player.prev()} style={btnStyle} title="Previous track">
              [&lt;&lt;]
            </button>
            <button onClick={() => player.toggle()} style={btnStyle} title={state.playing ? "Pause" : "Play"}>
              {state.playing ? "[||]" : "[▶]"}
            </button>
            <button onClick={() => player.next()} style={btnStyle} title="Next track">
              [&gt;&gt;]
            </button>
            <span
              style={{
                color: "var(--fg)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
              }}
            >
              {state.track.title}
            </span>
            <span style={{ color: "var(--fg-dim)" }}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <canvas
            ref={canvasRef}
            onClick={handleScrub}
            title="Click to seek"
            style={{
              width: "100%",
              height: "44px",
              display: "block",
              cursor: "pointer",
            }}
          />
        </div>
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
