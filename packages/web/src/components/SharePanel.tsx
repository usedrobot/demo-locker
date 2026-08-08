import { useState, useEffect, useCallback, useRef } from "react";
import { shares as api, type Share } from "../lib/api";
import { copyText } from "../lib/copy-text";

type Props = {
  playlistId: string;
  extraAction?: React.ReactNode;
};

export default function SharePanel({ playlistId, extraAction }: Props) {
  const [items, setItems] = useState<Share[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  // Belt-and-suspenders with `creating`: state updates aren't visible until
  // the next render, so two clicks inside the same tick (a fast double-click,
  // or Enter immediately followed by a click) can both pass a `creating`
  // check that hasn't re-rendered yet. The ref is synchronous and closes that
  // window; `creating` still drives the disabled button for the UI.
  const creatingRef = useRef(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  // Tracks the previous `creating` value so the refocus effect below can tell
  // "a mint just finished" (true -> false) apart from "this is the initial
  // render" (false -> false) — see that effect for why the distinction
  // matters.
  const wasCreatingRef = useRef(false);
  // Whether focus was in the label input at the moment a mint started. Captured
  // synchronously in handleCreate, NOT in the refocus effect: by the time that
  // effect runs, the render carrying `disabled` has already committed and a real
  // browser has already moved focus to <body>, so there is nothing left to read.
  const focusWasInLabelRef = useRef(false);

  const load = useCallback(() => {
    api.forPlaylist(playlistId).then((r) => setItems(r.shares));
  }, [playlistId]);

  useEffect(() => {
    load();
  }, [load]);

  // Disabling a focused input moves focus to <body>, and the label input is
  // never unmounted, so nothing brings focus back on its own once `creating`
  // flips false: the field comes back editable but unfocused, a correction
  // goes to the document instead of the input, and repeat mints need a
  // re-click. Task 9 hit the identical bug on the rename field
  // (PlaylistView.tsx:53-63) and fixed it by refocusing in an effect — but
  // that version refocuses unconditionally, which was later found to steal
  // focus from wherever the user had since moved (parked for a future fix
  // there). Three conditions gate this one:
  //   1. the true -> false transition only, so it never fires on mount, when
  //      nothing was ever disabled;
  //   2. focus was in the LABEL INPUT when the mint started. The mint button
  //      is `disabled={creating}` too, so clicking it — the more common path —
  //      also blurs to <body>; without this check the effect would yank focus
  //      into the label input, which is not the control the user was on. The
  //      button case is deliberately left to the browser's own behaviour after
  //      re-enable.
  //   3. focus is still unclaimed (activeElement is <body> or null) — if the
  //      user clicked something else while the mint was in flight, leave it.
  useEffect(() => {
    if (wasCreatingRef.current && !creating && focusWasInLabelRef.current) {
      if (document.activeElement === document.body || document.activeElement === null) {
        labelInputRef.current?.focus();
      }
    }
    wasCreatingRef.current = creating;
  }, [creating]);

  async function handleCreate() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    // Read focus before setCreating, while the input is still enabled and
    // still holds it. See focusWasInLabelRef.
    focusWasInLabelRef.current =
      labelInputRef.current !== null && document.activeElement === labelInputRef.current;
    setCreating(true);
    setError("");
    try {
      // shares.email is a display label, not an address — nothing is ever
      // sent to it. See SharePanel's "who is this for?" input below; do not
      // build an email-gated invite flow on top of this argument.
      await api.create(playlistId, canEdit ? "edit" : "listen", label.trim() || undefined);
      setLabel("");
      setCanEdit(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    await api.revoke(id);
    load();
  }

  function getInviteUrl(token: string): string {
    return `${window.location.origin}/invite/${token}`;
  }

  async function copyLink(token: string) {
    const url = getInviteUrl(token);
    if (!(await copyText(url))) return;
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <div className="box-header">sharing</div>
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {items.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.5rem 0" }}>
            no share links yet
          </div>
        )}
        {items.map((share) => (
          <div
            key={share.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.4rem 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                border: "1px solid var(--border)",
                color: share.permission === "edit" ? "var(--accent)" : "var(--fg-dim)",
              }}
            >
              {share.permission}
            </span>
            <span style={{ color: "var(--fg-dim)", fontSize: "12px", flex: 1 }}>
              {share.email || "anyone with link"}
            </span>
            <button
              onClick={() => copyLink(share.token)}
              style={linkBtn}
            >
              {copied === share.token ? "copied!" : "[copy link]"}
            </button>
            <button
              onClick={() => handleRevoke(share.id)}
              style={{ ...linkBtn, color: "#f44" }}
            >
              [revoke]
            </button>
          </div>
        ))}
      </div>

      <div className="share-actions">
        <input
          ref={labelInputRef}
          aria-label="who is this for?"
          placeholder="who is this for?"
          value={label}
          // Disabled while a mint is in flight — the same shape as the Task 9
          // rename field. That control started out leaving itself editable
          // mid-request and letting a slow response clobber whatever the user
          // typed next; after several rounds the fix was to close the window
          // entirely (disable) rather than try to reconcile a draft against
          // the eventual response. Doing the same here up front. (The refocus
          // effect above is the other half of that pattern — disabling alone
          // reproduces the bug it fixed.)
          disabled={creating}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            // In practice, disabling the input on the first Enter (above)
            // blurs it before the browser's key-repeat can deliver a second
            // keydown here, so this guard is not what stops a held Enter from
            // minting twice — the focus loss described above already does
            // that (indirectly, as a side effect, not as a guarantee). This
            // is defence for whatever path gets a repeat keydown to an
            // enabled field regardless (this is exactly how the unit test
            // exercises it, dispatching directly at the element) and for if
            // the disable-blur behavior above ever changes.
            if (e.repeat) return;
            // The Enter that commits an IME composition (e.g. selecting a
            // kanji candidate) also fires keydown with key "Enter". Treating
            // it as "submit" would mint a link from whatever partial text was
            // mid-composition, with no confirmation step. Verified against
            // Chrome/Firefox's `isComposing` behavior (both set it on that
            // keydown).
            //
            // KNOWN GAP, deliberately left open: Safari's composition-commit
            // keydown is *reported* to omit `isComposing`, so the IME bug may
            // still reproduce there. That is unverified — nobody has measured
            // it — and it stays unhandled on purpose.
            //
            // DO NOT re-add a `keyCode === 229` fallback without measuring
            // first. It was tried and reverted: the check has to run before
            // the `key === "Enter"` test, so it swallows *every* keydown
            // reporting 229 on *every* browser — and Android soft keyboards
            // (GBoard among others) report keyCode 229 with `isComposing`
            // false while predictive text is active. That turned Enter in this
            // field into a silent dead key on a common platform: no mint, no
            // feedback. Unmeasured defence that causes a known regression is
            // worse than the gap it was covering.
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") handleCreate();
          }}
          className="share-label-input"
        />
        <label className="share-perm">
          <input
            type="checkbox"
            aria-label="can upload and reorder"
            checked={canEdit}
            onChange={(e) => setCanEdit(e.target.checked)}
          />
          can upload and reorder
        </label>
        <button onClick={handleCreate} disabled={creating} className="tui-btn">
          [+ share link]
        </button>
        {/* Always rendered, text toggled — never mounted alongside its own
            content. A role="status" region has to be in the accessibility tree
            *before* its text changes; NVDA, JAWS and VoiceOver commonly drop
            the announcement when the node and its text arrive in the same
            commit. Keeping the node also means the mint's *completion* is
            observable: the text empties rather than the region vanishing.
            When idle this is a zero-width flex item (one extra 0.5rem gap in
            `.share-actions`; re-measured at 320px, still no overflow). */}
        <span
          role="status"
          className={creating ? "dots" : undefined}
          style={{ color: "var(--fg-dim)", fontSize: "11px", flex: "none" }}
        >
          {creating ? "minting" : ""}
        </span>
        {extraAction}
      </div>
      {error && (
        // role="alert" (assertive), the companion to the role="status" above:
        // on the Enter path the disable takes focus away and the refocus effect
        // silently hands it back, so without an announcement a screen-reader
        // user's only signal that the mint failed is that nothing happened —
        // and they retype and resubmit into the same error.
        <div role="alert" style={{ color: "#f44", fontSize: "12px", marginTop: "0.25rem" }}>
          {error}
        </div>
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-dim)",
  fontFamily: "var(--font)",
  fontSize: "12px",
  cursor: "pointer",
  padding: 0,
};
