import { type FormEvent, useState } from "react";
import { useAuth } from "../AuthContext";

type Mode = "login" | "signup";

export function LoginScreen() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login({ username, password });
      } else {
        await signup({ username, password, inviteCode });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="im-login">
      <h1>In My Pocket</h1>
      <div className="im-login__tabs">
        <button
          type="button"
          className={mode === "login" ? "is-active" : ""}
          onClick={() => setMode("login")}
        >
          Log in
        </button>
        <button
          type="button"
          className={mode === "signup" ? "is-active" : ""}
          onClick={() => setMode("signup")}
        >
          Sign up
        </button>
      </div>
      <form onSubmit={onSubmit}>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={mode === "signup" ? 8 : 1}
          />
        </label>
        {mode === "signup" && (
          <label>
            Invite code
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              required
            />
          </label>
        )}
        {error && <div className="im-login__error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
