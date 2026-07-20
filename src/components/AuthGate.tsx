import { GitBranch, LoaderCircle, LockKeyhole, MailCheck, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RuntimeInfo } from "../runtime";

export function AuthGate({
  children,
}: {
  children: (runtime: RuntimeInfo, signOut: () => Promise<void>) => ReactNode;
}) {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signupComplete, setSignupComplete] = useState(false);
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
      if (!response.ok) {
        const message = result.message ?? result.error?.message ?? "Email or password is incorrect";
        throw new Error(
          response.status === 403 && /verif/i.test(message)
            ? "Verify your email before signing in. You can resend the verification email below."
            : message,
        );
      }
      setPassword("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in");
    } finally {
      setSubmitting(false);
    }
  };

  const signUp = async () => {
    const normalizedEmail = email.trim();
    const normalizedName = name.trim();
    if (!normalizedEmail || !normalizedName || !password) return;
    if (password.length < 12 || password.length > 128) {
      setError("Password must contain 12–128 characters.");
      return;
    }
    if (password !== passwordConfirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: normalizedName,
          email: normalizedEmail,
          password,
          callbackURL: "/",
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(result.message ?? result.error?.message ?? "Could not create the account");
      }
      setPassword("");
      setPasswordConfirmation("");
      setSignupComplete(true);
      setNotice(`We sent a verification link to ${normalizedEmail}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the account");
    } finally {
      setSubmitting(false);
    }
  };

  const resendVerification = async () => {
    if (!email.trim()) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/auth/send-verification-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), callbackURL: "/" }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(result.message ?? result.error?.message ?? "Could not resend the email");
      }
      setNotice("If that address has an unverified account, a new link has been sent.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resend the email");
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (nextMode: "sign-in" | "sign-up") => {
    setMode(nextMode);
    setPassword("");
    setPasswordConfirmation("");
    setError("");
    setNotice("");
    setSignupComplete(false);
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
            void (mode === "sign-in" ? signIn() : signUp());
          }}
        >
          <div className="auth-card__mark"><GitBranch size={22} /></div>
          <header>
            <h1>Locus Chat</h1>
            <p>{mode === "sign-in" ? "Sign in to your private workspace." : "Create a private workspace."}</p>
          </header>
          <div className="auth-card__mode" role="tablist" aria-label="Account access">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-in"}
              onClick={() => switchMode("sign-in")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-up"}
              onClick={() => switchMode("sign-up")}
            >
              Create account
            </button>
          </div>
          {mode === "sign-up" && !signupComplete && (
            <label>
              <span>Name</span>
              <input type="text" autoComplete="name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
          )}
          <label>
            <span>Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus={mode === "sign-in"} disabled={signupComplete} />
          </label>
          {!signupComplete && (
            <>
              <label>
                <span>Password {mode === "sign-up" && <small>12–128 characters</small>}</span>
                <input type="password" minLength={12} maxLength={128} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              {mode === "sign-up" && (
                <label>
                  <span>Confirm password</span>
                  <input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} />
                </label>
              )}
            </>
          )}
          {error && <p className="auth-card__error" role="alert">{error}</p>}
          {notice && <p className="auth-card__notice" role="status"><MailCheck size={15} /> {notice}</p>}
          {!signupComplete && (
            <button
              type="submit"
              disabled={
                submitting ||
                !email.trim() ||
                !password ||
                (mode === "sign-up" && (!name.trim() || !passwordConfirmation))
              }
            >
              {submitting
                ? <LoaderCircle className="auth-screen__spinner" size={15} />
                : mode === "sign-in" ? <LockKeyhole size={15} /> : <UserPlus size={15} />}
              {submitting ? (mode === "sign-in" ? "Signing in…" : "Creating account…") : (mode === "sign-in" ? "Sign in" : "Create account")}
            </button>
          )}
          {(signupComplete || (mode === "sign-in" && /verif/i.test(error))) && (
            <button
              className="auth-card__secondary"
              type="button"
              disabled={submitting || !email.trim()}
              onClick={() => void resendVerification()}
            >
              {submitting ? "Sending…" : "Resend verification email"}
            </button>
          )}
          {signupComplete && (
            <button className="auth-card__text-button" type="button" onClick={() => switchMode("sign-in")}>Back to sign in</button>
          )}
          <small>New accounts must verify their email before signing in.</small>
        </form>
      </main>
    );
  }

  return children(runtime, signOut);
}
