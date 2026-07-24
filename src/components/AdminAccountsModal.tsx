import {
  ChevronLeft,
  DollarSign,
  KeyRound,
  Link2,
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
import { adminRequest } from "../lib/admin";
import { AdminAccessPanel } from "./AdminAccessPanel";

interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  disabled: boolean;
  createdAt: string;
  activeSessions: number;
  managedCredentialCount: number;
  managedMonthlyLimitUsd: number | null;
  managedMonthlyCostUsd: number;
  managedLifetimeCostUsd: number;
  managedMonthlyTokens: number;
  managedUnpricedEvents: number;
  monthlyCostUsd: number;
  lifetimeCostUsd: number;
  monthlyTokens: number;
  unpricedEvents: number;
}

interface UsersResponse {
  users: ManagedUser[];
}

interface UserResponse {
  user: ManagedUser;
}

function accountRole(user: ManagedUser): "admin" | "user" {
  return user.role?.split(",").includes("admin") ? "admin" : "user";
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString();
}

export function AdminAccountsModal({
  currentUserId,
  onBack,
  onClose,
}: {
  currentUserId: string;
  onBack: () => void;
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
  const [limitTarget, setLimitTarget] = useState<ManagedUser | null>(null);
  const [monthlyLimitDraft, setMonthlyLimitDraft] = useState("");
  const [activeTab, setActiveTab] = useState<"accounts" | "access">("accounts");

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
    changes: {
      disabled?: boolean;
      role?: "admin" | "user";
      managedMonthlyLimitUsd?: number | null;
    },
  ): Promise<boolean> => {
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
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update account");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveAccountLimit = async (event: FormEvent) => {
    event.preventDefault();
    if (!limitTarget) return;
    const monthlyLimitUsd = monthlyLimitDraft.trim() === ""
      ? null
      : Number(monthlyLimitDraft);
    if (
      monthlyLimitUsd !== null &&
      (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0 || monthlyLimitUsd > 10_000_000)
    ) {
      setError("Enter a monthly limit between $0 and $10,000,000, or leave it blank for unlimited.");
      return;
    }
    if (await updateAccount(limitTarget, { managedMonthlyLimitUsd: monthlyLimitUsd })) {
      setLimitTarget(null);
      setMonthlyLimitDraft("");
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
      if (limitTarget?.id === user.id) {
        setLimitTarget(null);
        setMonthlyLimitDraft("");
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
            <span>Administration</span>
            <h2 id="account-management-title">Administration</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close account management" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <nav className="admin-tabs" aria-label="Administration sections">
          <button type="button" aria-current={activeTab === "accounts" ? "page" : undefined} onClick={() => setActiveTab("accounts")}>
            <UserRound size={14} /> Accounts
          </button>
          <button type="button" aria-current={activeTab === "access" ? "page" : undefined} onClick={() => setActiveTab("access")}>
            <Link2 size={14} /> Access and invites
          </button>
        </nav>

        {activeTab === "accounts" ? <div className="admin-accounts">
          <form className="admin-account-create" onSubmit={createAccount}>
            <header>
              <div>
                <ShieldCheck size={15} />
                <span>
                  <strong>Create an account</strong>
                  <small>Administrator-created accounts are trusted immediately.</small>
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
                        <span>{user.disabled ? "Suspended" : `${user.activeSessions} active ${user.activeSessions === 1 ? "session" : "sessions"}`}</span>
                        {(user.monthlyCostUsd > 0 ||
                          user.lifetimeCostUsd > 0 ||
                          user.monthlyTokens > 0 ||
                          user.unpricedEvents > 0) && (
                          <small className="admin-managed-usage">
                            API spend · {formatUsd(user.monthlyCostUsd)} this month
                            {" · "}{formatTokens(user.monthlyTokens)} tokens
                            {user.unpricedEvents > 0
                              ? ` · ${user.unpricedEvents} unpriced`
                              : ""}
                            {" · "}{formatUsd(user.lifetimeCostUsd)} tracked total
                          </small>
                        )}
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
                        {(user.managedCredentialCount > 0 ||
                          user.managedLifetimeCostUsd > 0 ||
                          user.managedMonthlyLimitUsd !== null) && (
                          <button
                            type="button"
                            disabled={userBusy || busy !== null}
                            onClick={() => {
                              setLimitTarget(user);
                              setMonthlyLimitDraft(
                                user.managedMonthlyLimitUsd === null
                                  ? ""
                                  : String(user.managedMonthlyLimitUsd),
                              );
                              setPasswordTarget(null);
                              setReplacementPassword("");
                            }}
                          >
                            <DollarSign size={12} /> Budget
                          </button>
                        )}
                        {!ownAccount && (
                          <>
                            <button
                              type="button"
                              disabled={userBusy || busy !== null}
                              onClick={() => void updateAccount(user, { disabled: !user.disabled })}
                            >
                              {user.disabled ? <UserCheck size={12} /> : <UserX size={12} />}
                              {user.disabled ? "Restore" : "Suspend"}
                            </button>
                            <button
                              type="button"
                              disabled={userBusy || busy !== null}
                              onClick={() => {
                                setPasswordTarget(user);
                                setReplacementPassword("");
                                setLimitTarget(null);
                                setMonthlyLimitDraft("");
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

          {limitTarget && (
            <form className="admin-budget-editor" onSubmit={saveAccountLimit}>
              <div>
                <DollarSign size={14} />
                <span>
                  <strong>Managed API account budget</strong>
                  <small>
                    {limitTarget.email} has used {formatUsd(limitTarget.managedMonthlyCostUsd)}
                    {" "}and {formatTokens(limitTarget.managedMonthlyTokens)} tokens this UTC month.
                    The limit applies only to administrator-managed keys.
                  </small>
                </span>
              </div>
              <label>
                <span>Monthly limit (USD)</span>
                <input
                  type="number"
                  min={0}
                  max={10_000_000}
                  step="0.01"
                  inputMode="decimal"
                  aria-label={`Monthly managed API limit for ${limitTarget.email}`}
                  placeholder="Unlimited"
                  value={monthlyLimitDraft}
                  onChange={(event) => setMonthlyLimitDraft(event.target.value)}
                  autoFocus
                />
              </label>
              <footer>
                <button
                  type="button"
                  onClick={() => {
                    setLimitTarget(null);
                    setMonthlyLimitDraft("");
                  }}
                >
                  Cancel
                </button>
                <button className="primary-button" type="submit" disabled={busy !== null}>
                  Save budget
                </button>
              </footer>
            </form>
          )}

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
        </div> : <AdminAccessPanel />}

        <footer>
          <span>Only administrators can access this view.</span>
          <button className="primary-button" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
