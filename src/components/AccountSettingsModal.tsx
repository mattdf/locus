import {
  AtSign,
  CheckCircle2,
  ChevronLeft,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { RuntimeUser } from "../runtime";

type AccountAction = "name" | "email" | "password";

interface AuthErrorResponse {
  code?: string;
  message?: string;
  error?: { message?: string };
}

async function accountRequest(pathname: string, body: Record<string, unknown>) {
  const response = await fetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as AuthErrorResponse;
  if (!response.ok) {
    throw new Error(
      result.message ?? result.error?.message ?? "Could not update the account",
    );
  }
  return result;
}

export function AccountSettingsModal({
  user,
  onRefresh,
  onBack,
  onClose,
}: {
  user: RuntimeUser;
  onRefresh: () => Promise<void>;
  onBack: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [busy, setBusy] = useState<AccountAction | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => setName(user.name), [user.name]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const updateName = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 200) return;
    setBusy("name");
    setFeedback(null);
    try {
      await accountRequest("/api/auth/update-user", { name: normalizedName });
      await onRefresh();
      setName(normalizedName);
      setFeedback({ kind: "success", message: "Name updated." });
    } catch (reason) {
      setFeedback({
        kind: "error",
        message: reason instanceof Error ? reason.message : "Could not update your name",
      });
    } finally {
      setBusy(null);
    }
  };

  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email || email === user.email.toLowerCase() || email.length > 254) return;
    setBusy("email");
    setFeedback(null);
    try {
      await accountRequest("/api/auth/change-email", {
        newEmail: email,
        callbackURL: "/",
      });
      setNewEmail("");
      setFeedback({
        kind: "success",
        message: `Check ${user.email} to confirm the change. We’ll then verify the new address before replacing the current one.`,
      });
    } catch (reason) {
      setFeedback({
        kind: "error",
        message: reason instanceof Error ? reason.message : "Could not change your email",
      });
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 12 || newPassword.length > 128) {
      setFeedback({
        kind: "error",
        message: "The new password must contain 12–128 characters.",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setFeedback({ kind: "error", message: "The new passwords do not match." });
      return;
    }
    setBusy("password");
    setFeedback(null);
    try {
      await accountRequest("/api/auth/change-password", {
        currentPassword,
        newPassword,
        revokeOtherSessions,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await onRefresh();
      setFeedback({
        kind: "success",
        message: revokeOtherSessions
          ? "Password changed. Your other sessions have been signed out."
          : "Password changed.",
      });
    } catch (reason) {
      setFeedback({
        kind: "error",
        message: reason instanceof Error ? reason.message : "Could not change your password",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal settings-modal--account"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-title"
      >
        <header>
          <button
            className="settings-back-button"
            type="button"
            aria-label="Back to settings"
            title="Back to settings"
            onClick={onBack}
          >
            <ChevronLeft size={17} />
          </button>
          <div>
            <span>Private account</span>
            <h2 id="account-settings-title">Account settings</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close account settings" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="account-settings">
          <div className="account-settings__identity">
            <UserRound size={16} />
            <span>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
          </div>

          {feedback && (
            <p
              className={`account-settings__feedback account-settings__feedback--${feedback.kind}`}
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.kind === "success" && <CheckCircle2 size={14} />}
              {feedback.message}
            </p>
          )}

          <form className="account-settings__section" onSubmit={updateName}>
            <header>
              <UserRound size={15} />
              <div>
                <strong>Name</strong>
                <small>Used to identify you inside Locus and in account email.</small>
              </div>
            </header>
            <label className="settings-field">
              <span>Your name</span>
              <input
                type="text"
                autoComplete="name"
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <footer>
              <button
                className="primary-button"
                type="submit"
                disabled={busy !== null || !name.trim() || name.trim() === user.name}
              >
                {busy === "name" && <LoaderCircle className="auth-screen__spinner" size={13} />}
                Save name
              </button>
            </footer>
          </form>

          <form className="account-settings__section" onSubmit={changeEmail}>
            <header>
              <AtSign size={15} />
              <div>
                <strong>Email address</strong>
                <small>Your existing address remains active until the new one is verified.</small>
              </div>
            </header>
            <label className="settings-field">
              <span>New email</span>
              <input
                type="email"
                autoComplete="email"
                maxLength={254}
                placeholder={user.email}
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
            </label>
            <footer>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  busy !== null ||
                  !newEmail.trim() ||
                  newEmail.trim().toLowerCase() === user.email.toLowerCase()
                }
              >
                {busy === "email" && <LoaderCircle className="auth-screen__spinner" size={13} />}
                Verify new email
              </button>
            </footer>
          </form>

          <form className="account-settings__section" onSubmit={changePassword}>
            <header>
              <KeyRound size={15} />
              <div>
                <strong>Password</strong>
                <small>Enter your current password and choose a new one.</small>
              </div>
            </header>
            <div className="account-settings__password-fields">
              <label className="settings-field">
                <span>Current password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>New password <small>12–128 characters</small></span>
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
            </div>
            <label className="account-settings__session-option">
              <input
                type="checkbox"
                checked={revokeOtherSessions}
                onChange={(event) => setRevokeOtherSessions(event.target.checked)}
              />
              <ShieldCheck size={14} />
              <span>
                <strong>Sign out other sessions</strong>
                <small>This device remains signed in.</small>
              </span>
            </label>
            <footer>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  busy !== null ||
                  !currentPassword ||
                  newPassword.length < 12 ||
                  !confirmPassword
                }
              >
                {busy === "password" && <LoaderCircle className="auth-screen__spinner" size={13} />}
                Change password
              </button>
            </footer>
          </form>
        </div>

        <footer className="account-settings__footer">
          <button className="secondary-button" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
