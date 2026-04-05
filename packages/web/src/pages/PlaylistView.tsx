import { useEffect, useState, useCallback } from "react";
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
    if (selectedTrackId) {
      commentsApi.forTrack(selectedTrackId).then((r) => setTrackComments(r.comments));
    } else {
      setTrackComments([]);
    }
  }, [selectedTrackId]);

  // auto-select playing track
  useEffect(() => {
    if (playerState.track && playerState.track.id !== selectedTrackId) {
      setSelectedTrackId(playerState.track.id);
    }
  }, [playerState.track?.id]);

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

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
        <div>
          <div className="box-header">playlist</div>
          <h2 style={{ color: "var(--fg)", fontSize: "18px", fontFamily: "var(--font)", fontWeight: "normal" }}>
            {playlist.name}
          </h2>
        </div>
        <Upload playlistId={playlistId} onUpload={load} />
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
