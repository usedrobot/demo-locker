import { useCallback, useEffect, useRef, useState } from "react";
import {
  playlists as api,
  tracks as tracksApi,
  shares as sharesApi,
  auth,
  type Playlist,
  type Track,
  type Share,
  setToken,
  isAuthFailure,
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
  const [showName, setShowName] = useState(false);
  // What the field holds while the panel is open, kept apart from `savedName`
  // so a background refetch (the tab regaining focus) cannot overwrite what
  // someone is halfway through typing.
  const [nameDraft, setNameDraft] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);
  const [accountEmail, setAccountEmail] = useState("");
  const [nameError, setNameError] = useState("");
  const [nameDone, setNameDone] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);
  // Dedupes a double submit synchronously, since `nameBusy` is not visible
  // until the next render. Deliberately NOT a `disabled`: a disabled control
  // blurs to <body> in a real browser and nothing puts focus back, so disabling
  // would owe a refocus effect (SharePanel.tsx has one) — disable-and-refocus
  // is one pattern, and this form has no other reason to need either half.
  // Same choice, for the same reason, as pages/Join.tsx.
  const nameBusyRef = useRef(false);
  const [accessShares, setAccessShares] = useState<Share[]>([]);
  // Null until the session is resolved. Owner-only surfaces render on `true`
  // alone, never on "not false", so a collaborator never sees them flash.
  // Resolved in the same load() as the lists, so rows are never painted before
  // it is known which of their delete controls belong on screen.
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  // Mirrors "we have resolved who this session is" for load(), which is a
  // useCallback with no dependencies and so cannot read the state above.
  const identityKnownRef = useRef(false);
  const [playlistError, setPlaylistError] = useState("");
  const [trackError, setTrackError] = useState("");
  // Refusals from the access panel's three writes. They used to be unhandled
  // rejections: the row simply did not change and nothing said why.
  const [accessError, setAccessError] = useState("");

  async function openAccess() {
    setAccessError("");
    try {
      const r = await sharesApi.listAll();
      setAccessShares(r.shares);
      setShowAccess(true);
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : "couldn't load your links");
      setShowAccess(true);
    }
  }

  async function toggleEdit(share: Share) {
    const next = share.permission === "edit" ? "listen" : "edit";
    setAccessError("");
    let r;
    try {
      r = await sharesApi.setPermission(share.id, next);
    } catch (err) {
      // Local state is left alone: the row keeps showing what the server
      // still believes, rather than a permission that was refused.
      setAccessError(err instanceof Error ? err.message : "couldn't change that link");
      return;
    }
    setAccessShares(
      accessShares.map((s) =>
        s.id === share.id ? { ...s, permission: r.share.permission } : s
      )
    );
  }

  async function revokeShare(id: string) {
    setAccessError("");
    try {
      await sharesApi.revoke(id);
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : "couldn't revoke that link");
      return;
    }
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
      //
      // It rides the first load, and any later one that still does not know
      // who this is (an earlier attempt having failed) — but not every focus
      // refetch. Who you are does not change while the tab is in the
      // background, and the one thing that would change it, being removed from
      // the locker, deletes the session with it: the two list calls below then
      // fail and the branch under this one catches that. A third request on
      // every focus bought nothing.
      const [r, lib, me] = await Promise.all([
        api.list(),
        tracksApi.list(),
        background && identityKnownRef.current ? Promise.resolve(null) : auth.me(),
      ]);
      setPlaylists(r.playlists);
      setLibrary(lib.tracks);
      if (me) {
        setIsOwner(me.user.lockerOwnerId === null);
        setSavedName(me.user.displayName);
        setAccountEmail(me.user.email);
        identityKnownRef.current = true;
      }
      setLoadState("ready");
      setLoadError("");
    } catch (err) {
      // A background refetch stays silent on a TRANSIENT failure — inserting
      // an error mid-view over a blip that self-heals on the next focus is
      // worse than nothing. An expired or revoked session is not transient:
      // it does not self-heal, and staying silent left `isOwner` asserting
      // affordances the server would now refuse. Surfaced either way.
      if (background && !isAuthFailure(err)) return;
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
    setPlaylistError("");
    let playlist;
    try {
      ({ playlist } = await api.create(newName.trim()));
    } catch (err) {
      // Notably the playlist cap: the server refuses with a readable message
      // and the form used to just sit there with the name still in it.
      setPlaylistError(err instanceof Error ? err.message : "couldn't create that playlist");
      return;
    }
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

  async function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nameBusyRef.current) return;
    nameBusyRef.current = true;
    setNameBusy(true);
    setNameError("");
    setNameDone(false);
    try {
      // The server trims, and stores NULL for an empty name — so the response
      // is what was actually saved, and the field adopts it rather than what
      // was typed.
      const { displayName } = await auth.setDisplayName(nameDraft);
      setSavedName(displayName);
      setNameDraft(displayName ?? "");
      setNameDone(true);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "couldn't save that name");
    } finally {
      nameBusyRef.current = false;
      setNameBusy(false);
    }
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
              if (showName) {
                setShowName(false);
                return;
              }
              // Seeded on open, from the last value the session reported.
              setNameDraft(savedName ?? "");
              setNameError("");
              setNameDone(false);
              setShowName(true);
            }}
            style={{ ...linkStyle, color: showName ? "var(--accent)" : "var(--fg-dim)" }}
          >
            [name]
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

      {showName && (
        <div style={{ marginBottom: "2rem" }}>
          <div className="box-header">your name</div>
          <form
            onSubmit={handleNameSubmit}
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
              aria-label="display name"
              placeholder="your name"
              style={fieldStyle}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
            {/* Unset is not "no name": it is the login address, on every row
                this account uploaded, to everyone in the locker. Someone
                deciding whether to fill this in has to be told which address
                they are otherwise showing. */}
            <span style={{ color: "var(--fg-dim)", fontSize: "12px" }}>
              shown on your uploads and playlists — leave it empty to show{" "}
              {accountEmail} instead
            </span>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <button type="submit" style={linkStyle}>
                {nameBusy ? "[saving...]" : "[save]"}
              </button>
              {/* role="alert" like the other error surfaces on this page: a
                  refusal that only changes colour somewhere below the button is
                  a refusal a screen reader never announces. */}
              {nameError && (
                <span role="alert" style={{ color: "var(--error)" }}>
                  {nameError}
                </span>
              )}
              {nameDone && <span style={{ color: "var(--fg-dim)" }}>saved</span>}
            </div>
          </form>
        </div>
      )}

      {showAccess && (
        <div style={{ marginBottom: "2rem" }}>
          <div className="box-header">access — who can reach your locker</div>
          {accessError && (
            <div role="alert" style={{ color: "#f44", fontSize: "12px", padding: "0.5rem 0" }}>
              {accessError}
            </div>
          )}
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

          {/* Owner-only, and on `true` alone: a collaborator may not see who
              else is in the locker, let alone invite anyone. Every /collab
              route enforces the same rule with a non-enumerable 404 — this is
              the UI half, not the guard.

              Lives INSIDE the access panel, under the share links, because
              both answer one question: who can reach this locker. That means
              it is now gated twice — the panel must be open AND the viewer
              must be the owner — but only the inner `isOwner` check is load
              bearing. The access panel itself is deliberately NOT owner-gated
              (a collaborator opens it to manage share links, and GET /shares
              is locker-scoped), so this check is the only thing between a
              collaborator and the members list. Do not hoist it out of here
              on the assumption that the enclosing panel is owner-only. */}
          {isOwner === true && (
            <div style={{ marginTop: "2rem" }}>
              <CollabPanel />
            </div>
          )}
        </div>
      )}

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
