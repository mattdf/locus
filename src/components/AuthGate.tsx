import { GitBranch, LoaderCircle, LockKeyhole } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RuntimeInfo } from "../runtime";

export function AuthGate({
  children,
}: {
  children: (runtime: RuntimeInfo, signOut: () => Promise<void>) => ReactNode;
}) {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/runtime", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Could not connect to Locus");
    setRuntime((await response.json()) as RuntimeInfo);
  }, []);

  useEffect(() => {
    refresh().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Could not connect to Locus");
    });
  }, [refresh]);

  const signIn = async () => {
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), password, rememberMe: true }),
      });
      const result = (await response.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(result.message ?? result.error?.message ?? "Email or password is incorrect");
      setPassword("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in");
    } finally {
      setSubmitting(false);
    }
  };

  const signOut = useCallback(async () => {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    await refresh();
  }, [refresh]);

  if (!runtime) {
    return (
      <main className="auth-screen">
        <LoaderCircle className="auth-screen__spinner" size={22} />
        <span>{error || "Opening Locus…"}</span>
      </main>
    );
  }

  if (runtime.mode === "hosted" && !runtime.authenticated) {
    return (
      <main className="auth-screen">
        <form
          className="auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <div className="auth-card__mark"><GitBranch size={22} /></div>
          <header>
            <h1>Locus Chat</h1>
            <p>Sign in to your private workspace.</p>
          </header>
          <label>
            <span>Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus />
          </label>
          <label>
            <span>Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p className="auth-card__error" role="alert">{error}</p>}
          <button type="submit" disabled={submitting || !email.trim() || !password}>
            {submitting ? <LoaderCircle className="auth-screen__spinner" size={15} /> : <LockKeyhole size={15} />}
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          <small>Accounts are created by the Locus administrator.</small>
        </form>
      </main>
    );
  }

  return children(runtime, signOut);
}
