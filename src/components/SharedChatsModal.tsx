import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { InlineMath } from "./MathText";

export interface SharedChatSummary {
  id: string;
  sourceChatId: string | null;
  title: string;
  path: string;
  createdAt: string;
}

interface SharesResponse {
  shares: SharedChatSummary[];
}

function shareUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

async function shareRequest<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(pathname, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Share request failed (${response.status})`);
  return result as T;
}

async function copyLink(path: string): Promise<void> {
  await navigator.clipboard.writeText(shareUrl(path));
}

export function ShareCreatedModal({
  share,
  onClose,
}: {
  share: SharedChatSummary;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal settings-modal--compact share-created-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-created-title"
      >
        <header>
          <div>
            <span>Immutable snapshot</span>
            <h2 id="share-created-title">Public link created</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close share link" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <p>
          Anyone with this link can read this saved snapshot without signing in. Later changes to
          your original chat will not change it.
        </p>
        <label className="share-link-field">
          <span>Public read-only link</span>
          <div>
            <input readOnly value={shareUrl(share.path)} onFocus={(event) => event.currentTarget.select()} />
            <button
              type="button"
              onClick={() => {
                void copyLink(share.path).then(() => setCopied(true));
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </label>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>Done</button>
          <a className="primary-button" href={share.path} target="_blank" rel="noreferrer">
            Open snapshot <ExternalLink size={14} />
          </a>
        </footer>
      </section>
    </div>
  );
}

export function SharedChatsModal({ onClose }: { onClose: () => void }) {
  const [shares, setShares] = useState<SharedChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await shareRequest<SharesResponse>("/api/shares");
      setShares(result.shares);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load shared chats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (share: SharedChatSummary) => {
    if (!window.confirm(`Revoke the public link for “${share.title}”?`)) return;
    setBusy(share.id);
    setError("");
    try {
      await shareRequest<Record<string, never>>(`/api/shares/${encodeURIComponent(share.id)}`, {
        method: "DELETE",
      });
      setShares((current) => current.filter((candidate) => candidate.id !== share.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not revoke this link");
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
        className="settings-modal settings-modal--shared"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shared-chats-title"
      >
        <header>
          <div>
            <span>Public snapshots</span>
            <h2 id="shared-chats-title">Shared chats</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close shared chats" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="shared-chats">
          <div className="shared-chats__intro">
            <p>Shared links are frozen, read-only copies. Revoking a link deletes only its public copy.</p>
            <button type="button" aria-label="Refresh shared chats" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
          {error && <p className="shared-chats__error" role="alert">{error}</p>}
          {loading ? (
            <div className="shared-chats__empty"><LoaderCircle className="spin" size={18} /> Loading shared chats…</div>
          ) : shares.length === 0 ? (
            <div className="shared-chats__empty"><Link2 size={20} /> You have not shared any chats.</div>
          ) : (
            <div className="shared-chats__list">
              {shares.map((share) => (
                <article key={share.id}>
                  <div>
                    <strong><InlineMath source={share.title} /></strong>
                    <small>{new Date(share.createdAt).toLocaleString()}</small>
                    <code>{shareUrl(share.path)}</code>
                  </div>
                  <nav aria-label={`Actions for ${share.title}`}>
                    <button
                      type="button"
                      onClick={() => {
                        void copyLink(share.path).then(() => {
                          setCopied(share.id);
                          window.setTimeout(() => setCopied(null), 1500);
                        });
                      }}
                    >
                      {copied === share.id ? <Check size={13} /> : <Copy size={13} />}
                      {copied === share.id ? "Copied" : "Copy link"}
                    </button>
                    <a href={share.path} target="_blank" rel="noreferrer">
                      <ExternalLink size={13} /> Open
                    </a>
                    <button
                      className="shared-chats__revoke"
                      type="button"
                      disabled={busy === share.id}
                      onClick={() => void revoke(share)}
                    >
                      {busy === share.id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                      Revoke
                    </button>
                  </nav>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

