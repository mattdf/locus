import { query } from "./db.ts";

export interface UsageTotals {
  costUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  generations: number;
  unpricedEvents: number;
}

export interface MonthlyUsage extends UsageTotals {
  month: string;
}

export interface CredentialUsage extends UsageTotals {
  credentialKind: string;
  credentialRef: string;
  credentialLabel: string;
  provider: string;
}

export interface AccountUsage {
  selectedMonth: string;
  lifetime: UsageTotals;
  months: MonthlyUsage[];
  credentials: CredentialUsage[];
}

function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function normalizedMonth(value?: string): string {
  const month = value?.trim() || currentUtcMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Choose a valid month in YYYY-MM format");
  }
  return month;
}

const TOTAL_COLUMNS = `
  coalesce(sum("totalCostUsd"), 0)::double precision as "costUsd",
  coalesce(sum("totalTokens"), 0)::double precision as "tokens",
  coalesce(sum("inputTokens"), 0)::double precision as "inputTokens",
  coalesce(sum("outputTokens"), 0)::double precision as "outputTokens",
  coalesce(sum("reasoningTokens"), 0)::double precision as "reasoningTokens",
  count(*)::int as "generations",
  count(*) filter (
    where "totalCostUsd" is null and "totalTokens" is not null
  )::int as "unpricedEvents"
`;

export async function accountUsage(
  ownerUserId: string,
  requestedMonth?: string,
): Promise<AccountUsage> {
  const selectedMonth = normalizedMonth(requestedMonth);
  const [lifetime, months, credentials] = await Promise.all([
    query<UsageTotals>(
      `select ${TOTAL_COLUMNS}
         from "locus_usage_events"
        where "ownerUserId" = $1`,
      [ownerUserId],
    ),
    query<MonthlyUsage>(
      `select to_char(
                date_trunc('month', "createdAt" at time zone 'UTC'),
                'YYYY-MM'
              ) as "month",
              ${TOTAL_COLUMNS}
         from "locus_usage_events"
        where "ownerUserId" = $1
        group by date_trunc('month', "createdAt" at time zone 'UTC')
        order by date_trunc('month', "createdAt" at time zone 'UTC') desc`,
      [ownerUserId],
    ),
    query<CredentialUsage>(
      `select "credentialKind", "credentialRef",
              (array_agg("credentialLabel" order by "createdAt" desc))[1] as "credentialLabel",
              "provider",
              ${TOTAL_COLUMNS}
         from "locus_usage_events"
        where "ownerUserId" = $1
          and "createdAt" >= (($2 || '-01')::date at time zone 'UTC')
          and "createdAt" < (
            (($2 || '-01')::date + interval '1 month') at time zone 'UTC'
          )
        group by "credentialKind", "credentialRef", "provider"
        order by coalesce(sum("totalCostUsd"), 0) desc,
                 (array_agg("credentialLabel" order by "createdAt" desc))[1] asc`,
      [ownerUserId, selectedMonth],
    ),
  ]);
  return {
    selectedMonth,
    lifetime: lifetime.rows[0] ?? {
      costUsd: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      generations: 0,
      unpricedEvents: 0,
    },
    months: months.rows,
    credentials: credentials.rows,
  };
}
