import { useRef, useEffect } from "react";
import type { Comment } from "../lib/api";

type Props = {
  peaks: number[];
  duration: number;
  currentTime: number;
  comments: Comment[];
  onSeek: (time: number) => void;
};

export default function Waveform({ peaks, duration, currentTime, comments, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = 600;
  const height = 60;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // clear
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--bg").trim() || "#0a0a0a";
    ctx.fillRect(0, 0, width, height);

    if (peaks.length === 0) {
      // no waveform data — draw a flat line
      ctx.strokeStyle = "#333";
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    const barWidth = width / peaks.length;
    const maxPeak = Math.max(...peaks.map(Math.abs)) || 1;

    // draw waveform bars
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barWidth;
      const normalized = Math.abs(peaks[i]) / maxPeak;
      const barHeight = normalized * (height * 0.8);

      // played vs unplayed color
      const progress = duration > 0 ? currentTime / duration : 0;
      const barProgress = i / peaks.length;
      ctx.fillStyle = barProgress < progress ? "#4af" : "#333";

      ctx.fillRect(x, (height - barHeight) / 2, Math.max(barWidth - 1, 1), barHeight);
    }

    // draw comment markers
    const markerComments = comments.filter((c) => c.timestampSec != null);
    ctx.fillStyle = "#f80";
    for (const comment of markerComments) {
      const x = (comment.timestampSec! / duration) * width;
      // small triangle marker at top
      ctx.beginPath();
      ctx.moveTo(x - 3, 0);
      ctx.lineTo(x + 3, 0);
      ctx.lineTo(x, 6);
      ctx.closePath();
      ctx.fill();
    }
  }, [peaks, duration, currentTime, comments]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = (x / rect.width) * duration;
    onSeek(time);
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      style={{
        width: "100%",
        maxWidth: `${width}px`,
        height: `${height}px`,
        cursor: "pointer",
        display: "block",
      }}
    />
  );
}
