import {
  Clock3,
  GitBranch,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MailCheck,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RuntimeInfo } from "../runtime";

interface PublicInvite {
  valid: true;
  email: string | null;
  expiresAt: string | null;
  managedProvider: string | null;
  managedCredentialLabel: string | null;
}

export function AuthGate({
  children,
}: {
  children: (
    runtime: RuntimeInfo,
    signOut: () => Promise<void>,
    refreshRuntime: () => Promise<void>,
  ) => ReactNode;
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
  const [signupNeedsVerification, setSignupNeedsVerification] = useState(true);
  const [waitlistComplete, setWaitlistComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [invite, setInvite] = useState<PublicInvite | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const inviteToken = new URLSearchParams(window.location.search).get("invite")?.trim() || "";

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

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    setInviteLoading(true);
    fetch(`/api/access/invites/${encodeURIComponent(inviteToken)}`, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as {
          invite?: PublicInvite;
          error?: string;
        };
        if (!response.ok || !result.invite) throw new Error(result.error ?? "This invite is no longer available");
        if (cancelled) return;
        setInvite(result.invite);
        setMode("sign-up");
        if (result.invite.email) setEmail(result.invite.email);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "This invite is no longer available");
      })
      .finally(() => {
        if (!cancelled) setInviteLoading(false);
      });
    return () => { cancelled = true; };
  }, [inviteToken]);

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
      const response = await fetch("/api/access/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: normalizedName,
          email: normalizedEmail,
          password,
          ...(invite ? { inviteToken } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        verificationRequired?: boolean;
      };
      if (!response.ok) throw new Error(result.error ?? "Could not create the account");
      const verificationRequired = result.verificationRequired !== false;
      setPassword("");
      setPasswordConfirmation("");
      setSignupNeedsVerification(verificationRequired);
      setSignupComplete(true);
      setNotice(
        verificationRequired
          ? `We sent a verification link to ${normalizedEmail}.`
          : "Account created. You can sign in now.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the account");
    } finally {
      setSubmitting(false);
    }
  };

  const joinWaitlist = async () => {
    if (!email.trim() || !name.trim()) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/access/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), name: name.trim() }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not join the waitlist");
      setWaitlistComplete(true);
      setNotice("You’re on the waitlist. We’ll use this email when access becomes available.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not join the waitlist");
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
    setSignupNeedsVerification(true);
    setWaitlistComplete(false);
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

  if (runtime.mode === "hosted" && runtime.suspended) {
    return (
      <main className="auth-screen">
        <section className="auth-card auth-card--suspended">
          <div className="auth-card__mark"><LockKeyhole size={22} /></div>
          <header>
            <h1>Account suspended</h1>
            <p>This account cannot access Locus or perform actions. Contact the administrator to restore access.</p>
          </header>
        </section>
      </main>
    );
  }

  if (runtime.mode === "hosted" && !runtime.authenticated) {
    const waitlistMode = mode === "sign-up" && runtime.signupMode === "waitlist" && !invite;
    const complete = signupComplete || waitlistComplete;
    return (
      <main className="auth-screen">
        <form
          className="auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "sign-in") void signIn();
            else if (waitlistMode) void joinWaitlist();
            else void signUp();
          }}
        >
          <div className="auth-card__mark"><GitBranch size={22} /></div>
          <header>
            <h1>Locus Chat</h1>
            <p>
              {mode === "sign-in"
                ? "Sign in to your private workspace."
                : waitlistMode
                  ? "Public signup is closed. Join the waitlist for access."
                  : invite
                    ? "Create your account using this invite."
                    : "Create a private workspace."}
            </p>
          </header>
          <div className="auth-card__mode" role="tablist" aria-label="Account access">
            <button type="button" role="tab" aria-selected={mode === "sign-in"} onClick={() => switchMode("sign-in")}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === "sign-up"} onClick={() => switchMode("sign-up")}>
              {runtime.signupMode === "waitlist" && !invite ? "Join waitlist" : "Create account"}
            </button>
          </div>
          {inviteLoading && <p className="auth-card__notice"><LoaderCircle className="auth-screen__spinner" size={15} /> Checking invite…</p>}
          {invite && mode === "sign-up" && (
            <p className="auth-card__notice auth-card__notice--invite">
              <KeyRound size={15} />
              {invite.managedProvider
                ? `Invite includes administrator-managed ${invite.managedProvider} access; no API key is required.`
                : "Invite accepted."}
            </p>
          )}
          {mode === "sign-up" && !complete && (
            <label>
              <span>Name</span>
              <input type="text" autoComplete="name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
          )}
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoFocus={mode === "sign-in"}
              disabled={complete || Boolean(mode === "sign-up" && invite?.email)}
            />
          </label>
          {!complete && !waitlistMode && (
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
          {!complete && (
            <button
              type="submit"
              disabled={
                submitting || inviteLoading || !email.trim() ||
                (mode === "sign-in" && !password) ||
                (mode === "sign-up" && (
                  !name.trim() || (!waitlistMode && (!password || !passwordConfirmation))
                ))
              }
            >
              {submitting
                ? <LoaderCircle className="auth-screen__spinner" size={15} />
                : mode === "sign-in"
                  ? <LockKeyhole size={15} />
                  : waitlistMode ? <Clock3 size={15} /> : <UserPlus size={15} />}
              {submitting
                ? mode === "sign-in" ? "Signing in…" : waitlistMode ? "Joining…" : "Creating account…"
                : mode === "sign-in" ? "Sign in" : waitlistMode ? "Join waitlist" : "Create account"}
            </button>
          )}
          {((signupComplete && signupNeedsVerification) || (mode === "sign-in" && /verif/i.test(error))) && (
            <button className="auth-card__secondary" type="button" disabled={submitting || !email.trim()} onClick={() => void resendVerification()}>
              {submitting ? "Sending…" : "Resend verification email"}
            </button>
          )}
          {complete && (
            <button className="auth-card__text-button" type="button" onClick={() => switchMode("sign-in")}>Continue to sign in</button>
          )}
          <small>
            {waitlistMode
              ? "Joining the waitlist does not create an account."
              : invite
                ? "Invite accounts can sign in immediately."
                : "New accounts must verify their email before signing in."}
          </small>
        </form>
      </main>
    );
  }

  return children(runtime, signOut, refresh);
}
