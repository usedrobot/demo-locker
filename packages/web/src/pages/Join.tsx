import { useRef, useState } from "react";
import { auth, setToken } from "../lib/api";
import { adoptAccent } from "../lib/theme";
import Logo from "../components/Logo";

type Props = {
  token: string;
  onAuth: () => void;
};

// Redeeming a collaborator invite: the account is created here, bound to the
// inviter's locker by the token in the URL. This is the only way to register on
// an instance whose signup is closed, which is every instance that already has
// an owner.
export default function Join({ token, onAuth }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Dedupes a double submit synchronously, since `busy` is not visible until
  // the next render. Deliberately NOT a `disabled` on the submit button: a
  // disabled control blurs to <body> in a real browser and nothing puts focus
  // back, so disabling would owe a refocus effect (see SharePanel.tsx) for a
  // one-shot form that has no other reason to need one.
  const busyRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    setBusy(true);
    try {
      const result = await auth.signup(email, password, token);
      // Stores the session and lands on Home exactly as login does.
      setToken(result.token);
      adoptAccent(result.user.accent);
      onAuth();
    } catch (err) {
      // The API's own text, verbatim: an invite that has already been redeemed
      // says "this invite is not valid" and a full locker says so too. A
      // generic "signup failed" here would make a spent invite look like a
      // broken page, and the person would keep retrying it.
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <Logo />
      </div>

      <p style={{ color: "var(--fg-dim)", fontSize: "12px", marginBottom: "1rem" }}>
        you've been invited to share a locker — pick a password and you're in
      </p>

      <form onSubmit={handleSubmit} style={{ maxWidth: "400px" }}>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ color: "var(--fg-dim)", fontSize: "12px" }}>email</label>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ color: "var(--fg-dim)", fontSize: "12px" }}>password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            style={inputStyle}
          />
        </div>
        {error && (
          <div role="alert" style={{ color: "#f44", marginBottom: "0.75rem" }}>
            {error}
          </div>
        )}
        <button type="submit" style={btnStyle}>
          {busy ? "[joining...]" : "[join locker]"}
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
