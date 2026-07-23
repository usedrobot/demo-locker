import { useState } from "react";
import { auth, setToken } from "../lib/api";
import Logo from "../components/Logo";

type Props = {
  onAuth: () => void;
};

export default function Login({ onAuth }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const result = await auth.login(email, password);
      setToken(result.token);
      onAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  }

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <Logo />
      </div>

      <p style={{ color: "var(--fg-dim)", fontSize: "12px", marginBottom: "1rem" }}>
        private workspace
      </p>

      <form onSubmit={handleSubmit} style={{ maxWidth: "400px" }}>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ color: "var(--fg-dim)", fontSize: "12px" }}>
            email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ color: "var(--fg-dim)", fontSize: "12px" }}>
            password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            style={inputStyle}
          />
        </div>
        {error && (
          <div style={{ color: "#f44", marginBottom: "0.75rem" }}>{error}</div>
        )}
        <button type="submit" style={btnStyle}>
          [enter locker]
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  color: "var(--fg)",
  fontFamily: "var(--font)",
  fontSize: "14px",
  padding: "0.5rem",
  marginTop: "0.25rem",
};

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  color: "var(--accent)",
  fontFamily: "var(--font)",
  fontSize: "13px",
  padding: "0.5rem 1rem",
  cursor: "pointer",
};
