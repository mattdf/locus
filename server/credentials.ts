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
  await query(
    `insert into "locus_provider_credentials"
       ("ownerUserId", "provider", "ciphertext", "nonce", "authTag", "keyVersion", "updatedAt")
     values ($1, $2, $3, $4, $5, $6, current_timestamp)
     on conflict ("ownerUserId", "provider") do update set
       "ciphertext" = excluded."ciphertext",
       "nonce" = excluded."nonce",
       "authTag" = excluded."authTag",
       "keyVersion" = excluded."keyVersion",
       "updatedAt" = current_timestamp`,
    [ownerUserId, provider, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
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
  if (!isHosted) return readProviderApiKey(provider);
  const result = await query<{
    ciphertext: Buffer;
    nonce: Buffer;
    authTag: Buffer;
    keyVersion: number;
  }>(
    `select "ciphertext", "nonce", "authTag", "keyVersion"
     from "locus_provider_credentials" where "ownerUserId" = $1 and "provider" = $2`,
    [ownerUserId, provider],
  );
  const row = result.rows[0];
  if (row) return decryptCredential(ownerUserId, provider, row);

  const managed = await query<{
    id: string;
    ciphertext: Buffer;
    nonce: Buffer;
    authTag: Buffer;
    keyVersion: number;
  }>(
    `select c."id", c."ciphertext", c."nonce", c."authTag", c."keyVersion"
       from "locus_user_managed_credentials" a
       join "locus_managed_credentials" c on c."id" = a."managedCredentialId"
      where a."ownerUserId" = $1 and a."provider" = $2 and c."revokedAt" is null`,
    [ownerUserId, provider],
  );
  const managedRow = managed.rows[0];
  return managedRow ? decryptCredential(`managed:${managedRow.id}`, provider, managedRow) : null;
}

export interface ManagedCredentialSummary {
  id: string;
  provider: BuiltInProviderId;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
  assignedUsers: number;
  pendingInvites: number;
}

export async function listManagedCredentials(): Promise<ManagedCredentialSummary[]> {
  const result = await query<ManagedCredentialSummary>(
    `select c."id", c."provider", c."label", c."createdAt", c."revokedAt",
            count(distinct a."ownerUserId")::int as "assignedUsers",
            count(distinct i."id") filter (
              where i."usedAt" is null and i."revokedAt" is null
                and (i."expiresAt" is null or i."expiresAt" > current_timestamp)
            )::int as "pendingInvites"
       from "locus_managed_credentials" c
       left join "locus_user_managed_credentials" a on a."managedCredentialId" = c."id"
       left join "locus_invites" i on i."managedCredentialId" = c."id"
      group by c."id"
      order by c."createdAt" desc`,
  );
  return result.rows;
}

export async function createManagedCredential(input: {
  provider: BuiltInProviderId;
  label: string;
  apiKey: string;
  administratorUserId: string;
}): Promise<ManagedCredentialSummary> {
  if (!hostedProvider(input.provider)) throw new Error("Choose a built-in provider");
  const label = input.label.trim();
  const secret = input.apiKey.trim();
  if (!label || label.length > 120) throw new Error("Enter a key label of at most 120 characters");
  if (secret.length < 10 || secret.length > 5_000) throw new Error("Enter a valid API key");
  const id = randomUUID();
  const encrypted = encryptCredential(`managed:${id}`, input.provider, secret);
  await query(
    `insert into "locus_managed_credentials"
       ("id", "provider", "label", "ciphertext", "nonce", "authTag", "keyVersion", "createdByUserId")
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.provider,
      label,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      encrypted.keyVersion,
      input.administratorUserId,
    ],
  );
  const created = (await listManagedCredentials()).find((credential) => credential.id === id);
  if (!created) throw new Error("The managed key was created but could not be loaded");
  return created;
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
