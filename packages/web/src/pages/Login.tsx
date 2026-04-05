import { useState } from "react";
import { auth, setToken } from "../lib/api";

type Props = {
  onAuth: () => void;
};

export default function Login({ onAuth }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const result = isSignup
        ? await auth.signup(email, password)
        : await auth.login(email, password);
      setToken(result.token);
      onAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: "400px" }}>
      <pre style={{ marginBottom: "1.5rem" }}>{`┌──────────────────────────────┐
│  demo locker                 │
└──────────────────────────────┘`}</pre>

      <form onSubmit={handleSubmit}>
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
          [{isSignup ? "sign up" : "log in"}]
        </button>
        <button
          type="button"
          onClick={() => setIsSignup(!isSignup)}
          style={{ ...btnStyle, color: "var(--fg-dim)", marginLeft: "1rem" }}
        >
          {isSignup ? "have an account? log in" : "need an account? sign up"}
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
