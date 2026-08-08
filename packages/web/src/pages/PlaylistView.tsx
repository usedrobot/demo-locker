import { useEffect, useState, useCallback, useRef } from "react";
import {
  playlists as api,
  tracks as tracksApi,
  auth,
  getApiOrigin,
  type Playlist,
  type Track,
} from "../lib/api";
import { player } from "../lib/audio";
import TrackList from "../components/TrackList";
import Comments from "../components/Comments";
import SharePanel from "../components/SharePanel";
import AsciiText from "../components/AsciiText";

type Props = {
  playlistId: string;
  onBack: () => void;
};

export default function PlaylistView({ playlistId, onBack }: Props) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playerState, setPlayerState] = useState(player.getState());
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [lockerOwnerId, setLockerOwnerId] = useState<string | null>(null);
  const [showAddTracks, setShowAddTracks] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState("");

  useEffect(() => {
    let cancelled = false;
    auth
      .me()
      .then((r) => {
        if (!cancelled) {
          setCurrentUserId(r.user.id);
          // Same resolution the API does in lib/locker.ts: which locker am
          // I acting in? A collaborator's own id is never the locker's id.
          setLockerOwnerId(r.user.lockerOwnerId ?? r.user.id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // May act on this locker's library: add tracks, reorder, rename, share.
  const canManage = !!playlist && !!lockerOwnerId && playlist.ownerId === lockerOwnerId;

  // Owns the locker outright. Gates publishing only — a collaborator may
  // share a playlist but may not put it on the open web (DL, 2026-08-07).
  const isOwner = !!playlist && !!currentUserId && playlist.ownerId === currentUserId;

  async function commitRename() {
    if (!playlist) return;
    const next = draftName.trim();
    if (!next || next === playlist.name) {
      setRenaming(false);
      return;
    }
    try {
      const r = await api.update(playlist.id, { name: next });
      setPlaylist(r.playlist);
      setRenaming(false);
      setRenameError("");
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "rename failed");
    }
  }

  async function openAddTracks() {
    const r = await tracksApi.list();
    setLibraryTracks(r.tracks.filter((t) => t.playlistId === null));
    setShowAddTracks(true);
  }

  async function addTrack(id: string) {
    await tracksApi.attach(id, playlistId);
    setLibraryTracks(libraryTracks.filter((t) => t.id !== id));
    load();
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

  async function togglePublic() {
    if (!playlist) return;
    const updated = await api.update(playlist.id, { isPublic: !playlist.isPublic });
    setPlaylist(updated.playlist);
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);

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

      <div className="playlist-header">
        {/* flex:1 is load-bearing — AsciiText is a size container and cannot
            size itself from its own content. minWidth:0 alone leaves this
            column content-sized, which collapses it to zero. */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              aria-label="playlist name"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setRenameError("");
                }
              }}
              onBlur={() => setRenaming(false)}
              className="rename-input"
            />
          ) : (
            <AsciiText text={playlist.name} />
          )}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.4rem" }}>
            {canManage && !renaming && (
              <button
                onClick={() => {
                  setDraftName(playlist.name);
                  setRenaming(true);
                }}
                style={{ ...linkStyle, color: "var(--accent)" }}
              >
                [rename]
              </button>
            )}
            {isOwner && (
              <button
                onClick={togglePublic}
                style={{ ...linkStyle, color: "var(--accent)" }}
              >
                [{playlist.isPublic ? "make private" : "make public"}]
              </button>
            )}
          </div>
          {renameError && (
            <div style={{ color: "#f44", fontSize: "12px" }}>{renameError}</div>
          )}
        </div>
        <PlaylistArtwork
          playlist={playlist}
          onUpdated={(p) => setPlaylist(p)}
        />
      </div>

      {playlist.isPublic && (
        <div className="box" style={{ marginBottom: "1rem" }}>
          <div className="box-header">public — embed on any site</div>
          <textarea
            readOnly
            rows={2}
            value={`<script src="${getApiOrigin()}/embed.js"></script>\n<demo-locker-player playlist="${playlist.id}"></demo-locker-player>`}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              width: "100%",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              color: "var(--fg)",
              fontFamily: "var(--font)",
              fontSize: "12px",
              padding: "0.5rem",
              resize: "vertical",
            }}
          />
          <div style={{ color: "var(--fg-dim)", fontSize: "11px", marginTop: "0.5rem" }}>
            api: {getApiOrigin()}/public/v1/playlists/{playlist.id}
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border)" }}>
        <TrackList
          tracks={tracks}
          onReorder={handleReorder}
          onRemove={(id) => {
            setTracks(tracks.filter((t) => t.id !== id));
            if (selectedTrackId === id) setSelectedTrackId(null);
          }}
          selectedId={selectedTrackId}
          onSelect={setSelectedTrackId}
        />
      </div>

      {/* Track comments for selected track */}
      {selectedTrack && (
        <div style={{ marginTop: "2rem" }}>
          <div className="box-header">track</div>
          <h3
            style={{
              color: "var(--fg)",
              fontSize: "15px",
              fontFamily: "var(--font)",
              fontWeight: "normal",
              margin: "0 0 0.5rem",
            }}
          >
            {selectedTrack.title}
          </h3>
          <Comments
            trackId={selectedTrack.id}
            isOwner={isOwner}
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
      <div style={{ marginTop: "2rem" }}>
        <SharePanel
          playlistId={playlistId}
          extraAction={
            canManage ? (
              <button
                onClick={() => (showAddTracks ? setShowAddTracks(false) : openAddTracks())}
                className="tui-btn"
              >
                [+ add tracks]
              </button>
            ) : null
          }
        />
        {showAddTracks && (
          <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
            {libraryTracks.length === 0 && (
              <div style={{ color: "var(--fg-dim)", padding: "0.75rem 0", fontSize: "12px" }}>
                no unattached tracks in your library — upload from the main page
              </div>
            )}
            {libraryTracks.map((t) => (
              <div
                key={t.id}
                style={{
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                <span style={{ flex: 1 }}>{t.title}</span>
                <button
                  onClick={() => addTrack(t.id)}
                  style={{ ...linkStyle, color: "var(--accent)" }}
                >
                  [+ add]
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Playlist-level comments */}
      <div style={{ marginTop: "2.5rem" }}>
        <Comments playlistId={playlistId} isOwner={isOwner} />
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
  const [lightboxOpen, setLightboxOpen] = useState(false);

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

  // Esc to close lightbox
  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen]);

  return (
    <div style={{ flex: "none" }}>
      <button
        type="button"
        onClick={() => (src ? setLightboxOpen(true) : inputRef.current?.click())}
        title={src ? "Click to view larger" : "Click to upload artwork"}
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
      {src && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={{
            ...linkStyle,
            color: "var(--accent)",
            marginTop: "0.4rem",
            display: "block",
          }}
        >
          [update cover]
        </button>
      )}
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

      {lightboxOpen && src && (
        <div
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-label="Cover artwork"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 200,
            cursor: "zoom-out",
            padding: "2rem",
          }}
        >
          <img
            src={src}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              objectFit: "contain",
              border: "1px solid var(--border)",
              boxShadow: "0 10px 40px rgba(0,0,0,0.8)",
              cursor: "default",
            }}
          />
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            aria-label="Close"
            style={{
              position: "absolute",
              top: "1.25rem",
              right: "1.5rem",
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--fg)",
              fontFamily: "var(--font)",
              fontSize: "13px",
              padding: "0.3rem 0.6rem",
              cursor: "pointer",
            }}
          >
            [close]
          </button>
        </div>
      )}
    </div>
  );
}
