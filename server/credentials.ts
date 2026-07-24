import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { ProviderId } from "../src/types.ts";
import { credentialEncryptionKeys, isHosted } from "./config.ts";
import { query, transaction } from "./db.ts";
import {
  clearProviderApiKey,
  getProviderStatus,
  getProviderStatuses,
  readProviderApiKey,
  saveProviderApiKey,
  type ProviderCredentialStatus,
  type ProviderStatuses,
  BUILT_IN_PROVIDER_IDS,
  type BuiltInProviderId,
} from "./providers.ts";

function hostedProvider(provider: ProviderId): provider is BuiltInProviderId {
  return (BUILT_IN_PROVIDER_IDS as readonly string[]).includes(provider);
}

function providerName(provider: BuiltInProviderId): string {
  return {
    openai: "OpenAI",
    openrouter: "OpenRouter",
    anthropic: "Claude",
    kimi: "Kimi",
    glm: "GLM",
    minimax: "MiniMax",
    deepseek: "DeepSeek",
    qwen: "Qwen",
  }[provider];
}
function keyAt(version: number): Buffer {
  const encoded = credentialEncryptionKeys[version];
  if (!encoded) throw new Error(`Credential encryption key version ${version} is unavailable`);
  return Buffer.from(encoded, "base64url");
}

