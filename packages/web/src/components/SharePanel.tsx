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

  const load = useCallback(() => {
    api.forPlaylist(playlistId).then((r) => setItems(r.shares));
  }, [playlistId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (creatingRef.current) return;
    creatingRef.current = true;
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
          aria-label="who is this for?"
          placeholder="who is this for?"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
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
        {extraAction}
      </div>
      {error && (
        <div style={{ color: "#f44", fontSize: "12px", marginTop: "0.25rem" }}>
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
