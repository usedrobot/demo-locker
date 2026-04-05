import { useEffect, useState } from "react";
import { playlists as api, type Playlist, setToken } from "../lib/api";

type Props = {
  onSelect: (id: string) => void;
  onLogout: () => void;
};

export default function Home({ onSelect, onLogout }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    api.list().then((r) => setPlaylists(r.playlists));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const { playlist } = await api.create(newName.trim());
    setPlaylists([...playlists, playlist]);
    setNewName("");
  }

  function handleLogout() {
    setToken(null);
    onLogout();
  }

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <pre>{`┌──────────────────────────────┐
│  demo locker                 │
└──────────────────────────────┘`}</pre>
        <button onClick={handleLogout} style={linkStyle}>
          [logout]
        </button>
      </div>

      <div className="box-header">playlists</div>
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {playlists.length === 0 && (
          <div style={{ color: "var(--fg-dim)", padding: "0.75rem 0" }}>
            no playlists yet
          </div>
        )}
        {playlists.map((p) => (
          <div
            key={p.id}
            onClick={() => onSelect(p.id)}
            style={{
              padding: "0.5rem 0",
              borderBottom: "1px solid var(--border)",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>{p.name}</span>
            <span style={{ color: "var(--fg-dim)", fontSize: "12px" }}>
              {new Date(p.updatedAt).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>

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
