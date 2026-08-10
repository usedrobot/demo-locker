import { useCallback, useEffect, useRef, useState } from "react";
import {
  collab as api,
  type CollabInvite,
  type CollabMember,
} from "../lib/api";
import { copyText } from "../lib/copy-text";

// Who shares this locker, and how someone else gets in. Owner-only — Home
// mounts this behind `user.lockerOwnerId === null`, and every /collab route
// refuses a collaborator with a 404 regardless.
export default function CollabPanel() {
  const [members, setMembers] = useState<CollabMember[]>([]);
  const [invites, setInvites] = useState<CollabInvite[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Synchronous companion to `inviting`: state is not visible until the next
  // render, so two clicks in the same tick both pass an `inviting` check that
  // has not re-rendered yet. Same guard, and the same reason, as SharePanel's
  // creatingRef.
  const invitingRef = useRef(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);
  // Tracks the previous `inviting` value so the refocus effect can tell "an
  // invite just finished" (true -> false) from "this is the first render"
  // (false -> false).
  const wasInvitingRef = useRef(false);
  // WHICH control held focus when the invite started. Captured synchronously in
  // handleInvite, before the render carrying `disabled` commits — by the time
  // the effect runs, a real browser has already moved focus to <body> and there
  // is nothing left to read. Stores an identity, not a boolean: restoring to a
  // default would strand a keyboard user who started from the button.
  const focusTargetRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, m] = await Promise.all([api.listInvites(), api.listMembers()]);
      setInvites(i.invites);
      setMembers(m.members);
      // No setError("") on success: every caller that reloads (handleInvite,
      // handleRemoveMember, handleRevokeInvite) clears the error before it
      // acts, so clearing again here is unreachable — a mutation check
      // confirmed no test could tell the difference.
    } catch (err) {
      // An empty list and a failed request look identical on screen, and
      // "nobody is in your locker" is a dangerous thing to say wrongly.
      setError(err instanceof Error ? err.message : "failed to load collaborators");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Both controls in the footer row are `disabled={inviting}`, and disabling a
  // focused control blurs it to <body> in a real browser. Nothing brings focus
  // back on its own once `inviting` flips false — the field returns editable
  // but unfocused and the next keystroke goes to the document. This is the
  // other half of the disable pattern; SharePanel.tsx:99-107 is the worked
  // example. Three conditions gate it:
  //   1. the true -> false transition only, so it never fires on mount;
  //   2. a control we disabled actually held focus when the invite started;
  //   3. focus is still unclaimed — if the user clicked elsewhere mid-request,
  //      leave it alone rather than yanking it back.
  useEffect(() => {
    if (wasInvitingRef.current && !inviting && focusTargetRef.current) {
      if (document.activeElement === document.body || document.activeElement === null) {
        focusTargetRef.current.focus();
      }
      focusTargetRef.current = null;
    }
    wasInvitingRef.current = inviting;
  }, [inviting]);

  async function handleInvite() {
    if (invitingRef.current) return;
    const name = label.trim();
    // Whitespace-only is refused here rather than round-tripped: the server
    // answers a blank label with a 400, and there is nothing to tell the user
    // that they do not already know.
    if (!name) return;
    invitingRef.current = true;
    // Read focus while both controls are still enabled — see focusTargetRef.
    const active = document.activeElement;
    focusTargetRef.current =
      active !== null && (active === labelInputRef.current || active === inviteButtonRef.current)
        ? (active as HTMLElement)
        : null;
    setInviting(true);
    setError("");
    try {
      await api.invite(name);
      setLabel("");
      // The token in the new row is the only copy of that link, so the list has
      // to come back without a manual refresh.
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to invite");
    } finally {
      invitingRef.current = false;
      setInviting(false);
    }
  }

  async function handleRemoveMember(id: string) {
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id);
      return;
    }
    setConfirmRemoveId(null);
    setError("");
    try {
      await api.removeMember(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to remove");
    }
  }

  async function handleRevokeInvite(id: string) {
    if (confirmRevokeId !== id) {
      setConfirmRevokeId(id);
      return;
    }
    setConfirmRevokeId(null);
    setError("");
    try {
      await api.revokeInvite(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to revoke");
    }
  }

  async function handleCopy(token: string) {
    // copyText, not navigator.clipboard: the latter is undefined outside a
    // secure context and plain-http self-hosts are a supported path.
    if (!(await copyText(`${window.location.origin}/join/${token}`))) return;
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }

  // A redeemed invite is spent — its person is in the members list above, and
  // showing the row too would read as a second, still-usable way in.
  const pending = invites.filter((i) => i.acceptedAt === null);

  return (
    <div style={{ marginBottom: "2rem" }}>
      <div className="box-header">collaborators — who shares this locker</div>
      <div style={{ borderTop: "1px solid var(--border)" }}>
        <div style={{ color: "var(--fg-dim)", fontSize: "12px", padding: "0.5rem 0" }}>
          collaborators share your library — they can upload tracks, create
          playlists and organise them. They can only delete what they uploaded
          themselves.
        </div>

        {members.length === 0 && pending.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.5rem 0" }}>
            nobody else yet
          </div>
        )}

        {members.map((m) => (
          <div key={m.id} style={rowStyle}>
            {/* The name they were invited under, which is what their uploads
                are labelled with everywhere else — with the address secondary,
                since this is the view where the owner needs to know exactly
                which account they are about to delete. Falls back to the email
                alone for a member who redeemed before display names existed. */}
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {m.displayName ?? m.email}
            </span>
            {m.displayName && (
              <span
                style={{
                  color: "var(--fg-dim)",
                  fontSize: "12px",
                  flex: "0 1 auto",
                  minWidth: 0,
                  maxWidth: "20ch",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {m.email}
              </span>
            )}
            <button
              onClick={() => handleRemoveMember(m.id)}
              onMouseLeave={() => setConfirmRemoveId(null)}
              title={
                confirmRemoveId === m.id
                  ? "Click again to remove — this deletes their account and every link they minted"
                  : "Remove this collaborator from your locker"
              }
              aria-label={`Remove ${m.email} from this locker`}
              style={{
                ...linkBtn,
                color: confirmRemoveId === m.id ? "var(--error)" : "var(--fg-dim)",
              }}
            >
              {confirmRemoveId === m.id ? "[remove?]" : "[remove]"}
            </button>
          </div>
        ))}

        {pending.map((i) => (
          <div key={i.id} style={rowStyle}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {i.label}
            </span>
            <span style={{ color: "var(--fg-dim)", fontSize: "12px" }}>invited</span>
            <button onClick={() => handleCopy(i.token)} style={linkBtn}>
              {copied === i.token ? "copied!" : "[copy link]"}
            </button>
            <button
              onClick={() => handleRevokeInvite(i.id)}
              onMouseLeave={() => setConfirmRevokeId(null)}
              title={
                confirmRevokeId === i.id
                  ? "Click again to revoke this invite"
                  : "Revoke this invite so the link stops working"
              }
              aria-label={`Revoke the invite for ${i.label}`}
              style={{
                ...linkBtn,
                color: confirmRevokeId === i.id ? "var(--error)" : "var(--fg-dim)",
              }}
            >
              {confirmRevokeId === i.id ? "[revoke?]" : "[revoke]"}
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem" }}>
        <input
          ref={labelInputRef}
          aria-label="name"
          placeholder="who are you inviting?"
          value={label}
          // Disabled in flight, paired with the refocus effect above — see
          // SharePanel.tsx for why adopting the disable without the refocus
          // reproduces the bug it was meant to fix.
          disabled={inviting}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            // A held Enter can deliver repeats to a still-enabled field.
            if (e.repeat) return;
            // The Enter that commits an IME composition also fires keydown with
            // key "Enter"; treating it as submit would mint an invite from
            // whatever was mid-composition. Same guard, and the same
            // deliberately-open Safari gap, as SharePanel's label field — see
            // the long note there before changing this (do NOT add a keyCode
            // 229 fallback).
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") handleInvite();
          }}
          style={{ ...fieldStyle, flex: 1, maxWidth: "18rem" }}
        />
        <button
          ref={inviteButtonRef}
          onClick={handleInvite}
          disabled={inviting}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--accent)",
            fontFamily: "var(--font)",
            fontSize: "13px",
            padding: "0.4rem 0.8rem",
            cursor: "pointer",
          }}
        >
          {inviting ? "[inviting...]" : "[+ invite]"}
        </button>
      </div>

      {error && (
        // role="alert": on the Enter path the disable takes focus away and the
        // refocus effect silently hands it back, so without an announcement a
        // screen-reader user's only signal that the invite failed is that
        // nothing happened. Same convention (and the same unmeasured caveat)
        // as SharePanel's alert.
        <div role="alert" style={{ color: "#f44", fontSize: "12px", marginTop: "0.5rem" }}>
          {error}
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  padding: "0.5rem 0",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-dim)",
  fontFamily: "var(--font)",
  fontSize: "12px",
  cursor: "pointer",
  padding: 0,
};

const fieldStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: "14px",
  padding: "0.4rem",
};
