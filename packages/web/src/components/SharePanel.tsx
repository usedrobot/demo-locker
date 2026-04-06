import { useState, useEffect, useCallback } from "react";
import { shares as api, type Share } from "../lib/api";

type Props = {
  playlistId: string;
};

export default function SharePanel({ playlistId }: Props) {
  const [items, setItems] = useState<Share[]>([]);
  const [permission, setPermission] = useState<"listen" | "edit">("listen");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.forPlaylist(playlistId).then((r) => setItems(r.shares));
  }, [playlistId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    setError("");
    try {
      await api.create(playlistId, permission);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
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
    await navigator.clipboard.writeText(url);
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

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center" }}>
        <select
          value={permission}
          onChange={(e) => setPermission(e.target.value as "listen" | "edit")}
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
            fontFamily: "var(--font)",
            fontSize: "13px",
            padding: "0.4rem",
          }}
        >
          <option value="listen">listen</option>
          <option value="edit">edit</option>
        </select>
        <button onClick={handleCreate} style={btnStyle}>
          [+ share link]
        </button>
      </div>
      {error && (
        <div style={{ color: "#f44", fontSize: "12px", marginTop: "0.25rem" }}>
          {error}
        </div>
      )}
      <div style={{ color: "var(--fg-dim)", fontSize: "11px", marginTop: "0.5rem" }}>
        listen = play + comment (no account needed) · edit = reorder + upload (account required)
        · max {4} collaborators on free tier
      </div>
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

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  color: "var(--accent)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  padding: "0.4rem 0.75rem",
  cursor: "pointer",
};
