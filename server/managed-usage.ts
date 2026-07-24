import { query, transaction } from "./db.ts";
import { hasGenerationPricing } from "./pricing.ts";

const MONTH_START_SQL =
  "(date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC')";

export class ManagedUsageLimitError extends Error {
  constructor(
    message: string,
    public readonly status: 402 | 409,
    public readonly code:
      | "ACCOUNT_MONTHLY_LIMIT_REACHED"
      | "KEY_MONTHLY_LIMIT_REACHED"
      | "MANAGED_USAGE_PENDING"
      | "MANAGED_COST_UNAVAILABLE",
  ) {
    super(message);
  }
}

export interface ManagedUsageAuthorization {
  reserved: boolean;
  accountMonthlyCostUsd: number;
  accountMonthlyLimitUsd: number | null;
  keyMonthlyCostUsd: number;
  keyMonthlyLimitUsd: number | null;
}

function dollars(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

export async function authorizeManagedGeneration(input: {
  ownerUserId: string;
  generationId: string;
  managedCredentialId: string;
  provider: string;
  model: string;
}): Promise<ManagedUsageAuthorization> {
  return transaction(async (client) => {
    const lockNames = [
      `managed-account:${input.ownerUserId}`,
      `managed-key:${input.managedCredentialId}`,
    ].sort();
    for (const lockName of lockNames) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockName]);
    }

    await client.query(
      `delete from "locus_managed_usage_reservations"
        where "expiresAt" <= current_timestamp`,
    );

    const assignment = await client.query<{
      keyMonthlyLimitUsd: number | null;
      accountMonthlyLimitUsd: number | null;
    }>(
      `select c."monthlyLimitUsd"::double precision as "keyMonthlyLimitUsd",
              l."monthlyLimitUsd"::double precision as "accountMonthlyLimitUsd"
         from "locus_user_managed_credentials" a
         join "locus_managed_credentials" c
           on c."id" = a."managedCredentialId" and c."revokedAt" is null
         left join "locus_managed_account_limits" l
           on l."ownerUserId" = a."ownerUserId"
        where a."ownerUserId" = $1 and a."managedCredentialId" = $2
        for update of c`,
      [input.ownerUserId, input.managedCredentialId],
    );
    const limits = assignment.rows[0];
    if (!limits) {
      throw new ManagedUsageLimitError(
        "The administrator-managed API key is no longer assigned to this account",
        409,
        "MANAGED_USAGE_PENDING",
      );
    }

    const accountUsage = await client.query<{ costUsd: number; unpricedEvents: number }>(
      `select coalesce(sum("totalCostUsd"), 0)::double precision as "costUsd",
              count(*) filter (
                where "totalCostUsd" is null and "totalTokens" is not null
              )::int as "unpricedEvents"
         from "locus_usage_events"
        where "ownerUserId" = $1
          and "managedCredentialId" is not null
          and "createdAt" >= ${MONTH_START_SQL}`,
      [input.ownerUserId],
    );
    const keyUsage = await client.query<{ costUsd: number; unpricedEvents: number }>(
      `select coalesce(sum("totalCostUsd"), 0)::double precision as "costUsd",
              count(*) filter (
                where "totalCostUsd" is null and "totalTokens" is not null
              )::int as "unpricedEvents"
         from "locus_usage_events"
        where "managedCredentialId" = $1
          and "createdAt" >= ${MONTH_START_SQL}`,
      [input.managedCredentialId],
    );
    const accountMonthlyCostUsd = accountUsage.rows[0]?.costUsd ?? 0;
    const keyMonthlyCostUsd = keyUsage.rows[0]?.costUsd ?? 0;
    const finiteAccountBudget = limits.accountMonthlyLimitUsd !== null;
    const finiteKeyBudget = limits.keyMonthlyLimitUsd !== null;

    if (
      (finiteAccountBudget || finiteKeyBudget) &&
      !hasGenerationPricing(input.provider, input.model)
    ) {
      throw new ManagedUsageLimitError(
        `A USD budget is active, but Locus cannot reliably price ${input.provider}/${input.model}. Use a priced model or remove the managed budget.`,
        409,
        "MANAGED_COST_UNAVAILABLE",
      );
    }
    if (
      (finiteAccountBudget && (accountUsage.rows[0]?.unpricedEvents ?? 0) > 0) ||
      (finiteKeyBudget && (keyUsage.rows[0]?.unpricedEvents ?? 0) > 0)
    ) {
      throw new ManagedUsageLimitError(
        "This managed budget has unpriced usage in the current UTC month, so its remaining USD balance cannot be verified. Remove the limit or wait for the monthly reset.",
        409,
        "MANAGED_COST_UNAVAILABLE",
      );
    }

    if (
      limits.accountMonthlyLimitUsd !== null &&
      accountMonthlyCostUsd >= limits.accountMonthlyLimitUsd
    ) {
      throw new ManagedUsageLimitError(
        `This account has reached its ${dollars(limits.accountMonthlyLimitUsd)} managed API budget for the current UTC month`,
        402,
        "ACCOUNT_MONTHLY_LIMIT_REACHED",
      );
    }
    if (
      limits.keyMonthlyLimitUsd !== null &&
      keyMonthlyCostUsd >= limits.keyMonthlyLimitUsd
    ) {
      throw new ManagedUsageLimitError(
        `The administrator-managed API key has reached its ${dollars(limits.keyMonthlyLimitUsd)} budget for the current UTC month`,
        402,
        "KEY_MONTHLY_LIMIT_REACHED",
      );
    }

    if (finiteAccountBudget || finiteKeyBudget) {
      const pending = await client.query<{ accountPending: boolean; keyPending: boolean }>(
        `select
           exists(
             select 1 from "locus_managed_usage_reservations"
              where "ownerUserId" = $1 and "expiresAt" > current_timestamp
           ) as "accountPending",
           exists(
             select 1 from "locus_managed_usage_reservations"
              where "managedCredentialId" = $2 and "expiresAt" > current_timestamp
           ) as "keyPending"`,
        [input.ownerUserId, input.managedCredentialId],
      );
      if (
        (finiteAccountBudget && pending.rows[0]?.accountPending) ||
        (finiteKeyBudget && pending.rows[0]?.keyPending)
      ) {
        throw new ManagedUsageLimitError(
          "Another response using this managed budget is still being counted. Wait for it to finish before starting another.",
          409,
          "MANAGED_USAGE_PENDING",
        );
      }
      await client.query(
        `insert into "locus_managed_usage_reservations"
           ("ownerUserId", "generationId", "managedCredentialId")
         values ($1, $2, $3)`,
        [input.ownerUserId, input.generationId, input.managedCredentialId],
      );
    }

    return {
      reserved: finiteAccountBudget || finiteKeyBudget,
      accountMonthlyCostUsd,
      accountMonthlyLimitUsd: limits.accountMonthlyLimitUsd,
      keyMonthlyCostUsd,
      keyMonthlyLimitUsd: limits.keyMonthlyLimitUsd,
    };
  });
}

export async function releaseManagedGeneration(
  ownerUserId: string,
  generationId: string,
): Promise<void> {
  await query(
    `delete from "locus_managed_usage_reservations"
      where "ownerUserId" = $1 and "generationId" = $2`,
    [ownerUserId, generationId],
  );
}

export async function clearManagedUsageReservations(): Promise<void> {
  await query(`delete from "locus_managed_usage_reservations"`);
}
