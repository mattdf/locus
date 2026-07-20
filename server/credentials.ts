import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ProviderId } from "../src/types.ts";
import { credentialEncryptionKeys, isHosted } from "./config.ts";
import { query } from "./db.ts";
import {
  clearProviderApiKey,
  getProviderStatus,
  getProviderStatuses,
  readProviderApiKey,
  saveProviderApiKey,
  type ProviderCredentialStatus,
  type ProviderStatuses,
} from "./providers.ts";

function hostedProvider(provider: ProviderId): provider is Exclude<ProviderId, "local"> {
  return provider === "openai" || provider === "openrouter";
}
function keyAt(version: number): Buffer {
  const encoded = credentialEncryptionKeys[version];
  if (!encoded) throw new Error(`Credential encryption key version ${version} is unavailable`);
  return Buffer.from(encoded, "base64url");
}

function encrypt(ownerUserId: string, provider: string, plaintext: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyAt(0), nonce);
  cipher.setAAD(Buffer.from(`${ownerUserId}:${provider}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 0 };
}

function decrypt(
  ownerUserId: string,
  provider: string,
  row: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; keyVersion: number },
): string {
  const decipher = createDecipheriv("aes-256-gcm", keyAt(row.keyVersion), row.nonce);
  decipher.setAAD(Buffer.from(`${ownerUserId}:${provider}:v1`, "utf8"));
  decipher.setAuthTag(row.authTag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
}

export async function credentialStatuses(ownerUserId: string): Promise<ProviderStatuses> {
  if (!isHosted) return getProviderStatuses();
  const configured = await query<{ provider: string }>(
    `select "provider" from "locus_provider_credentials" where "ownerUserId" = $1`,
    [ownerUserId],
  );
  const providers = new Set(configured.rows.map((row) => row.provider));
  return {
    openai: { configured: providers.has("openai"), required: true, source: providers.has("openai") ? "saved" : null },
    openrouter: { configured: providers.has("openrouter"), required: true, source: providers.has("openrouter") ? "saved" : null },
    local: { configured: false, required: false, source: null },
  };
}

export async function credentialStatus(
  ownerUserId: string,
  provider: ProviderId,
): Promise<ProviderCredentialStatus> {
  if (!isHosted) return getProviderStatus(provider);
  return (await credentialStatuses(ownerUserId))[provider];
}

export async function saveCredential(
  ownerUserId: string,
  provider: ProviderId,
  raw: string,
): Promise<ProviderCredentialStatus> {
  if (!isHosted) return saveProviderApiKey(provider, raw);
  if (!hostedProvider(provider)) throw new Error("Local endpoints are unavailable in hosted mode");
  const secret = raw.trim();
  if (secret.length < 10 || secret.length > 5_000) throw new Error("Enter a valid API key");
  const encrypted = encrypt(ownerUserId, provider, secret);
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
  provider: ProviderId,
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
  provider: ProviderId,
): Promise<string | null> {
  if (!isHosted) return readProviderApiKey(provider);
  if (!hostedProvider(provider)) return null;
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
  return row ? decrypt(ownerUserId, provider, row) : null;
}
