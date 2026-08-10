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
  // Which locker this session acts in — the same resolution the API does in
  // lib/locker.ts, where a collaborator's own id is never their locker's id.
  const [lockerId, setLockerId] = useState<string | null>(null);
  // Whether this session OWNS that locker. The server's own rule, verbatim
  // (`user.lockerOwnerId === null`), and the one Home.tsx uses — deriving it a
  // second way from `playlist.ownerId === currentUserId` only agreed by the
  // coincidence that playlists.ownerId happens to hold the locker id.
  const [isLockerOwner, setIsLockerOwner] = useState(false);
  // A refused write from one of this page's controls (publish, reorder). Kept
  // apart from loadError: the page is fine, one action was not.
  const [writeError, setWriteError] = useState("");
  // Whatever stopped this page knowing who the viewer is, or what is on it.
  // Discarding it left the OWNER looking like a listener — no rename, no
  // publish, no add-tracks, no reorder, no artwork, no moderation — with
  // nothing on screen to say why.
  const [loadError, setLoadError] = useState("");
  const [showAddTracks, setShowAddTracks] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState("");
  // Drives the disabled input + pending affordance. Mirrored by
  // renameInFlightRef below, which is what the handlers actually test —
  // state doesn't update synchronously within a handler, and the guard has
  // to hold for a blur dispatched in the same turn as the Enter.
  const [renameSaving, setRenameSaving] = useState(false);
  // One-shot: Escape sets this to tell the *next* blur "discard, don't
  // commit". It does NOT depend on that blur ever arriving — removing a
  // focused element from the DOM does not reliably fire blur/focusout (it
  // doesn't in Chrome or Safari), so this can't rely on being consumed to
  // get cleared. It is reset unconditionally whenever the editor is opened,
  // which is the only place a stale `true` could otherwise leak into and
  // silently swallow a later, unrelated commit.
  const cancelRenameRef = useRef(false);
  // True only while a commitRename() network call is in flight. Guards
  // against a blur firing (e.g. clicking another control, or the input
  // being disabled out from under the focus) before that request resolves,
  // which would otherwise re-enter commitRename and fire a duplicate PATCH.
  const renameInFlightRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Previous values of `renaming` / `renameSaving`, so the focus effect below
  // can act on a transition rather than on every render that leaves them true.
  const wasRenamingRef = useRef(false);
  const wasSavingRef = useRef(false);
  // Whether the input held focus at the moment a save started — read BEFORE
  // the disabling render commits, because by the time the effect runs a real
  // browser has already moved focus to <body>.
  const refocusAfterSaveRef = useRef(false);

  // Focus, in the two moments this field loses it.
  //
  // OPENING the editor: take focus deliberately. There is no `autoFocus`,
  // because it cannot re-fire on an element that was never unmounted, and one
  // mechanism owning focus is easier to reason about than two.
  //
  // COMING BACK FROM A FAILED SAVE: disabling a focused input moves focus to
  // <body>, and this input is never unmounted, so nothing brings focus back on
  // its own. The field returns editable but unfocused: the draft is sitting
  // there, the error is on screen, and the correction goes to the document and
  // is lost. Enter and Escape do nothing, and [rename] is hidden while
  // renaming, so there is no visible way back in. Restoring focus is also what
  // re-arms the blur-commit safety net, which would otherwise be dead for the
  // rest of this editing session.
  //
  // The second case is RESTORATION, not a claim, and the original refocused
  // unconditionally — stealing focus from wherever the user had moved to while
  // the request was in flight. It is now gated the way SharePanel.tsx gates
  // the identical situation:
  //   1. the saving true -> false transition only, so it never fires on mount
  //      or on an unrelated render;
  //   2. the input actually held focus when the save started
  //      (refocusAfterSaveRef), so we only put back what we took away;
  //   3. focus is still unclaimed (activeElement is <body> or null) — if the
  //      user has clicked something else since, leave it alone.
  useEffect(() => {
    const opening = renaming && !wasRenamingRef.current;
    const returning = wasSavingRef.current && !renameSaving && renaming;

    if (opening) {
      renameInputRef.current?.focus();
    } else if (returning && refocusAfterSaveRef.current) {
      if (document.activeElement === document.body || document.activeElement === null) {
        renameInputRef.current?.focus();
      }
    }
    if (returning) refocusAfterSaveRef.current = false;

    wasRenamingRef.current = renaming;
    wasSavingRef.current = renameSaving;
  }, [renaming, renameSaving]);

  // May act on this locker's library: add tracks, reorder, rename, share.
  const canManage = !!playlist && !!lockerId && playlist.ownerId === lockerId;

  // Owns the locker outright. Gates publishing only — a collaborator may
  // share a playlist but may not put it on the open web (DL, 2026-08-07).
  // Both halves are required: the server checks locker membership first and
  // ownership second, and this is that pair.
  const isOwner = canManage && isLockerOwner;

  async function commitRename() {
    if (!playlist) return;
    // A PATCH from this session is already out. The input is disabled for
    // that whole window, so there is nothing newly typed to send — this can
    // only be a stray re-entry (notably the blur browsers fire when a
    // focused input is disabled), and firing again would just duplicate the
    // request.
    if (renameInFlightRef.current) return;

    const next = draftName.trim();
    if (!next || next === playlist.name) {
      setRenaming(false);
      setRenameError("");
      return;
    }

    renameInFlightRef.current = true;
    // Read while the input is still enabled and still holds focus, if it does.
    refocusAfterSaveRef.current = document.activeElement === renameInputRef.current;
    setRenameSaving(true);
    try {
      const r = await api.update(playlist.id, { name: next });
      setPlaylist(r.playlist);
      setRenaming(false);
      setRenameError("");
    } catch (err) {
      // Leave the editor open with the draft untouched. A failed rename
      // must never cost the user what they typed — they correct and retry
      // from where they were, rather than starting over.
      setRenameError(err instanceof Error ? err.message : "rename failed");
    } finally {
      renameInFlightRef.current = false;
      setRenameSaving(false);
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

  // auth.me() rides along with the playlist rather than sitting in an effect of
  // its own — the pattern Home.tsx uses. Who the viewer is decides which
  // controls the page may show, so learning it separately meant a failure on
  // one of the two could silently strip the other's affordances; folded
  // together, either failure lands in the same visible loadError.
  const load = useCallback(async () => {
    try {
      const [r, me] = await Promise.all([api.get(playlistId), auth.me()]);
      setPlaylist(r.playlist);
      setTracks(r.tracks);
      player.setPlaylist(r.tracks);
      setLockerId(me.user.lockerOwnerId ?? me.user.id);
      setIsLockerOwner(me.user.lockerOwnerId === null);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "failed to load");
    }
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
    const before = tracks;
    const reordered = trackIds
      .map((id) => tracks.find((t) => t.id === id)!)
      .filter(Boolean);
    // Optimistic: the drag has already happened on screen and re-rendering the
    // old order under the pointer would be worse than a brief lie.
    setTracks(reordered);
    player.setPlaylist(reordered);
    try {
      await api.reorder(playlistId, trackIds);
      setWriteError("");
    } catch (err) {
      // Put it back. A refused reorder that silently stuck would leave the
      // page showing an order the server does not have, until the next load.
      setTracks(before);
      player.setPlaylist(before);
      setWriteError(err instanceof Error ? err.message : "couldn't reorder those tracks");
    }
  }

  async function togglePublic() {
    if (!playlist) return;
    try {
      const updated = await api.update(playlist.id, { isPublic: !playlist.isPublic });
      setPlaylist(updated.playlist);
      setWriteError("");
    } catch (err) {
      // The one refusal the API goes out of its way to make readable — "only
      // the locker owner can publish a playlist", the whole point of the
      // documented exception to the blanket 404 — and it was being dropped as
      // an unhandled rejection, so the toggle just did nothing.
      setWriteError(err instanceof Error ? err.message : "couldn't change that playlist");
    }
  }

  const selectedTrack = tracks.find((t) => t.id === selectedTrackId);

  if (!playlist) {
    // A failure BEFORE anything is on screen: say so rather than sitting on
    // "loading..." forever.
    if (loadError) {
      return (
        <div style={{ padding: "2rem" }}>
          <div role="alert" style={{ color: "#f44", fontSize: "12px" }}>
            {loadError}
          </div>
          <button onClick={onBack} style={{ marginTop: "1rem" }}>
            [back]
          </button>
        </div>
      );
    }
    return <div style={{ padding: "2rem", color: "var(--fg-dim)" }}>loading...</div>;
  }

  return (
    <div style={{ padding: "2rem", paddingBottom: "5rem" }}>
      {/* A failure AFTER the page is up. The stale view stays — losing it
          would cost more than it saves — but the controls it decides are now
          out of date, and the owner who has just lost [rename], [make public]
          and the rest is owed an explanation rather than a page that quietly
          reads as "you are a listener now". */}
      {loadError && (
        <div role="alert" style={{ color: "#f44", fontSize: "12px", marginBottom: "0.75rem" }}>
          {loadError}
        </div>
      )}
      {writeError && (
        <div role="alert" style={{ color: "#f44", fontSize: "12px", marginBottom: "0.75rem" }}>
          {writeError}
        </div>
      )}
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
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                aria-label="playlist name"
                // No `autoFocus`: the effect above owns focus for both cases
                // (opening the editor, and coming back from a failed save),
                // and one mechanism is easier to reason about than two.
                ref={renameInputRef}
                value={draftName}
                // Uneditable for the length of the request. That window used
                // to stay live, which meant a correction typed into it either
                // got dropped or had to be reconciled by a retry loop that
                // could PATCH half-typed text. Nothing can be typed here now,
                // so there is nothing to lose and nothing to reconcile.
                disabled={renameSaving}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    // A commit already in flight can't be cancelled — the
                    // request is already gone. Escape only cancels an unsent
                    // edit; once the PATCH is out, let it resolve and show
                    // the real server state rather than closing the editor
                    // as if nothing happened while the rename lands anyway.
                    // The field is visibly disabled while that's true, so
                    // this no-op reads as "busy", not as a dropped keypress.
                    if (renameInFlightRef.current) return;
                    cancelRenameRef.current = true;
                    setRenaming(false);
                    setRenameError("");
                  }
                }}
                onBlur={() => {
                  // Escape already handled discarding — don't also commit.
                  if (cancelRenameRef.current) {
                    cancelRenameRef.current = false;
                    return;
                  }
                  // Clicking away used to discard silently: setRenaming(false)
                  // ran on mousedown, before the click's mouseup, so the
                  // control the user meant to hit (e.g. [make public]) moved
                  // out from under the pointer AND the typed name was lost.
                  // Committing here preserves the edit either way.
                  commitRename();
                }}
                className="rename-input"
              />
              {renameSaving && (
                <span
                  className="dots"
                  style={{ color: "var(--fg-dim)", fontSize: "11px", flex: "none" }}
                >
                  saving
                </span>
              )}
            </div>
          ) : (
            <AsciiText text={playlist.name} />
          )}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.4rem" }}>
            {canManage && !renaming && (
              <button
                onClick={() => {
                  // A prior session may have set this and never had it
                  // consumed (see the ref's own comment) — start clean.
                  cancelRenameRef.current = false;
                  setDraftName(playlist.name);
                  setRenameError("");
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
            canModerate={canManage}
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
        <Comments playlistId={playlistId} canModerate={canManage} />
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
