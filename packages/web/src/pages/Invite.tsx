import { useEffect, useState, useCallback } from "react";
import {
  shares as sharesApi,
  comments as commentsApi,
  type Playlist,
  type Track,
  type Comment,
} from "../lib/api";
import { player } from "../lib/audio";
import TrackList from "../components/TrackList";
import Waveform from "../components/Waveform";
import Comments from "../components/Comments";

type Props = {
  token: string;
};

export default function Invite({ token }: Props) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [permission, setPermission] = useState<string>("listen");
  const [error, setError] = useState("");
  const [playerState, setPlayerState] = useState(player.getState());
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [trackComments, setTrackComments] = useState<Comment[]>([]);

  useEffect(() => {
    sharesApi
      .resolveInvite(token)
      .then((r) => {
        setPlaylist(r.playlist);
        setTracks(r.tracks);
        setPermission(r.permission);
        player.setPlaylist(r.tracks);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "invalid invite");
      });
  }, [token]);

  useEffect(() => player.subscribe(setPlayerState), []);

  useEffect(() => {
    if (selectedTrackId) {
      commentsApi.forTrack(selectedTrackId).then((r) => setTrackComments(r.comments));
    } else {
      setTrackComments([]);
    }
  }, [selectedTrackId]);

  useEffect(() => {
    if (playerState.track && playerState.track.id !== selectedTrackId) {
      setSelectedTrackId(playerState.track.id);
    }
  }, [playerState.track?.id]);

  if (error) {
    return (
      <div style={{ padding: "2rem" }}>
        <pre>{`┌──────────────────────────────┐
│  demo locker                 │
└──────────────────────────────┘`}</pre>
        <p style={{ color: "#f44", marginTop: "1rem" }}>{error}</p>
      </div>
    );
  }

  if (!playlist) {
    return <div style={{ padding: "2rem", color: "var(--fg-dim)" }}>loading...</div>;
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);
  const peaks = selectedTrack?.waveformData
    ? JSON.parse(selectedTrack.waveformData)
    : [];

  return (
    <div style={{ padding: "2rem", paddingBottom: "5rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <pre>{`┌──────────────────────────────┐
│  demo locker                 │
└──────────────────────────────┘`}</pre>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div className="box-header">shared playlist · {permission}</div>
        <h2 style={{ color: "var(--fg)", fontSize: "18px", fontFamily: "var(--font)", fontWeight: "normal" }}>
          {playlist.name}
        </h2>
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }}>
        <TrackList
          tracks={tracks}
          onReorder={() => {}}
          selectedId={selectedTrackId}
          onSelect={setSelectedTrackId}
        />
      </div>

      {selectedTrack && (
        <div style={{ marginTop: "1.5rem" }}>
          <div className="box-header">{selectedTrack.title}</div>
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

      <div style={{ marginTop: "2rem" }}>
        <Comments playlistId={playlist.id} />
      </div>
    </div>
  );
}
