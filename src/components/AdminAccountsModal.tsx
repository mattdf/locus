import {
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserRound,
  UserX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  disabled: boolean;
  createdAt: string;
  activeSessions: number;
}

interface UsersResponse {
  users: ManagedUser[];
}

interface UserResponse {
  user: ManagedUser;
}

async function adminRequest<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(pathname, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Account request failed (${response.status})`);
  return result as T;
}

function accountRole(user: ManagedUser): "admin" | "user" {
  return user.role?.split(",").includes("admin") ? "admin" : "user";
}

export function AdminAccountsModal({
  currentUserId,
  onClose,
}: {
  currentUserId: string;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [passwordTarget, setPasswordTarget] = useState<ManagedUser | null>(null);
  const [replacementPassword, setReplacementPassword] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await adminRequest<UsersResponse>("/api/admin/users");
      setUsers(result.users);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !name.trim() || password.length < 12) return;
    setBusy("create");
    setError("");
    try {
      const result = await adminRequest<UserResponse>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), name: name.trim(), password, role }),
      });
      setUsers((current) => [...current, result.user]);
      setEmail("");
      setName("");
      setPassword("");
      setRole("user");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create account");
    } finally {
      setBusy(null);
    }
  };

  const updateAccount = async (
    user: ManagedUser,
    changes: { disabled?: boolean; role?: "admin" | "user" },
  ) => {
    setBusy(user.id);
    setError("");
    try {
      const result = await adminRequest<UserResponse>(
        `/api/admin/users/${encodeURIComponent(user.id)}`,
        { method: "PATCH", body: JSON.stringify(changes) },
      );
      setUsers((current) =>
        current.map((candidate) => candidate.id === user.id ? result.user : candidate),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update account");
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwordTarget || replacementPassword.length < 12) return;
    setBusy(passwordTarget.id);
    setError("");
    try {
      await adminRequest<{ changed: true }>(
        `/api/admin/users/${encodeURIComponent(passwordTarget.id)}/password`,
        { method: "POST", body: JSON.stringify({ password: replacementPassword }) },
      );
      setUsers((current) => current.map((candidate) =>
        candidate.id === passwordTarget.id
          ? { ...candidate, activeSessions: 0 }
          : candidate,
      ));
      setPasswordTarget(null);
      setReplacementPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reset password");
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async (user: ManagedUser) => {
    if (!window.confirm(`Permanently delete ${user.email} and all of its chats?`)) return;
    setBusy(user.id);
    setError("");
    try {
      await adminRequest<Record<string, never>>(
        `/api/admin/users/${encodeURIComponent(user.id)}`,
        { method: "DELETE" },
      );
      setUsers((current) => current.filter((candidate) => candidate.id !== user.id));
      if (passwordTarget?.id === user.id) {
        setPasswordTarget(null);
        setReplacementPassword("");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete account");
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
        className="settings-modal settings-modal--accounts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-management-title"
      >
        <header>
          <div>
            <span>Administration</span>
            <h2 id="account-management-title">Account management</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close account management" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="admin-accounts">
          <form className="admin-account-create" onSubmit={createAccount}>
            <header>
              <div>
                <ShieldCheck size={15} />
                <span>
                  <strong>Create an account</strong>
                  <small>Public registration remains disabled.</small>
                </span>
              </div>
            </header>
            <div className="admin-account-create__fields">
              <label>
                <span>Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" maxLength={200} />
              </label>
              <label>
                <span>Email</span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" maxLength={254} />
              </label>
              <label>
                <span>Temporary password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                />
              </label>
              <label>
                <span>Role</span>
                <select value={role} onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}>
                  <option value="user">User</option>
                  <option value="admin">Administrator</option>
                </select>
              </label>
            </div>
            <button
              className="primary-button"
              type="submit"
              disabled={busy !== null || !email.trim() || !name.trim() || password.length < 12}
            >
              {busy === "create" ? <LoaderCircle className="auth-screen__spinner" size={14} /> : <Plus size={14} />}
              Create account
            </button>
          </form>

          <section className="admin-account-list" aria-label="Existing accounts">
            <header>
              <div>
                <UserRound size={15} />
                <span>
                  <strong>Existing accounts</strong>
                  <small>{users.length} {users.length === 1 ? "account" : "accounts"}</small>
                </span>
              </div>
              <button type="button" aria-label="Refresh accounts" disabled={loading || busy !== null} onClick={() => void loadUsers()}>
                <RefreshCw className={loading ? "auth-screen__spinner" : ""} size={13} />
              </button>
            </header>

            {loading ? (
              <div className="admin-account-empty"><LoaderCircle className="auth-screen__spinner" size={17} /> Loading accounts…</div>
            ) : users.length === 0 ? (
              <div className="admin-account-empty">No accounts found.</div>
            ) : (
              <div className="admin-account-list__rows">
                {users.map((user) => {
                  const ownAccount = user.id === currentUserId;
                  const userBusy = busy === user.id;
                  return (
                    <article className="admin-account-row" data-disabled={user.disabled || undefined} key={user.id}>
                      <div className="admin-account-row__identity">
                        <i>{user.disabled ? <UserX size={14} /> : <UserCheck size={14} />}</i>
                        <span>
                          <strong>{user.name}{ownAccount && <em>You</em>}</strong>
                          <small>{user.email}</small>
                        </span>
                      </div>
                      <div className="admin-account-row__status">
                        <span>{user.disabled ? "Disabled" : `${user.activeSessions} active ${user.activeSessions === 1 ? "session" : "sessions"}`}</span>
                        <small>Created {new Date(user.createdAt).toLocaleDateString()}</small>
                      </div>
                      <div className="admin-account-row__actions">
                        <label>
                          <span className="sr-only">Role for {user.email}</span>
                          <select
                            value={accountRole(user)}
                            disabled={ownAccount || userBusy || busy !== null}
                            onChange={(event) => void updateAccount(user, {
                              role: event.target.value === "admin" ? "admin" : "user",
                            })}
                          >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </select>
                        </label>
                        {!ownAccount && (
                          <>
                            <button
                              type="button"
                              disabled={userBusy || busy !== null}
                              onClick={() => void updateAccount(user, { disabled: !user.disabled })}
                            >
                              {user.disabled ? <UserCheck size={12} /> : <UserX size={12} />}
                              {user.disabled ? "Enable" : "Disable"}
                            </button>
                            <button
                              type="button"
                              disabled={userBusy || busy !== null}
                              onClick={() => {
                                setPasswordTarget(user);
                                setReplacementPassword("");
                              }}
                            >
                              <KeyRound size={12} /> Password
                            </button>
                            <button
                              className="admin-account-row__delete"
                              type="button"
                              aria-label={`Delete ${user.email}`}
                              disabled={userBusy || busy !== null}
                              onClick={() => void deleteAccount(user)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {passwordTarget && (
            <form className="admin-password-reset" onSubmit={resetPassword}>
              <div>
                <KeyRound size={14} />
                <span>
                  <strong>Reset password</strong>
                  <small>{passwordTarget.email} will be signed out everywhere.</small>
                </span>
              </div>
              <input
                type="password"
                aria-label={`New password for ${passwordTarget.email}`}
                placeholder="New password · 12 characters minimum"
                value={replacementPassword}
                onChange={(event) => setReplacementPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                autoFocus
              />
              <footer>
                <button
                  type="button"
                  onClick={() => {
                    setPasswordTarget(null);
                    setReplacementPassword("");
                  }}
                >
                  Cancel
                </button>
                <button className="primary-button" type="submit" disabled={busy !== null || replacementPassword.length < 12}>
                  Set password
                </button>
              </footer>
            </form>
          )}

          {error && <p className="admin-account-error" role="alert">{error}</p>}
        </div>

        <footer>
          <span>Only administrators can access this view.</span>
          <button className="primary-button" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
