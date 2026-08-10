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
  // Text of the polite live region: "" at rest, "minting" in flight, then a
  // completion message. Kept separate from `creating` precisely because the two
  // don't coincide — the completion text has to outlive the in-flight state.
  const [status, setStatus] = useState("");
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const mintButtonRef = useRef<HTMLButtonElement>(null);
  // WHICH control had focus at the moment a mint started — the label input, the
  // mint button, or neither (null). Captured synchronously in handleCreate, NOT
  // in the refocus effect: by the time that effect runs, the render carrying
  // `disabled` has already committed and a real browser has already moved focus
  // to <body>, so there is nothing left to read.
  //
  // This deliberately stores an identity rather than a boolean. An earlier
  // version recorded only "was it the label input?" on the theory that the
  // button could be left to the browser's own post-re-enable behaviour. There is
  // no such behaviour: browsers do not restore focus to a re-enabled element.
  // That version therefore moved the original bug from the input to the button —
  // a keyboard user who tabs to [+ share link] and presses Enter is stranded on
  // <body>, losing their tab position, and in Chrome the mouse path lands there
  // too (mousedown focuses the button).
  const focusTargetRef = useRef<HTMLElement | null>(null);

  const clearStatusTimer = useCallback(() => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  // Announce, then retire the message so it doesn't linger as stale UI. Any new
  // announcement (or the next mint) supersedes a pending clear.
  const announce = useCallback(
    (message: string) => {
      clearStatusTimer();
      setStatus(message);
      statusTimerRef.current = setTimeout(() => {
        statusTimerRef.current = null;
        setStatus("");
      }, 5000);
    },
    [clearStatusTimer]
  );

  useEffect(() => clearStatusTimer, [clearStatusTimer]);

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
  // there). Both controls in this row are `disabled={creating}`, so either can
  // be the one that got blurred; the fix is to put focus back on whichever it
  // was. Three conditions gate it:
  //   1. the true -> false transition only, so it never fires on mount, when
  //      nothing was ever disabled;
  //   2. a control we disabled actually held focus when the mint started
  //      (focusTargetRef) — restoring to a specific element, not to a default;
  //   3. focus is still unclaimed (activeElement is <body> or null) — if the
  //      user clicked something else while the mint was in flight, leave it.
  useEffect(() => {
    if (wasCreatingRef.current && !creating && focusTargetRef.current) {
      if (document.activeElement === document.body || document.activeElement === null) {
        focusTargetRef.current.focus();
      }
      focusTargetRef.current = null;
    }
    wasCreatingRef.current = creating;
  }, [creating]);

  async function handleCreate() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    // Read focus before setCreating, while both controls are still enabled and
    // whichever one holds focus still holds it. See focusTargetRef.
    const active = document.activeElement;
    focusTargetRef.current =
      active !== null && (active === labelInputRef.current || active === mintButtonRef.current)
        ? (active as HTMLElement)
        : null;
    setCreating(true);
    // Supersedes any lingering completion message from a previous mint (and
    // its pending clear) — this is the "or on the next interaction" half of
    // retiring that text.
    clearStatusTimer();
    setStatus("minting");
    setError("");
    try {
      // shares.email is a display label, not an address — nothing is ever
      // sent to it. See SharePanel's "who is this for?" input below; do not
      // build an email-gated invite flow on top of this argument.
      await api.create(playlistId, canEdit ? "edit" : "listen", label.trim() || undefined);
      setLabel("");
      setCanEdit(false);
      // Completion is given its own TEXT rather than an empty region: live
      // regions announce added or changed content, and emptying a polite one is
      // conventionally understood to be silent, so "minting" -> "" would leave
      // whoever heard the start with no signal that it ever ended. The success
      // path has no other non-visual cue — the new row appears, but nothing
      // says so.
      //
      // ⚠️ UNVERIFIED, and suspected not to be heard at all on this path — see
      // the role="status" block below. Setting this text is necessary but may
      // not be sufficient; the refocus in the same commit may swallow it.
      announce("share link created");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      // The failure is announced assertively by the role="alert" below, so
      // clear the polite region rather than announcing twice.
      setStatus("");
      clearStatusTimer();
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
        <button
          ref={mintButtonRef}
          onClick={handleCreate}
          disabled={creating}
          className="tui-btn"
        >
          [+ share link]
        </button>
        {/* Always rendered, text swapped — never mounted alongside its own
            content, on the convention that a polite region should be in the
            accessibility tree *before* its text changes. Both transitions here
            are text CHANGES ("" -> "minting" -> "share link created") rather
            than a mount or an empty.

            ⚠️ NOT MEASURED. No screen reader has ever been run against this
            component, and the reasoning below is convention and inference, not
            observation. Treat it as a design rationale, not as a description of
            what a user hears. Two specific things are suspected WRONG:

              1. `.dots` (applied to this very element while `creating`) animates
                 ::after `content` through "" / "." / ".." / "..." on a 1.4s
                 4-step loop — a generated-content change inside this polite
                 region roughly every 350ms. Whether a reader announces CSS
                 generated content, and whether it re-announces on each step, is
                 unknown here. If "minting" stutters or reads dots, this is why.
              2. The completion announcement may never be heard on the keyboard
                 path it was written for. `announce("share link created")` and
                 `setCreating(false)` land in the same React commit, and the
                 refocus effect calls focus() in that same commit — and moving
                 focus is widely reported to flush the pending polite queue. On
                 the Enter path focusTargetRef is always set (focus was on the
                 mint button), so that refocus always fires.

            Resolving either needs VoiceOver/NVDA/JAWS on the real component;
            until then do not cite this comment as evidence of behaviour. The
            sibling role="alert" region below carries the same caveat and says
            so.

            Measured and true: when idle this is a zero-width flex item (one
            extra 0.5rem gap in `.share-actions`; re-measured at 320px in every
            state, still no overflow). */}
        <span
          role="status"
          className={creating ? "dots" : undefined}
          style={{ color: "var(--fg-dim)", fontSize: "11px", flex: "none" }}
        >
          {status}
        </span>
        {extraAction}
      </div>
      {error && (
        // role="alert" (assertive), the companion to the role="status" above:
        // on the Enter path the disable takes focus away and the refocus effect
        // silently hands it back, so without an announcement a screen-reader
        // user's only signal that the mint failed is that nothing happened —
        // and they retype and resubmit into the same error.
        //
        // DELIBERATE ASYMMETRY with that region, recorded rather than removed:
        // this container is conditionally mounted ({error && ...}), i.e. node
        // and text arrive in the same commit — exactly the pattern the status
        // region above was rebuilt to avoid. The rules genuinely differ by
        // politeness: assertive regions are reliably announced on insertion,
        // polite ones frequently are not. Neither claim has been measured with
        // a real screen reader here; this is the documented convention, not an
        // observation. If a reader is ever seen to miss this alert, mounting
        // the container permanently and toggling its text (as above) is the
        // known fix — do that rather than assume the role is wrong.
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
