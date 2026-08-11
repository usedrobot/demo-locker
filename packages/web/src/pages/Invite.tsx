import { useEffect, useState } from "react";
import {
  shares as sharesApi,
  playlists as playlistsApi,
  setShareToken,
  type Playlist,
  type Track,
} from "../lib/api";
import { player } from "../lib/audio";
import { previewAccent } from "../lib/theme";
import TrackList from "../components/TrackList";
import Comments from "../components/Comments";
function PoweredBy() {
  return (
    <div style={{ color: "var(--fg-dim)", fontSize: "11px", letterSpacing: "0.08em" }}>
      ♪ powered by Demo Locker
    </div>
  );
}
import AsciiText from "../components/AsciiText";

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

  useEffect(() => {
    // Carry the invite/share token on every subsequent request and media URL
    // (stream/artwork/comments) so the now-gated legacy endpoints authorize it.
    setShareToken(token);
    // Set by the response below; restoring on unmount keeps a listener who also
    // owns a locker from inheriting whatever colour the last invite used.
    let restoreAccent: (() => void) | null = null;
    sharesApi
      .resolveInvite(token)
      .then((r) => {
        setPlaylist(r.playlist);
        setTracks(r.tracks);
        setPermission(r.permission);
        restoreAccent = previewAccent(r.accent);
        player.setPlaylist(r.tracks);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "invalid invite");
      });
    return () => {
      setShareToken(null);
      restoreAccent?.();
    };
  }, [token]);

  useEffect(() => player.subscribe(setPlayerState), []);

  // "edit" is the stored permission value; re-arranging is all it grants. A
  // share link cannot upload — that is owner/collaborator only (see
  // lib/playlist-access.ts, requestCanUploadToPlaylist).
  const canReorder = permission === "edit";

  async function handleReorder(trackIds: string[]) {
    if (!playlist) return;
    const reordered = trackIds
      .map((id) => tracks.find((t) => t.id === id)!)
      .filter(Boolean);
    setTracks(reordered);
    player.setPlaylist(reordered);
    await playlistsApi.reorder(playlist.id, trackIds);
  }

  // adjust state during render to mirror the currently-playing track
  const playingTrackId = playerState.track?.id ?? null;
  const [lastPlayingTrackId, setLastPlayingTrackId] = useState<string | null>(playingTrackId);
  if (playingTrackId !== lastPlayingTrackId) {
    setLastPlayingTrackId(playingTrackId);
    if (playingTrackId && playingTrackId !== selectedTrackId) {
      setSelectedTrackId(playingTrackId);
    }
  }

  if (error) {
    return (
      <div style={{ padding: "2rem" }}>
        <PoweredBy />
        <p style={{ color: "#f44", marginTop: "1rem" }}>{error}</p>
      </div>
    );
  }

  if (!playlist) {
    return <div style={{ padding: "2rem", color: "var(--fg-dim)" }}>loading...</div>;
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);

  return (
    <div style={{ padding: "2rem", paddingBottom: "5rem" }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <PoweredBy />
      </div>

      {/* .playlist-header, not a bespoke flex row: AsciiText is a size container
          and cannot size itself from its own content, so its column needs a
          definite width (flex:1) — minWidth:0 alone leaves it content-sized and
          the art clips. The shared class also stacks this under 560px. */}
      <div className="playlist-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="box-header">
            shared playlist · {canReorder ? "listen + re-arrange" : "listen"}
          </div>
          <AsciiText text={playlist.name} />
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)" }}>
        <TrackList
          tracks={tracks}
          onReorder={canReorder ? handleReorder : () => {}}
          selectedId={selectedTrackId}
          onSelect={setSelectedTrackId}
        />
      </div>

      {selectedTrack && (
        <div style={{ marginTop: "1.5rem" }}>
          <div className="box-header">{selectedTrack.title}</div>
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
