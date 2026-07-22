import { useEffect, useState, useRef } from "react";
import { player } from "../lib/audio";
import { playlists as playlistsApi, comments as commentsApi, type Comment } from "../lib/api";
import { avatarColor } from "../lib/avatar";
import { spectrumFrame } from "../lib/visualizer";

function formatTime(s: number): string {
  if (!s || isNaN(s)) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

const SPECTRUM_BARS = 16;

// Live TUI spectrum — block characters driven by a Web Audio analyser.
function Spectrum({ playing }: { playing: boolean }) {
  const [frame, setFrame] = useState("▁".repeat(SPECTRUM_BARS));

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 66) {
        last = t;
        setFrame(spectrumFrame(SPECTRUM_BARS));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return (
    <span
      aria-hidden
      style={{
        color: "var(--accent)",
        whiteSpace: "pre",
        fontSize: "14px",
        lineHeight: 1,
        letterSpacing: "1px",
        opacity: playing ? 1 : 0.35,
        userSelect: "none",
      }}
    >
      {playing ? frame : "▁".repeat(SPECTRUM_BARS)}
    </span>
  );
}

const WAVEFORM_HEIGHT = 88;
const MARKER_SIZE = 26;

export default function Player() {
  const [state, setState] = useState(player.getState());
  const [trackComments, setTrackComments] = useState<Comment[]>([]);
  const [hoverScrub, setHoverScrub] = useState<{ x: number; time: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => player.subscribe(setState), []);

  // load comments with timestamps for the current track
  const trackId = state.track?.id;
  useEffect(() => {
    if (!trackId) return;
    let cancelled = false;
    const fetchComments = () => {
      commentsApi
        .forTrack(trackId)
        .then((r) => {
          if (cancelled) return;
          const flat: Comment[] = [];
          for (const c of r.comments) {
            if (c.timestampSec != null) flat.push(c);
            if (c.replies) for (const rep of c.replies) if (rep.timestampSec != null) flat.push(rep);
          }
          setTrackComments(flat);
        })
        .catch(() => {
          if (!cancelled) setTrackComments([]);
        });
    };
    fetchComments();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.trackId === trackId) fetchComments();
    };
    window.addEventListener("comments:updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("comments:updated", handler);
    };
  }, [trackId]);

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

    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#fc0";
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (peaks.length === 0) {
      // no waveform data — TUI-style segmented progress line (━ ━ ━)
      const segW = 8;
      const gap = 3;
      for (let x = 0; x < cssWidth; x += segW + gap) {
        ctx.fillStyle = x / cssWidth < progress ? accent : "#3f3f3f";
        ctx.fillRect(x, cssHeight / 2 - 1, Math.min(segW, cssWidth - x), 3);
      }
      return;
    }

    // segmented "LED cell" bars — reads like stacked terminal block chars
    const maxPeak = Math.max(...peaks.map(Math.abs)) || 1;
    const cellH = 4; // 3px lit + 1px gap
    const colW = Math.max(cssWidth / peaks.length, 2);

    for (let i = 0; i < peaks.length; i++) {
      const x = i * colW;
      const normalized = Math.abs(peaks[i]) / maxPeak;
      const barHeight = normalized * (cssHeight * 0.85);
      const cells = Math.max(1, Math.round(barHeight / cellH));
      const barProgress = i / peaks.length;
      ctx.fillStyle = barProgress < progress ? accent : "#3f3f3f";
      const top = cssHeight / 2 - (cells * cellH) / 2;
      for (let cIdx = 0; cIdx < cells; cIdx++) {
        ctx.fillRect(x, top + cIdx * cellH, Math.max(colW - 1, 1), cellH - 1);
      }
    }
  }, [waveformData, progress]);

  function handleScrub(e: React.MouseEvent<HTMLDivElement>) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    player.seek(pct * duration);
  }

  function handleHover(e: React.MouseEvent<HTMLDivElement>) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    setHoverScrub({ x, time: pct * duration });
  }

  if (!state.track) return null;

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
      {/* frame label sitting on the top border, TUI-box style */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: "-8px",
          left: "50%",
          transform: "translateX(-50%)",
          background: "var(--bg)",
          padding: "0 0.6em",
          color: "var(--fg-dim)",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          userSelect: "none",
        }}
      >
        ─ now playing ─
      </span>
      <div className="player-inner">
        {/* Artwork thumb */}
        <div className="player-artwork">
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
          <div className="player-controls-row">
            <button onClick={() => player.prev()} className="player-key" title="Previous track" aria-label="Previous track">
              [⏮]
            </button>
            <button
              onClick={() => player.toggle()}
              className="player-key player-key-primary"
              title={state.playing ? "Pause" : "Play"}
              aria-label={state.playing ? "Pause" : "Play"}
            >
              {state.playing ? "[❚❚]" : "[▶]"}
            </button>
            <button onClick={() => player.next()} className="player-key" title="Next track" aria-label="Next track">
              [⏭]
            </button>
            <span
              aria-hidden
              style={{ color: state.playing ? "var(--accent)" : "var(--fg-dim)", userSelect: "none" }}
            >
              {state.playing ? "●" : "■"}
            </span>
            <span className="player-title">♫ {state.track.title}</span>
            <Spectrum playing={state.playing} />
            <span className="player-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div
            className="player-waveform-wrap"
            style={{ position: "relative", width: "100%", height: WAVEFORM_HEIGHT }}
            onClick={handleScrub}
            onMouseMove={handleHover}
            onMouseLeave={() => setHoverScrub(null)}
          >
            <canvas
              ref={canvasRef}
              title="Click to seek"
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                cursor: "pointer",
              }}
            />

            {/* Hover scrub indicator */}
            {hoverScrub && (
              <>
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: hoverScrub.x,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: "rgba(255,255,255,0.25)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: hoverScrub.x,
                    top: -22,
                    transform: "translateX(-50%)",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    color: "var(--fg)",
                    fontFamily: "var(--font)",
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 3,
                    pointerEvents: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatTime(hoverScrub.time)}
                </div>
              </>
            )}

            {/* Comment avatar markers */}
            {duration > 0 &&
              (trackId ? trackComments : []).map((c) => {
                const pct = Math.max(0, Math.min(1, (c.timestampSec ?? 0) / duration));
                const initial = (c.authorName?.trim()?.[0] ?? "?").toUpperCase();
                const color = avatarColor(c.authorName || "?");
                const resolved = c.resolvedAt != null;
                return (
                  <div
                    key={c.id}
                    className="player-marker-group"
                    style={{
                      position: "absolute",
                      left: `${pct * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: 0,
                      pointerEvents: "none",
                      zIndex: 2,
                      opacity: resolved ? 0.35 : 1,
                    }}
                  >
                    {/* Drop guide line */}
                    <div
                      aria-hidden
                      className="player-marker-line"
                      style={{
                        position: "absolute",
                        left: -1,
                        top: MARKER_SIZE - 4,
                        bottom: 0,
                        width: 2,
                        background: color,
                        opacity: 0.35,
                      }}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        player.seek(c.timestampSec ?? 0);
                      }}
                      title={`${c.authorName} @ ${formatTime(c.timestampSec ?? 0)}: ${c.body}`}
                      className="player-marker"
                      style={{
                        position: "absolute",
                        left: -MARKER_SIZE / 2,
                        top: 2,
                        width: MARKER_SIZE,
                        height: MARKER_SIZE,
                        borderRadius: "50%",
                        background: color,
                        color: "#000",
                        border: "2px solid var(--bg)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.7)",
                        fontFamily: "var(--font)",
                        fontSize: 12,
                        fontWeight: 700,
                        lineHeight: 1,
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "auto",
                      }}
                    >
                      {initial}
                    </button>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
