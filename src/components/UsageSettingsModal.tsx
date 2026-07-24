import {
  CalendarDays,
  ChevronLeft,
  Coins,
  FileText,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface UsageTotals {
  costUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  generations: number;
  unpricedEvents: number;
}

interface MonthlyUsage extends UsageTotals {
  month: string;
}

interface CredentialUsage extends UsageTotals {
  credentialKind: string;
  credentialRef: string;
  credentialLabel: string;
  provider: string;
}

interface AccountUsage {
  selectedMonth: string;
  lifetime: UsageTotals;
  months: MonthlyUsage[];
  credentials: CredentialUsage[];
  pdf?: {
    available: boolean;
    period: string;
    usage: {
      monthly_page_cap: number | null;
      pages_processed: number;
      quota_pages: number;
      estimated_pages: number;
      reserved_pages: number;
      api_calls: number;
    } | null;
  };
}

function zeroTotals(): UsageTotals {
  return {
    costUsd: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    generations: 0,
    unpricedEvents: 0,
  };
}

function formatUsd(value: number): string {
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function credentialKindLabel(kind: string): string {
  return {
    personal: "Personal key",
    managed: "Administrator key",
    custom: "Custom provider key",
    "custom-endpoint": "Keyless endpoint",
    "historical-provider": "Historical usage",
  }[kind] ?? "Provider key";
}

export function UsageSettingsModal({
  onBack,
  onClose,
}: {
  onBack: () => void;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(
    () => new Date().toISOString().slice(0, 7),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadUsage = useCallback(async (month: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/usage?month=${encodeURIComponent(month)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const result = (await response.json().catch(() => ({}))) as AccountUsage & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "Could not load usage");
      setUsage(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage(selectedMonth);
  }, [loadUsage, selectedMonth]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const selectedTotals = useMemo(
    () => usage?.months.find((month) => month.month === selectedMonth) ?? zeroTotals(),
    [selectedMonth, usage],
  );

  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal settings-modal--usage"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-settings-title"
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
            <h2 id="usage-settings-title">Usage and spending</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close usage" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="usage-view">
          {error && (
            <div className="usage-view__error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void loadUsage(selectedMonth)}>
                <RefreshCw size={12} /> Retry
              </button>
            </div>
          )}

          <div className="usage-view__summary">
            <div>
              <Coins size={16} />
              <span>
                <small>All-time tracked spend</small>
                <strong>{formatUsd(usage?.lifetime.costUsd ?? 0)}</strong>
              </span>
            </div>
            <div>
              <KeyRound size={16} />
              <span>
                <small>All-time tokens</small>
                <strong>{formatTokens(usage?.lifetime.tokens ?? 0)}</strong>
              </span>
            </div>
          </div>

          <section className="usage-view__section">
            <header>
              <div>
                <CalendarDays size={14} />
                <span>
                  <strong>Monthly usage</strong>
                  <small>Calendar months are measured in UTC.</small>
                </span>
              </div>
              <input
                type="month"
                aria-label="Usage month"
                value={selectedMonth}
                onChange={(event) => {
                  if (event.target.value) setSelectedMonth(event.target.value);
                }}
              />
            </header>

            <div className="usage-view__month-total">
              <span>
                <small>{formatMonth(selectedMonth)}</small>
                <strong>{formatUsd(selectedTotals.costUsd)}</strong>
              </span>
              <span>
                <small>Tokens</small>
                <strong>{formatTokens(selectedTotals.tokens)}</strong>
              </span>
              <span>
                <small>Generations</small>
                <strong>{selectedTotals.generations.toLocaleString()}</strong>
              </span>
            </div>

            {usage && usage.months.length > 0 && (
              <div className="usage-view__months" aria-label="Months with tracked usage">
                {usage.months.map((month) => (
                  <button
                    type="button"
                    data-active={month.month === selectedMonth || undefined}
                    key={month.month}
                    onClick={() => setSelectedMonth(month.month)}
                  >
                    <span>{formatMonth(month.month)}</span>
                    <strong>{formatUsd(month.costUsd)}</strong>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="usage-view__section">
            <header>
              <div>
                <FileText size={14} />
                <span>
                  <strong>PDF OCR usage</strong>
                  <small>{formatMonth(selectedMonth)} · Mistral OCR</small>
                </span>
              </div>
            </header>
            {usage?.pdf?.available === false ? (
              <div className="usage-view__empty">PDF usage is temporarily unavailable.</div>
            ) : (
              <div className="usage-view__month-total">
                <span>
                  <small>Processed pages</small>
                  <strong>{(usage?.pdf?.usage?.pages_processed ?? 0).toLocaleString()}</strong>
                </span>
                <span>
                  <small>Imports</small>
                  <strong>{(usage?.pdf?.usage?.api_calls ?? 0).toLocaleString()}</strong>
                </span>
                <span>
                  <small>Monthly cap</small>
                  <strong>
                    {usage?.pdf?.usage?.monthly_page_cap === null ||
                    usage?.pdf?.usage?.monthly_page_cap === undefined
                      ? "Unlimited"
                      : usage.pdf.usage.monthly_page_cap.toLocaleString()}
                  </strong>
                </span>
              </div>
            )}
            {(usage?.pdf?.usage?.reserved_pages ?? 0) > 0 && (
              <p className="usage-view__note">
                {usage!.pdf!.usage!.reserved_pages.toLocaleString()} pages are currently
                reserved by queued or running imports.
              </p>
            )}
            {(usage?.pdf?.usage?.estimated_pages ?? 0) > 0 && (
              <p className="usage-view__note">
                {usage!.pdf!.usage!.estimated_pages.toLocaleString()} pages were conservatively
                counted after an interrupted or indeterminate upstream call.
              </p>
            )}
          </section>

          <section className="usage-view__section">
            <header>
              <div>
                <KeyRound size={14} />
                <span>
                  <strong>Spending by key</strong>
                  <small>{formatMonth(selectedMonth)}</small>
                </span>
              </div>
              {loading && <LoaderCircle className="auth-screen__spinner" size={15} />}
            </header>

            {!loading && usage?.credentials.length === 0 ? (
              <div className="usage-view__empty">No tracked model usage for this month.</div>
            ) : (
              <div className="usage-view__credentials">
                {usage?.credentials.map((credential) => (
                  <article key={`${credential.credentialRef}:${credential.provider}`}>
                    <div className="usage-view__credential-name">
                      <i><KeyRound size={13} /></i>
                      <span>
                        <strong>{credential.credentialLabel}</strong>
                        <small>
                          {credentialKindLabel(credential.credentialKind)}
                          {" · "}{credential.provider}
                        </small>
                      </span>
                    </div>
                    <div className="usage-view__credential-metrics">
                      <span>
                        <small>Spend</small>
                        <strong>{formatUsd(credential.costUsd)}</strong>
                      </span>
                      <span>
                        <small>Tokens</small>
                        <strong>{formatTokens(credential.tokens)}</strong>
                      </span>
                      <span>
                        <small>Calls</small>
                        <strong>{credential.generations.toLocaleString()}</strong>
                      </span>
                    </div>
                    {credential.unpricedEvents > 0 && (
                      <p>
                        {credential.unpricedEvents} {credential.unpricedEvents === 1 ? "call has" : "calls have"} token
                        usage but no price reported, so the spend total is incomplete.
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <p className="usage-view__note">
            Spend is based on provider-reported cost where available and Locus pricing
            estimates for supported models. Key labels and opaque identifiers are shown;
            API key secrets are never returned to this page.
          </p>
        </div>
      </section>
    </div>
  );
}
