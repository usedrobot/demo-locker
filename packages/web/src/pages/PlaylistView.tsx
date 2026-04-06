import { useEffect, useState, useCallback, useRef } from "react";
import {
  playlists as api,
  comments as commentsApi,
  type Playlist,
  type Track,
  type Comment,
} from "../lib/api";
import { player } from "../lib/audio";
import TrackList from "../components/TrackList";
import Upload from "../components/Upload";
import Waveform from "../components/Waveform";
import Comments from "../components/Comments";
import SharePanel from "../components/SharePanel";

type Props = {
  playlistId: string;
  onBack: () => void;
};

export default function PlaylistView({ playlistId, onBack }: Props) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playerState, setPlayerState] = useState(player.getState());
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [trackComments, setTrackComments] = useState<Comment[]>([]);

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
          <Upload playlistId={playlistId} onUpload={load} />
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
        <div style={{ color: "var(--fg-dim)", fontSize: "11px", marginTop: "0.25rem" }}>
          uploading...
        </div>
      )}
      {error && (
        <div style={{ color: "#f44", fontSize: "11px", marginTop: "0.25rem" }}>{error}</div>
      )}
    </div>
  );
}
