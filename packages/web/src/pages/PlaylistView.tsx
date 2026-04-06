import { useEffect, useState, useCallback, useRef } from "react";
import {
  playlists as api,
  comments as commentsApi,
  tracks as tracksApi,
  type Playlist,
  type Track,
  type Comment,
} from "../lib/api";
import { player } from "../lib/audio";
import { extractPeaks } from "../lib/peaks";
import TrackList from "../components/TrackList";
import Upload from "../components/Upload";
import Waveform from "../components/Waveform";
import Comments from "../components/Comments";
import SharePanel from "../components/SharePanel";

type Props = {
  playlistId: string;
  onBack: () => void;
};

type PendingUpload = {
  id: string;
  file: File;
  title: string;
  progress: number; // 0..1
  status: "decoding" | "ready" | "uploading" | "error";
  error?: string;
  waveformData?: string;
  duration?: number;
};

export default function PlaylistView({ playlistId, onBack }: Props) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playerState, setPlayerState] = useState(player.getState());
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [trackComments, setTrackComments] = useState<Comment[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);

  function queueUploads(files: File[]) {
    const items: PendingUpload[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      title: file.name.replace(/\.[^.]+$/, ""),
      progress: 0,
      status: "decoding",
    }));
    setPendingUploads((prev) => [...prev, ...items]);

    // decode peaks in the background so they're ready by the time the user
    // hits [upload] — failures here are non-fatal, the upload still works
    // without waveform data.
    items.forEach(async (item) => {
      try {
        const { peaks, duration } = await extractPeaks(item.file);
        updatePending(item.id, {
          status: "ready",
          waveformData: JSON.stringify(peaks),
          duration,
        });
      } catch {
        updatePending(item.id, { status: "ready" });
      }
    });
  }

  function updatePending(id: string, patch: Partial<PendingUpload>) {
    setPendingUploads((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
    );
  }

  function removePending(id: string) {
    setPendingUploads((prev) => prev.filter((p) => p.id !== id));
  }

  async function startUpload(id: string) {
    const item = pendingUploads.find((p) => p.id === id);
    if (!item) return;
    updatePending(id, { status: "uploading", progress: 0, error: undefined });
    try {
      await tracksApi.upload(playlistId, item.file, {
        title: item.title.trim() || undefined,
        waveformData: item.waveformData,
        duration: item.duration,
        onProgress: (pct) => updatePending(id, { progress: pct }),
      });
      removePending(id);
      load();
    } catch (err) {
      updatePending(id, {
        status: "error",
        error: err instanceof Error ? err.message : "upload failed",
      });
    }
  }

  const load = useCallback(() => {
    api.get(playlistId).then((r) => {
      setPlaylist(r.playlist);
      setTracks(r.tracks);
      player.setPlaylist(r.tracks);
    });
  }, [playlistId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => player.subscribe(setPlayerState), []);

  // load comments when a track is selected
  useEffect(() => {
    let cancelled = false;
    if (selectedTrackId) {
      commentsApi.forTrack(selectedTrackId).then((r) => {
        if (!cancelled) setTrackComments(r.comments);
      });
    } else {
      Promise.resolve().then(() => {
        if (!cancelled) setTrackComments([]);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [selectedTrackId]);

  // auto-select playing track — adjust state during render
  const playingTrackId = playerState.track?.id ?? null;
  const [lastPlayingTrackId, setLastPlayingTrackId] = useState<string | null>(playingTrackId);
  if (playingTrackId !== lastPlayingTrackId) {
    setLastPlayingTrackId(playingTrackId);
    if (playingTrackId && playingTrackId !== selectedTrackId) {
      setSelectedTrackId(playingTrackId);
    }
  }

  async function handleReorder(trackIds: string[]) {
    const reordered = trackIds
      .map((id) => tracks.find((t) => t.id === id)!)
      .filter(Boolean);
    setTracks(reordered);
    player.setPlaylist(reordered);
    await api.reorder(playlistId, trackIds);
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);
  const peaks = selectedTrack?.waveformData
    ? JSON.parse(selectedTrack.waveformData)
    : [];

  if (!playlist) {
    return <div style={{ padding: "2rem", color: "var(--fg-dim)" }}>loading...</div>;
  }

  return (
    <div style={{ padding: "2rem", paddingBottom: "5rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <button onClick={onBack} style={linkStyle}>
          [&lt; back]
        </button>
      </div>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", marginBottom: "1rem" }}>
        <PlaylistArtwork
          playlist={playlist}
          onUpdated={(p) => setPlaylist(p)}
        />
        <div style={{ flex: 1, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="box-header">playlist</div>
            <h2 style={{ color: "var(--fg)", fontSize: "18px", fontFamily: "var(--font)", fontWeight: "normal" }}>
              {playlist.name}
            </h2>
          </div>
          <Upload onPick={queueUploads} />
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }}>
        <TrackList
          tracks={tracks}
          onReorder={handleReorder}
          onDelete={(id) => {
            setTracks(tracks.filter((t) => t.id !== id));
            if (selectedTrackId === id) setSelectedTrackId(null);
          }}
          selectedId={selectedTrackId}
          onSelect={setSelectedTrackId}
        />
        {pendingUploads.map((p) => (
          <PendingTrackRow
            key={p.id}
            item={p}
            position={tracks.length + pendingUploads.indexOf(p) + 1}
            onTitleChange={(title) => updatePending(p.id, { title })}
            onStart={() => startUpload(p.id)}
            onCancel={() => removePending(p.id)}
          />
        ))}
      </div>

      {/* Waveform + track comments for selected track */}
      {selectedTrack && (
        <div style={{ marginTop: "1.5rem" }}>
          <div className="box-header">
            {selectedTrack.title}
          </div>
          <Waveform
            peaks={peaks}
            duration={selectedTrack.duration || 0}
            currentTime={
              playerState.track?.id === selectedTrack.id
                ? playerState.currentTime
                : 0
            }
            comments={trackComments}
            onSeek={(time) => {
              if (playerState.track?.id !== selectedTrack.id) {
                player.play(selectedTrack.id);
              }
              player.seek(time);
            }}
          />
          <Comments
            trackId={selectedTrack.id}
            currentTime={
              playerState.track?.id === selectedTrack.id
                ? playerState.currentTime
                : 0
            }
            onSeek={(time) => {
              if (playerState.track?.id !== selectedTrack.id) {
                player.play(selectedTrack.id);
              }
              player.seek(time);
            }}
          />
        </div>
      )}

      {/* Sharing */}
      <SharePanel playlistId={playlistId} />

      {/* Playlist-level comments */}
      <div style={{ marginTop: "2rem" }}>
        <Comments playlistId={playlistId} />
      </div>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-dim)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  cursor: "pointer",
  padding: 0,
};

function PlaylistArtwork({
  playlist,
  onUpdated,
}: {
  playlist: Playlist;
  onUpdated: (p: Playlist) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const src = api.artworkUrl(playlist.id, playlist.artworkKey);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const r = await api.uploadArtwork(playlist.id, file);
      onUpdated(r.playlist);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div style={{ flex: "none" }}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        title="Click to upload artwork"
        style={{
          width: "120px",
          height: "120px",
          padding: 0,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          color: "var(--fg-dim)",
          fontFamily: "var(--font)",
          fontSize: "11px",
          cursor: "pointer",
          overflow: "hidden",
          display: "block",
        }}
      >
        {src ? (
          <img
            src={src}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <span>[+ artwork]</span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        style={{ display: "none" }}
      />
      {uploading && (
        <div
          className="dots"
          style={{ color: "var(--fg-dim)", fontSize: "11px", marginTop: "0.25rem" }}
        >
          uploading
        </div>
      )}
      {error && (
        <div style={{ color: "#f44", fontSize: "11px", marginTop: "0.25rem" }}>{error}</div>
      )}
    </div>
  );
}

function PendingTrackRow({
  item,
  position,
  onTitleChange,
  onStart,
  onCancel,
}: {
  item: PendingUpload;
  position: number;
  onTitleChange: (title: string) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const pct = Math.round(item.progress * 100);
  const isDecoding = item.status === "decoding";
  const isUploading = item.status === "uploading";
  const isError = item.status === "error";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.5rem 0.25rem",
        borderBottom: "1px solid var(--border)",
        position: "relative",
        background: "transparent",
      }}
    >
      {/* Progress fill behind the row */}
      {isUploading && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: "rgba(68,170,255,0.18)",
            transition: "width 0.15s linear",
            pointerEvents: "none",
          }}
        />
      )}

      <span
        style={{ color: "var(--fg-dim)", fontSize: "11px", userSelect: "none", position: "relative" }}
        title="Pending upload"
      >
        ⠿
      </span>

      <span
        style={{
          color: "var(--fg-dim)",
          width: "2ch",
          textAlign: "right",
          fontSize: "12px",
          position: "relative",
        }}
      >
        {String(position).padStart(2, "0")}
      </span>

      <span style={{ width: "1.5ch", color: "var(--accent)", fontSize: "12px", position: "relative" }}>
        {isUploading ? "↑" : ""}
      </span>

      <input
        value={item.title}
        onChange={(e) => onTitleChange(e.target.value)}
        disabled={isUploading}
        placeholder="track title"
        style={{
          flex: 1,
          background: "transparent",
          border: "1px solid var(--border)",
          color: "var(--fg)",
          fontFamily: "var(--font)",
          fontSize: "13px",
          padding: "0.25rem 0.5rem",
          position: "relative",
        }}
      />

      {isUploading && (
        <span
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            width: "3ch",
            textAlign: "right",
            position: "relative",
          }}
        >
          {pct}%
        </span>
      )}

      {isDecoding && (
        <span
          className="dots"
          style={{
            color: "var(--fg-dim)",
            fontSize: "11px",
            position: "relative",
          }}
        >
          decoding
        </span>
      )}

      {!isUploading && !isDecoding && (
        <button
          onClick={onStart}
          title="Start upload"
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--accent)",
            fontFamily: "var(--font)",
            fontSize: "12px",
            padding: "0.25rem 0.5rem",
            cursor: "pointer",
            position: "relative",
          }}
        >
          {isError ? "[retry]" : "[upload]"}
        </button>
      )}

      <button
        onClick={onCancel}
        disabled={isUploading}
        title="Remove"
        style={{
          background: "none",
          border: "none",
          color: "var(--fg-dim)",
          fontFamily: "var(--font)",
          fontSize: "12px",
          cursor: isUploading ? "default" : "pointer",
          padding: "0 0.25rem",
          position: "relative",
          opacity: isUploading ? 0.4 : 1,
        }}
      >
        [x]
      </button>

      {isError && (
        <div
          style={{
            position: "absolute",
            left: "5rem",
            bottom: "-1.1rem",
            color: "#f44",
            fontSize: "11px",
          }}
        >
          {item.error}
        </div>
      )}
    </div>
  );
}
