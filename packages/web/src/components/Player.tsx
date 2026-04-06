import { useEffect, useState, useRef } from "react";
import { player } from "../lib/audio";
import { playlists as playlistsApi, comments as commentsApi, type Comment } from "../lib/api";
import { avatarColor } from "../lib/avatar";

function formatTime(s: number): string {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
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
      commentsApi.forTrack(trackId).then((r) => {
        if (cancelled) return;
        const flat: Comment[] = [];
        for (const c of r.comments) {
          if (c.timestampSec != null) flat.push(c);
          if (c.replies) for (const rep of c.replies) if (rep.timestampSec != null) flat.push(rep);
        }
        setTrackComments(flat);
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

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (peaks.length === 0) {
      ctx.fillStyle = "#3f3f3f";
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
      ctx.fillStyle = barProgress < progress ? "#4af" : "#3f3f3f";
      ctx.fillRect(x, (cssHeight - barHeight) / 2, Math.max(barWidth - 1, 1), barHeight);
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
            <button onClick={() => player.prev()} className="player-btn" title="Previous track" aria-label="Previous track">
              ⏮
            </button>
            <button
              onClick={() => player.toggle()}
              className="player-btn player-btn-primary"
              title={state.playing ? "Pause" : "Play"}
              aria-label={state.playing ? "Pause" : "Play"}
            >
              {state.playing ? "⏸" : "⏵"}
            </button>
            <button onClick={() => player.next()} className="player-btn" title="Next track" aria-label="Next track">
              ⏭
            </button>
            <span className="player-title">{state.track.title}</span>
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
