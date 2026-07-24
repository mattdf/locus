import {
  Ban,
  Check,
  Clipboard,
  DollarSign,
  KeyRound,
  Link2,
  LoaderCircle,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";
import type { ProviderKind } from "../types";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminRequest } from "../lib/admin";

interface AccessPolicy {
  publicSignupEnabled: boolean;
  signupMode: "public" | "waitlist";
}

interface ManagedCredential {
  id: string;
  provider: Exclude<ProviderKind, "custom">;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  assignedUsers: number;
  pendingInvites: number;
  monthlyLimitUsd: number | null;
  monthlyCostUsd: number;
  lifetimeCostUsd: number;
  monthlyTokens: number;
  unpricedEvents: number;
}

interface InviteSummary {
  id: string;
  email: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  usedAt: string | null;
  usedByEmail: string | null;
  managedCredentialId: string | null;
  managedCredentialLabel: string | null;
  managedProvider: string | null;
  managedCredentialRevokedAt: string | null;
  accountMonthlyLimitUsd: number | null;
}

interface WaitlistEntry {
  id: string;
  email: string;
  name: string;
  status: "waiting" | "invited" | "registered";
  createdAt: string;
}

interface AccessResponse {
  policy: AccessPolicy;
  invites: InviteSummary[];
  managedCredentials: ManagedCredential[];
  waitlist: WaitlistEntry[];
}

function inviteStatus(invite: InviteSummary): string {
  if (invite.usedAt) return `Used${invite.usedByEmail ? ` by ${invite.usedByEmail}` : ""}`;
  if (invite.revokedAt) return "Revoked";
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) return "Expired";
  return "Active";
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString();
}

