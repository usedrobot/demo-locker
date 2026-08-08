import { useCallback, useEffect, useState } from "react";
import {
  playlists as api,
  tracks as tracksApi,
  shares as sharesApi,
  auth,
  type Playlist,
  type Track,
  type Share,
  setToken,
} from "../lib/api";
import { player } from "../lib/audio";
import { cycleAccent } from "../lib/theme";
import Logo from "../components/Logo";
import CollabPanel from "../components/CollabPanel";
import Attribution from "../components/Attribution";
import Upload from "../components/Upload";
import PendingTrackRow from "../components/PendingTrackRow";
import { useUploadQueue } from "../lib/use-upload-queue";

type Props = {
  onSelect: (id: string) => void;
  onLogout: () => void;
};

type LoadState = "loading" | "ready" | "error";

export default function Home({ onSelect, onLogout }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [newName, setNewName] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [library, setLibrary] = useState<Track[]>([]);
  const [confirmTrackDeleteId, setConfirmTrackDeleteId] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState(player.getState());
  // bump to re-read the accent swatch color after a cycle
  const [, setAccentTick] = useState(0);
  const [showAccess, setShowAccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwDone, setPwDone] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [accessShares, setAccessShares] = useState<Share[]>([]);
  // Null until the session is resolved. Owner-only surfaces render on `true`
  // alone, never on "not false", so a collaborator never sees them flash.
  // Resolved in the same load() as the lists, so rows are never painted before
  // it is known which of their delete controls belong on screen.
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [playlistError, setPlaylistError] = useState("");
  const [trackError, setTrackError] = useState("");

  async function openAccess() {
    const r = await sharesApi.listAll();
    setAccessShares(r.shares);
    setShowAccess(true);
  }

  async function toggleEdit(share: Share) {
    const next = share.permission === "edit" ? "listen" : "edit";
    const r = await sharesApi.setPermission(share.id, next);
    setAccessShares(
      accessShares.map((s) =>
        s.id === share.id ? { ...s, permission: r.share.permission } : s
      )
    );
  }

  async function revokeShare(id: string) {
    await sharesApi.revoke(id);
    setAccessShares(accessShares.filter((s) => s.id !== id));
  }

  useEffect(() => player.subscribe(setPlayerState), []);

  const refreshLibrary = useCallback(() => {
    tracksApi.list().then((r) => setLibrary(r.tracks)).catch(() => {});
  }, []);
  const uploads = useUploadQueue(null, refreshLibrary);

  // background=true skips the visible loading state: the focus-refetch used to
  // insert a "loading..." row mid-click, shifting the layout so the click
  // landed on the wrong element. Background refreshes keep the current view
  // and swap data in place (and stay silent on transient failures).
  const load = useCallback(async (background = false) => {
    if (!background) {
      setLoadState("loading");
      setLoadError("");
    }
    try {
      // auth.me() rides along with the lists rather than in an effect of its
      // own: `isOwner` decides which delete controls each row may show, so
      // learning it a tick later would paint the wrong affordances first.
      const [r, lib, me] = await Promise.all([api.list(), tracksApi.list(), auth.me()]);
      setPlaylists(r.playlists);
      setLibrary(lib.tracks);
      setIsOwner(me.user.lockerOwnerId === null);
      setLoadState("ready");
    } catch (err) {
      if (background) return;
      setLoadError(err instanceof Error ? err.message : "failed to load");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // refetch when the tab regains focus — self-heal transient failures
  useEffect(() => {
    function onFocus() {
      load(true);
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const { playlist } = await api.create(newName.trim());
    setPlaylists([...playlists, playlist]);
    setNewName("");
  }

  function playLibraryTrack(id: string) {
    if (player.getState().track?.id === id) {
      player.toggle();
      return;
    }
    player.setPlaylist(library);
    player.play(id);
  }

  // Both deletes catch. request() throws on any non-2xx, and the server refuses
  // a collaborator deleting someone else's row — so without this the user gets
  // an unhandled rejection and a list that silently does not change. The
  // control is gated on the same rule below, which makes a refusal unlikely
  // rather than impossible: the gate is drawn from data that can be stale by
  // the time the click lands.
  async function handleTrackDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (confirmTrackDeleteId !== id) {
      setConfirmTrackDeleteId(id);
      return;
    }
    setConfirmTrackDeleteId(null);
    setTrackError("");
    try {
      await tracksApi.delete(id);
    } catch (err) {
      setTrackError(err instanceof Error ? err.message : "couldn't delete that track");
      return;
    }
    if (player.getState().track?.id === id) player.clear();
    setLibrary(library.filter((t) => t.id !== id));
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    setPlaylistError("");
    try {
      await api.delete(id);
    } catch (err) {
      setPlaylistError(err instanceof Error ? err.message : "couldn't delete that playlist");
      return;
    }
    setPlaylists(playlists.filter((p) => p.id !== id));
  }

  function handleLogout() {
    setToken(null);
    onLogout();
  }

  return (
    <div style={{ padding: "2rem" }}>
      <div className="page-header">
        {/* flex:1 + minWidth:0 is load-bearing: Logo is a size container and
            cannot size itself from its own content. Without a definite width
            here it collapses to zero and the art disappears. */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Logo />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem" }}>
          <button onClick={handleLogout} style={linkStyle}>
            [logout]
          </button>
          <button
            onClick={() => (showAccess ? setShowAccess(false) : openAccess())}
            style={{ ...linkStyle, color: showAccess ? "var(--accent)" : "var(--fg-dim)" }}
          >
            [access]
          </button>
          <button
            onClick={() => {
              setShowPassword((v) => !v);
              setPwError("");
              setPwDone(false);
            }}
            style={{ ...linkStyle, color: showPassword ? "var(--accent)" : "var(--fg-dim)" }}
          >
            [password]
          </button>
          <button
            onClick={() => {
              const next = cycleAccent();
              setAccentTick((n) => n + 1);
              // Persist to the account — this is what share-link listeners see.
              // The local switch already happened, so a failed write costs the
              // sync, not the interaction.
              auth.setAccent(next).catch(() => {});
            }}
            title="Change accent color"
            aria-label="Change accent color"
            style={{
              width: "16px",
              height: "16px",
              background: "var(--accent)",
              border: "1px solid var(--border)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        </div>
      </div>

      {showPassword && (
        <div style={{ marginBottom: "2rem" }}>
          <div className="box-header">change password</div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setPwError("");
              setPwDone(false);
              if (newPw.length < 8) {
                setPwError("new password must be at least 8 characters");
                return;
              }
              if (newPw !== confirmPw) {
                setPwError("new passwords don't match");
                return;
              }
              setPwBusy(true);
              try {
                await auth.changePassword(currentPw, newPw);
                setPwDone(true);
                setCurrentPw("");
                setNewPw("");
                setConfirmPw("");
              } catch (err) {
                setPwError(err instanceof Error ? err.message : "failed");
              } finally {
                setPwBusy(false);
              }
            }}
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: "0.75rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              maxWidth: "22rem",
            }}
          >
            <input
              type="password"
              autoComplete="current-password"
              placeholder="current password"
              style={fieldStyle}
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="new password (8+ characters)"
              style={fieldStyle}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="confirm new password"
              style={fieldStyle}
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
            />
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <button type="submit" disabled={pwBusy} style={linkStyle}>
                {pwBusy ? "[saving...]" : "[save]"}
              </button>
              {pwError && <span style={{ color: "var(--error)" }}>{pwError}</span>}
              {pwDone && (
                <span style={{ color: "var(--fg-dim)" }}>
                  saved — other devices signed out
                </span>
              )}
            </div>
          </form>
        </div>
      )}

      {showAccess && (
        <div style={{ marginBottom: "2rem" }}>
          <div className="box-header">access — who can reach your locker</div>
          <div style={{ borderTop: "1px solid var(--border)" }}>
            {accessShares.length === 0 && (
              <div style={{ color: "var(--fg-dim)", padding: "0.75rem 0" }}>
                no share links yet — create them from a playlist page
              </div>
            )}
            {accessShares.map((s) => (
              <div
                key={s.id}
                style={{
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                <span style={{ color: "var(--fg-dim)", fontSize: "12px", width: "14ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.playlistName ?? s.playlistId}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.email || `link …${s.token.slice(-6)}`}
                </span>
                {/* Which of these links the viewer minted themselves. Anyone
                    in the locker may mint one, so without this the owner
                    cannot tell a link they handed out from one a collaborator
                    did — and removing that collaborator silently takes theirs
                    away (shares.created_by cascades).

                    Marks the POSITIVE case only. `mintedByMe` is false for
                    several different reasons (no minter recorded, no identity
                    to compare, or someone else minted it), so rendering
                    anything on false states more than the field knows — the
                    invariant lib/public-share.ts spells out. It is also read
                    by a collaborator: this panel is not owner-gated and
                    GET /shares is locker-scoped, so a collaborator sees the
                    OWNER's links here with mintedByMe false. Labelling those
                    "shared by a collaborator" — which an earlier version of
                    this row did — was simply wrong.

                    Attribution only: every control on this row works on every
                    row regardless of the marker. */}
                {s.mintedByMe && (
                  <span style={{ color: "var(--fg-dim)", fontSize: "12px" }}>yours</span>
                )}
                <span
                  style={{
                    color: s.permission === "edit" ? "var(--accent)" : "var(--fg-dim)",
                    fontSize: "12px",
                  }}
                >
                  {s.permission === "edit" ? "listen + edit" : "listen"}
                </span>
                <button
                  onClick={() => toggleEdit(s)}
                  title={s.permission === "edit" ? "Revoke upload/reorder" : "Grant upload/reorder"}
                  style={{ ...linkStyle, color: "var(--accent)" }}
                >
                  {s.permission === "edit" ? "[revoke edit]" : "[grant edit]"}
                </button>
                <button
                  onClick={() => revokeShare(s.id)}
                  title="Revoke this link entirely"
                  style={{ ...linkStyle, color: "var(--error)" }}
                >
                  [revoke]
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Owner-only, and on `true` alone: a collaborator may not see who else
          is in the locker, let alone invite anyone. Every /collab route
          enforces the same rule with a non-enumerable 404 — this is the UI
          half, not the guard. */}
      {isOwner === true && <CollabPanel />}

      <div className="box-header">playlists</div>
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {loadState === "loading" && (
          <div style={{ color: "var(--fg-dim)", padding: "0.75rem 0" }}>
            loading...
          </div>
        )}
        {loadState === "error" && (
          <div style={{ padding: "0.75rem 0" }}>
            <div style={{ color: "#f44", marginBottom: "0.5rem" }}>
              couldn't load playlists: {loadError}
            </div>
            <button onClick={() => load()} style={linkStyle}>
              [retry]
            </button>
          </div>
        )}
        {loadState === "ready" && playlists.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.75rem 0" }}>
            no playlists yet
          </div>
        )}
        {playlists.map((p) => {
          const art = api.artworkUrl(p.id, p.artworkKey);
          return (
            <div
              key={p.id}
              onClick={() => onSelect(p.id)}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  flex: "none",
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  overflow: "hidden",
                }}
              >
                {art && (
                  <img
                    src={art}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                )}
              </div>
              {/* minWidth:0 is the other half of Attribution's contract: a
                  flex item defaults to min-content width, so without this the
                  name below pushes the row wider than the viewport instead of
                  the title giving up space. */}
              <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
              <Attribution mine={p.createdByMe} name={p.createdByName} verb="Created" />
              <span style={{ color: "var(--fg-dim)", fontSize: "12px", flex: "none" }}>
                {new Date(p.updatedAt).toLocaleDateString()}
              </span>
              {/* `createdByMe || isOwner` — the client rule stated in
                  lib/public-playlist.ts. createdByMe alone is wrong for the
                  owner (false on every collaborator-created playlist they may
                  nonetheless delete); isOwner alone is wrong for a
                  collaborator (the server refuses anything they did not
                  create, and offering the control anyway just 404s). */}
              {(p.createdByMe || isOwner === true) && (
                <button
                  onClick={(e) => handleDelete(e, p.id)}
                  onMouseLeave={() => setConfirmDeleteId(null)}
                  title={confirmDeleteId === p.id ? "Click again to delete" : "Delete playlist"}
                  aria-label={`Delete playlist ${p.name}`}
                  style={{
                    ...linkStyle,
                    color: confirmDeleteId === p.id ? "var(--error)" : "var(--fg-dim)",
                  }}
                >
                  {confirmDeleteId === p.id ? "[delete?]" : "[x]"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {playlistError && (
        <div role="alert" style={{ color: "#f44", fontSize: "12px", marginTop: "0.5rem" }}>
          {playlistError}
        </div>
      )}

      <form
        onSubmit={handleCreate}
        style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="new playlist name"
          style={{
            flex: 1,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
            fontFamily: "var(--font)",
            fontSize: "14px",
            padding: "0.5rem",
          }}
        />
        <button
          type="submit"
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--accent)",
            fontFamily: "var(--font)",
            fontSize: "13px",
            padding: "0.5rem 1rem",
            cursor: "pointer",
          }}
        >
          [+ create]
        </button>
      </form>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "2rem",
        }}
      >
        <div className="box-header" style={{ marginBottom: 0 }}>tracks</div>
        <Upload onPick={uploads.queue} />
      </div>
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {uploads.pending.map((p, i) => (
          <PendingTrackRow
            key={p.id}
            item={p}
            position={i + 1}
            onTitleChange={(title) => uploads.update(p.id, { title })}
            onStart={() => uploads.start(p.id)}
            onCancel={() => uploads.remove(p.id)}
          />
        ))}
        {loadState === "ready" && library.length === 0 && uploads.pending.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.75rem 0" }}>
            no tracks yet
          </div>
        )}
        {library.map((t) => {
          const isPlaying = playerState.track?.id === t.id && playerState.playing;
          return (
            <div
              key={t.id}
              onClick={() => playLibraryTrack(t.id)}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <span style={{ color: "var(--accent)", width: "2ch", flex: "none" }}>
                {isPlaying ? "⏸" : "▶"}
              </span>
              {/* minWidth:0 — see the playlist row above. */}
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: isPlaying ? "var(--accent)" : "var(--fg)",
                }}
              >
                {t.title}
              </span>
              <Attribution mine={t.uploadedByMe} name={t.uploadedByName} verb="Uploaded" />
              <span style={{ color: "var(--fg-dim)", fontSize: "12px", flex: "none" }}>
                {formatDuration(t.duration)}
              </span>
              {/* `uploadedByMe || isOwner` — see lib/public-track.ts. The
                  server refuses a collaborator deleting someone else's upload,
                  so an ungated control was offered and then silently 404'd. */}
              {(t.uploadedByMe || isOwner === true) && (
                <button
                  onClick={(e) => handleTrackDelete(e, t.id)}
                  onMouseLeave={() => setConfirmTrackDeleteId(null)}
                  title={
                    confirmTrackDeleteId === t.id
                      ? "Click again to delete permanently — this erases the original file"
                      : "Delete this track and its files for good"
                  }
                  aria-label={`Delete ${t.title} permanently, including the original file`}
                  style={{
                    ...linkStyle,
                    color: confirmTrackDeleteId === t.id ? "var(--error)" : "var(--fg-dim)",
                  }}
                >
                  {confirmTrackDeleteId === t.id ? "[delete?]" : "[x]"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {trackError && (
        <div role="alert" style={{ color: "#f44", fontSize: "12px", marginTop: "0.5rem" }}>
          {trackError}
        </div>
      )}
    </div>
  );
}

function formatDuration(s: number | null): string {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const fieldStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: "14px",
  padding: "0.5rem",
};

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-dim)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  cursor: "pointer",
  padding: 0,
};