export function encryptCredential(subject: string, provider: string, plaintext: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyAt(0), nonce);
  cipher.setAAD(Buffer.from(`${subject}:${provider}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 0 };
}

export function decryptCredential(
  subject: string,
  provider: string,
  row: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; keyVersion: number },
): string {
  const decipher = createDecipheriv("aes-256-gcm", keyAt(row.keyVersion), row.nonce);
  decipher.setAAD(Buffer.from(`${subject}:${provider}:v1`, "utf8"));
  decipher.setAuthTag(row.authTag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
}

export async function credentialStatuses(ownerUserId: string): Promise<ProviderStatuses> {
  if (!isHosted) return getProviderStatuses();
  const configured = await query<{ provider: string; source: "saved" | "managed" }>(
    `select "provider", 'saved'::text as "source"
       from "locus_provider_credentials"
      where "ownerUserId" = $1
     union all
     select a."provider", 'managed'::text as "source"
       from "locus_user_managed_credentials" a
       join "locus_managed_credentials" c on c."id" = a."managedCredentialId"
      where a."ownerUserId" = $1 and c."revokedAt" is null`,
    [ownerUserId],
  );
  const sources = new Map<string, "saved" | "managed">();
  for (const row of configured.rows) {
    if (!sources.has(row.provider) || row.source === "saved") sources.set(row.provider, row.source);
  }
  return Object.fromEntries(BUILT_IN_PROVIDER_IDS.map((provider) => [
    provider,
    { configured: sources.has(provider), required: true, source: sources.get(provider) ?? null },
  ])) as ProviderStatuses;
}

export async function credentialStatus(
  ownerUserId: string,
  provider: BuiltInProviderId,
): Promise<ProviderCredentialStatus> {
  if (!isHosted) return getProviderStatus(provider);
  return (await credentialStatuses(ownerUserId))[provider];
}

export async function saveCredential(
  ownerUserId: string,
  provider: BuiltInProviderId,
  raw: string,
): Promise<ProviderCredentialStatus> {
  if (!isHosted) return saveProviderApiKey(provider, raw);
  if (!hostedProvider(provider)) throw new Error("Choose a built-in provider");
  const secret = raw.trim();
  if (secret.length < 10 || secret.length > 5_000) throw new Error("Enter a valid API key");
  const encrypted = encryptCredential(ownerUserId, provider, secret);
  const credentialId = randomUUID();
  await query(
    `insert into "locus_provider_credentials"
       ("ownerUserId", "provider", "ciphertext", "nonce", "authTag", "keyVersion",
        "credentialId", "updatedAt")
     values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)
     on conflict ("ownerUserId", "provider") do update set
       "ciphertext" = excluded."ciphertext",
       "nonce" = excluded."nonce",
       "authTag" = excluded."authTag",
       "keyVersion" = excluded."keyVersion",
       "credentialId" = excluded."credentialId",
       "updatedAt" = current_timestamp`,
    [
      ownerUserId,
      provider,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      encrypted.keyVersion,
      credentialId,
    ],
  );
  return { configured: true, required: true, source: "saved" };
}

export async function clearCredential(
  ownerUserId: string,
  provider: BuiltInProviderId,
): Promise<ProviderCredentialStatus> {
  if (!isHosted) return clearProviderApiKey(provider);
  if (hostedProvider(provider)) {
    await query(
      `delete from "locus_provider_credentials" where "ownerUserId" = $1 and "provider" = $2`,
      [ownerUserId, provider],
    );
  }
  return credentialStatus(ownerUserId, provider);
}

export async function resolveCredential(
  ownerUserId: string,
  provider: BuiltInProviderId,
): Promise<string | null> {
  return (await resolveCredentialDetails(ownerUserId, provider))?.apiKey ?? null;
}

export interface ResolvedCredential {
  apiKey: string;
  source: "saved" | "managed";
  managedCredentialId?: string;
  credentialKind: "personal" | "managed";
  credentialRef: string;
  credentialLabel: string;
}

export async function resolveCredentialDetails(
  ownerUserId: string,
  provider: BuiltInProviderId,
): Promise<ResolvedCredential | null> {
  if (!isHosted) {
    const apiKey = await readProviderApiKey(provider);
    return apiKey
      ? {
          apiKey,
          source: "saved",
          credentialKind: "personal",
          credentialRef: `local:${provider}`,
          credentialLabel: `${providerName(provider)} key`,
        }
      : null;
  }
  const result = await query<{
    credentialId: string;
    ciphertext: Buffer;
    nonce: Buffer;
    authTag: Buffer;
    keyVersion: number;
  }>(
    `select "credentialId", "ciphertext", "nonce", "authTag", "keyVersion"
     from "locus_provider_credentials" where "ownerUserId" = $1 and "provider" = $2`,
    [ownerUserId, provider],
  );
  const row = result.rows[0];
  if (row) {
    return {
      apiKey: decryptCredential(ownerUserId, provider, row),
      source: "saved",
      credentialKind: "personal",
      credentialRef: `personal:${row.credentialId}`,
      credentialLabel: `${providerName(provider)} personal key`,
    };
  }

  const managed = await query<{
    id: string;
    label: string;
    ciphertext: Buffer;
    nonce: Buffer;
    authTag: Buffer;
    keyVersion: number;
  }>(
    `select c."id", c."label", c."ciphertext", c."nonce", c."authTag", c."keyVersion"
       from "locus_user_managed_credentials" a
       join "locus_managed_credentials" c on c."id" = a."managedCredentialId"
      where a."ownerUserId" = $1 and a."provider" = $2 and c."revokedAt" is null`,
    [ownerUserId, provider],
  );
  const managedRow = managed.rows[0];
  return managedRow
    ? {
        apiKey: decryptCredential(`managed:${managedRow.id}`, provider, managedRow),
        source: "managed",
        managedCredentialId: managedRow.id,
        credentialKind: "managed",
        credentialRef: `managed:${managedRow.id}`,
        credentialLabel: managedRow.label,
      }
    : null;
}

export interface ManagedCredentialSummary {
  id: string;
  provider: BuiltInProviderId;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
  assignedUsers: number;
  pendingInvites: number;
  monthlyLimitUsd: number | null;
  monthlyCostUsd: number;
  lifetimeCostUsd: number;
  monthlyTokens: number;
  unpricedEvents: number;
}

export async function listManagedCredentials(): Promise<ManagedCredentialSummary[]> {
  const result = await query<ManagedCredentialSummary>(
    `select c."id", c."provider", c."label", c."createdAt", c."revokedAt",
            c."monthlyLimitUsd"::double precision as "monthlyLimitUsd",
            coalesce(a."assignedUsers", 0)::int as "assignedUsers",
            coalesce(i."pendingInvites", 0)::int as "pendingInvites",
            coalesce(u."monthlyCostUsd", 0)::double precision as "monthlyCostUsd",
            coalesce(u."lifetimeCostUsd", 0)::double precision as "lifetimeCostUsd",
            coalesce(u."monthlyTokens", 0)::double precision as "monthlyTokens",
            coalesce(u."unpricedEvents", 0)::int as "unpricedEvents"
       from "locus_managed_credentials" c
       left join lateral (
         select count(distinct "ownerUserId")::int as "assignedUsers"
           from "locus_user_managed_credentials"
          where "managedCredentialId" = c."id"
       ) a on true
       left join lateral (
         select count(*)::int as "pendingInvites"
           from "locus_invites"
          where "managedCredentialId" = c."id"
            and "usedAt" is null and "revokedAt" is null
            and ("expiresAt" is null or "expiresAt" > current_timestamp)
       ) i on true
       left join lateral (
         select
           sum("totalCostUsd") filter (
             where "createdAt" >=
               (date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC')
           ) as "monthlyCostUsd",
           sum("totalCostUsd") as "lifetimeCostUsd",
           sum("totalTokens") filter (
             where "createdAt" >=
               (date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC')
           ) as "monthlyTokens",
           count(*) filter (
             where "totalCostUsd" is null and "totalTokens" is not null
               and "createdAt" >=
                 (date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC')
           )::int as "unpricedEvents"
           from "locus_usage_events"
          where "managedCredentialId" = c."id"
       ) u on true
      order by c."createdAt" desc`,
  );
  return result.rows;
}

export async function createManagedCredential(input: {
  provider: BuiltInProviderId;
  label: string;
  apiKey: string;
  monthlyLimitUsd?: number | null;
  administratorUserId: string;
}): Promise<ManagedCredentialSummary> {
  if (!hostedProvider(input.provider)) throw new Error("Choose a built-in provider");
  const label = input.label.trim();
  const secret = input.apiKey.trim();
  const monthlyLimitUsd = input.monthlyLimitUsd ?? null;
  if (!label || label.length > 120) throw new Error("Enter a key label of at most 120 characters");
  if (secret.length < 10 || secret.length > 5_000) throw new Error("Enter a valid API key");
  if (
    monthlyLimitUsd !== null &&
    (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0 || monthlyLimitUsd > 10_000_000)
  ) {
    throw new Error("The monthly managed-key limit must be between $0 and $10,000,000");
  }
  const id = randomUUID();
  const encrypted = encryptCredential(`managed:${id}`, input.provider, secret);
  await query(
    `insert into "locus_managed_credentials"
       ("id", "provider", "label", "ciphertext", "nonce", "authTag", "keyVersion",
        "monthlyLimitUsd", "createdByUserId")
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.provider,
      label,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      encrypted.keyVersion,
      monthlyLimitUsd,
      input.administratorUserId,
    ],
  );
  const created = (await listManagedCredentials()).find((credential) => credential.id === id);
  if (!created) throw new Error("The managed key was created but could not be loaded");
  return created;
}

export async function updateManagedCredentialLimit(
  id: string,
  monthlyLimitUsd: number | null,
): Promise<ManagedCredentialSummary | null> {
  if (
    monthlyLimitUsd !== null &&
    (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0 || monthlyLimitUsd > 10_000_000)
  ) {
    throw new Error("The monthly managed-key limit must be between $0 and $10,000,000");
  }
  const result = await query(
    `update "locus_managed_credentials"
        set "monthlyLimitUsd" = $2
      where "id" = $1 and "revokedAt" is null`,
    [id, monthlyLimitUsd],
  );
  if (!result.rowCount) return null;
  return (await listManagedCredentials()).find((credential) => credential.id === id) ?? null;
}

export async function revokeManagedCredential(
  id: string,
  administratorUserId: string,
): Promise<string[] | null> {
  return transaction(async (client) => {
    const result = await client.query(
      `update "locus_managed_credentials"
          set "revokedAt" = current_timestamp, "revokedByUserId" = $2
        where "id" = $1 and "revokedAt" is null`,
      [id, administratorUserId],
    );
    if (!result.rowCount) return null;
    const assigned = await client.query<{ ownerUserId: string }>(
      `select "ownerUserId" from "locus_user_managed_credentials" where "managedCredentialId" = $1`,
      [id],
    );
    return assigned.rows.map((row) => row.ownerUserId);
  });
}