export function AdminAccessPanel() {
  const [data, setData] = useState<AccessResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keyProvider, setKeyProvider] = useState<Exclude<ProviderKind, "custom">>("openai");
  const [apiKey, setApiKey] = useState("");
  const [keyMonthlyLimit, setKeyMonthlyLimit] = useState("");
  const [keyLimitTarget, setKeyLimitTarget] = useState<ManagedCredential | null>(null);
  const [keyLimitDraft, setKeyLimitDraft] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("7");
  const [inviteCredentialId, setInviteCredentialId] = useState("");
  const [inviteAccountLimit, setInviteAccountLimit] = useState("");
  const [createdInviteUrl, setCreatedInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      setData(await adminRequest<AccessResponse>("/api/admin/access"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load access settings");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleSignup = async () => {
    if (!data) return;
    setBusy("policy");
    setError("");
    try {
      const result = await adminRequest<{ policy: AccessPolicy }>("/api/admin/access/settings", {
        method: "PATCH",
        body: JSON.stringify({ publicSignupEnabled: !data.policy.publicSignupEnabled }),
      });
      setData((current) => current ? { ...current, policy: result.policy } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change signup mode");
    } finally {
      setBusy(null);
    }
  };

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!keyLabel.trim() || !apiKey.trim()) return;
    const monthlyLimitUsd = keyMonthlyLimit.trim() === "" ? null : Number(keyMonthlyLimit);
    if (
      monthlyLimitUsd !== null &&
      (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0 || monthlyLimitUsd > 10_000_000)
    ) {
      setError("Enter a monthly key limit between $0 and $10,000,000, or leave it blank for unlimited.");
      return;
    }
    setBusy("create-key");
    setError("");
    try {
      const result = await adminRequest<{ credential: ManagedCredential }>(
        "/api/admin/access/managed-credentials",
        {
          method: "POST",
          body: JSON.stringify({
            label: keyLabel.trim(),
            provider: keyProvider,
            apiKey,
            monthlyLimitUsd,
          }),
        },
      );
      setData((current) => current
        ? { ...current, managedCredentials: [result.credential, ...current.managedCredentials] }
        : current);
      setKeyLabel("");
      setApiKey("");
      setKeyMonthlyLimit("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the managed key");
    } finally {
      setBusy(null);
    }
  };

  const saveKeyLimit = async () => {
    if (!keyLimitTarget) return;
    const monthlyLimitUsd = keyLimitDraft.trim() === "" ? null : Number(keyLimitDraft);
    if (
      monthlyLimitUsd !== null &&
      (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0 || monthlyLimitUsd > 10_000_000)
    ) {
      setError("Enter a monthly key limit between $0 and $10,000,000, or leave it blank for unlimited.");
      return;
    }
    setBusy(`key-limit:${keyLimitTarget.id}`);
    setError("");
    try {
      const result = await adminRequest<{ credential: ManagedCredential }>(
        `/api/admin/access/managed-credentials/${encodeURIComponent(keyLimitTarget.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ monthlyLimitUsd }),
        },
      );
      setData((current) => current
        ? {
            ...current,
            managedCredentials: current.managedCredentials.map((credential) =>
              credential.id === result.credential.id ? result.credential : credential),
          }
        : current);
      setKeyLimitTarget(null);
      setKeyLimitDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the key budget");
    } finally {
      setBusy(null);
    }
  };

  const revokeKey = async (credential: ManagedCredential) => {
    if (!window.confirm(`Revoke “${credential.label}”? Accounts using it will immediately lose that API access.`)) return;
    setBusy(`key:${credential.id}`);
    setError("");
    try {
      await adminRequest<Record<string, never>>(
        `/api/admin/access/managed-credentials/${encodeURIComponent(credential.id)}`,
        { method: "DELETE" },
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not revoke the managed key");
      setBusy(null);
    }
  };

  const createInvite = async (event: FormEvent) => {
    event.preventDefault();
    const accountMonthlyLimitUsd = inviteCredentialId && inviteAccountLimit.trim() !== ""
      ? Number(inviteAccountLimit)
      : null;
    if (
      accountMonthlyLimitUsd !== null &&
      (
        !Number.isFinite(accountMonthlyLimitUsd) ||
        accountMonthlyLimitUsd < 0 ||
        accountMonthlyLimitUsd > 10_000_000
      )
    ) {
      setError("Enter an invited-account limit between $0 and $10,000,000, or leave it blank for unlimited.");
      return;
    }
    setBusy("create-invite");
    setError("");
    setCreatedInviteUrl("");
    try {
      const result = await adminRequest<{ invite: InviteSummary; url: string }>("/api/admin/access/invites", {
        method: "POST",
        body: JSON.stringify({
          email: inviteEmail.trim() || undefined,
          expiresInDays: inviteExpiry === "never" ? null : Number(inviteExpiry),
          managedCredentialId: inviteCredentialId || null,
          accountMonthlyLimitUsd,
        }),
      });
      setData((current) => current
        ? { ...current, invites: [result.invite, ...current.invites] }
        : current);
      setCreatedInviteUrl(result.url);
      setInviteEmail("");
      setInviteAccountLimit("");
      setCopied(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the invite");
    } finally {
      setBusy(null);
    }
  };

  const revokeInvite = async (invite: InviteSummary) => {
    setBusy(`invite:${invite.id}`);
    setError("");
    try {
      await adminRequest<Record<string, never>>(
        `/api/admin/access/invites/${encodeURIComponent(invite.id)}`,
        { method: "DELETE" },
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not revoke the invite");
      setBusy(null);
    }
  };

  const removeWaitlist = async (entry: WaitlistEntry) => {
    setBusy(`waitlist:${entry.id}`);
    setError("");
    try {
      await adminRequest<Record<string, never>>(
        `/api/admin/access/waitlist/${encodeURIComponent(entry.id)}`,
        { method: "DELETE" },
      );
      setData((current) => current
        ? { ...current, waitlist: current.waitlist.filter((candidate) => candidate.id !== entry.id) }
        : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the waitlist entry");
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="admin-account-empty">
        <LoaderCircle className="auth-screen__spinner" size={17} />
        {error || "Loading access settings…"}
      </div>
    );
  }

  const activeCredentials = data.managedCredentials.filter((credential) => !credential.revokedAt);
  return (
    <div className="admin-access">
      <section className="admin-access__section admin-access__policy">
        <header>
          <span><ShieldCheck size={15} /><strong>Public access</strong></span>
          <button
            className="admin-access__toggle"
            type="button"
            aria-pressed={data.policy.publicSignupEnabled}
            disabled={busy !== null}
            onClick={() => void toggleSignup()}
          >
            {data.policy.publicSignupEnabled ? <Check size={13} /> : <Ban size={13} />}
            {data.policy.publicSignupEnabled ? "Public signup on" : "Waitlist mode"}
          </button>
        </header>
        <p>
          {data.policy.publicSignupEnabled
            ? "Anyone can create an account after email verification. Invite links continue to work."
            : "Public account creation is blocked. Visitors can join the waitlist, while invite links continue to work."}
        </p>
      </section>

      <form className="admin-access__section admin-access__form" onSubmit={createKey}>
        <header><span><KeyRound size={15} /><strong>Managed API keys</strong></span></header>
        <p>
          Keys remain encrypted on the server and are never returned to users. USD budgets reset
          at the start of each UTC month and block new managed-key calls once reached. Costs are
          provider-reported where available and estimated for supported OpenAI models; unpriced
          calls are flagged explicitly and finite budgets fail closed when cost cannot be verified.
          The response that crosses a limit is allowed to finish, then later calls are blocked.
        </p>
        <div className="admin-access__fields admin-access__fields--key">
          <input placeholder="Key label" maxLength={120} value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)} />
          <select value={keyProvider} onChange={(event) => setKeyProvider(event.target.value as Exclude<ProviderKind, "custom">)}>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Claude</option>
            <option value="kimi">Kimi</option>
            <option value="glm">GLM</option>
            <option value="minimax">MiniMax</option>
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">Qwen</option>
          </select>
          <input type="password" placeholder="API key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          <input
            type="number"
            min={0}
            max={10_000_000}
            step="0.01"
            inputMode="decimal"
            placeholder="Monthly USD · unlimited"
            aria-label="Monthly managed-key limit in USD"
            value={keyMonthlyLimit}
            onChange={(event) => setKeyMonthlyLimit(event.target.value)}
          />
          <button className="primary-button" type="submit" disabled={busy !== null || !keyLabel.trim() || !apiKey.trim()}>
            {busy === "create-key" ? <LoaderCircle className="auth-screen__spinner" size={13} /> : <Plus size={13} />} Save key
          </button>
        </div>
        <div className="admin-access__rows">
          {data.managedCredentials.length === 0 ? <small>No managed keys.</small> : data.managedCredentials.map((credential) => (
            <article key={credential.id} data-disabled={credential.revokedAt ? true : undefined}>
              <span>
                <strong>{credential.label}</strong>
                <small>{credential.provider} · {credential.assignedUsers} users · {credential.pendingInvites} pending invites</small>
                <small>
                  {formatUsd(credential.monthlyCostUsd)}
                  {credential.monthlyLimitUsd === null
                    ? " this month"
                    : ` of ${formatUsd(credential.monthlyLimitUsd)} this month`}
                  {" · "}{formatTokens(credential.monthlyTokens)} tokens
                  {credential.unpricedEvents > 0
                    ? ` · ${credential.unpricedEvents} unpriced`
                    : ""}
                  {" · "}{formatUsd(credential.lifetimeCostUsd)} tracked lifetime
                </small>
              </span>
              <span>{credential.revokedAt ? "Revoked" : new Date(credential.createdAt).toLocaleDateString()}</span>
              {!credential.revokedAt && (
                <div>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      setKeyLimitTarget(credential);
                      setKeyLimitDraft(
                        credential.monthlyLimitUsd === null
                          ? ""
                          : String(credential.monthlyLimitUsd),
                      );
                    }}
                  >
                    <DollarSign size={12} /> Budget
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void revokeKey(credential)}><Ban size={12} /> Revoke</button>
                </div>
              )}
            </article>
          ))}
        </div>
        {keyLimitTarget && (
          <div className="admin-budget-editor admin-budget-editor--key">
            <div>
              <DollarSign size={14} />
              <span>
                <strong>Managed key budget</strong>
                <small>
                  {keyLimitTarget.label} has used {formatUsd(keyLimitTarget.monthlyCostUsd)}
                  {" "}and {formatTokens(keyLimitTarget.monthlyTokens)} tokens this UTC month.
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
                aria-label={`Monthly limit for ${keyLimitTarget.label}`}
                placeholder="Unlimited"
                value={keyLimitDraft}
                onChange={(event) => setKeyLimitDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveKeyLimit();
                  }
                }}
                autoFocus
              />
            </label>
            <footer>
              <button
                type="button"
                onClick={() => {
                  setKeyLimitTarget(null);
                  setKeyLimitDraft("");
                }}
              >
                Cancel
              </button>
              <button className="primary-button" type="button" disabled={busy !== null} onClick={() => void saveKeyLimit()}>
                Save budget
              </button>
            </footer>
          </div>
        )}
      </form>

      <form className="admin-access__section admin-access__form" onSubmit={createInvite}>
        <header><span><Link2 size={15} /><strong>Invite links</strong></span></header>
        <p>Each link creates one immediately verified account. Raw invite tokens are shown once and stored only as hashes.</p>
        <div className="admin-access__fields admin-access__fields--invite">
          <input type="email" placeholder="Restrict to email · optional" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
          <select value={inviteExpiry} onChange={(event) => setInviteExpiry(event.target.value)}>
            <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="never">No expiry</option>
          </select>
          <select value={inviteCredentialId} onChange={(event) => setInviteCredentialId(event.target.value)}>
            <option value="">Require BYOK</option>
            {activeCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label} · {credential.provider}</option>)}
          </select>
          <input
            type="number"
            min={0}
            max={10_000_000}
            step="0.01"
            inputMode="decimal"
            placeholder="Account USD · unlimited"
            aria-label="Invited account monthly managed API limit in USD"
            disabled={!inviteCredentialId}
            value={inviteAccountLimit}
            onChange={(event) => setInviteAccountLimit(event.target.value)}
          />
          <button className="primary-button" type="submit" disabled={busy !== null}>
            {busy === "create-invite" ? <LoaderCircle className="auth-screen__spinner" size={13} /> : <UserPlus size={13} />} Create invite
          </button>
        </div>
        {createdInviteUrl && (
          <div className="admin-access__created-link">
            <input readOnly value={createdInviteUrl} aria-label="New invite URL" />
            <button type="button" onClick={() => void navigator.clipboard.writeText(createdInviteUrl)
              .then(() => setCopied(true))
              .catch(() => setError("Could not copy the invite link"))}>
              {copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <div className="admin-access__rows">
          {data.invites.length === 0 ? <small>No invites.</small> : data.invites.map((invite) => {
            const status = inviteStatus(invite);
            return (
              <article key={invite.id} data-disabled={status !== "Active" ? true : undefined}>
                <span>
                  <strong>{invite.email || "Any email"}</strong>
                  <small>
                    {invite.managedCredentialLabel
                      ? `${invite.managedCredentialLabel} · ${invite.managedProvider}${invite.managedCredentialRevokedAt ? " · key revoked" : ""}`
                      : "BYOK"}
                    {invite.accountMonthlyLimitUsd !== null
                      ? ` · account cap ${formatUsd(invite.accountMonthlyLimitUsd)}/month`
                      : ""}
                    {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleDateString()}` : " · no expiry"}
                  </small>
                </span>
                <span>{status}</span>
                {status === "Active" && <button type="button" disabled={busy !== null} onClick={() => void revokeInvite(invite)}><Ban size={12} /> Revoke</button>}
              </article>
            );
          })}
        </div>
      </form>

      <section className="admin-access__section">
        <header>
          <span><Mail size={15} /><strong>Waitlist</strong></span>
          <button type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={12} /> Refresh</button>
        </header>
        <div className="admin-access__rows">
          {data.waitlist.length === 0 ? <small>No waitlist entries.</small> : data.waitlist.map((entry) => (
            <article key={entry.id}>
              <span><strong>{entry.name}</strong><small>{entry.email} · joined {new Date(entry.createdAt).toLocaleDateString()}</small></span>
              <span>{entry.status}</span>
              <div>
                {entry.status !== "registered" && (
                  <button type="button" onClick={() => { setInviteEmail(entry.email); setCreatedInviteUrl(""); }}><UserPlus size={12} /> Prepare invite</button>
                )}
                <button type="button" aria-label={`Remove ${entry.email} from waitlist`} disabled={busy !== null} onClick={() => void removeWaitlist(entry)}><Trash2 size={12} /></button>
              </div>
            </article>
          ))}
        </div>
      </section>
      {error && <p className="admin-account-error" role="alert">{error}</p>}
    </div>
  );
}
