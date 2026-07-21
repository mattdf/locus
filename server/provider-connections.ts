import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderConnectionSummary, ProviderKind } from "../src/types.ts";
import { LEGACY_CUSTOM_PROVIDER_ID, PROVIDER_OPTIONS } from "../src/lib/providers.ts";
import { isHosted } from "./config.ts";
import { query } from "./db.ts";
import {
  credentialStatuses,
  decryptCredential,
  encryptCredential,
  resolveCredential,
} from "./credentials.ts";
import {
  BUILT_IN_PROVIDER_IDS,
  readProviderApiKey,
  type BuiltInProviderId,
} from "./providers.ts";
import { assertSafeProviderBaseUrl, normalizeProviderBaseUrl } from "./provider-url.ts";

const DATA_DIR = path.resolve(process.env.DATA_DIR?.trim() || "data");
const CUSTOM_FILE = path.join(DATA_DIR, "custom-providers.json");
const CUSTOM_KEY_DIR = path.join(DATA_DIR, "custom-provider-keys");

interface LocalCustomProvider {
  id: string;
  label: string;
  baseUrl: string;
  createdAt: string;
}

interface StoredCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface ResolvedProviderConnection {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  apiKey?: string;
}

function validCustomId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function readLocalCustomProviders(): Promise<LocalCustomProvider[]> {
  try {
    const parsed = JSON.parse(await readFile(CUSTOM_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => validCustomId(item?.id)) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function ensureLegacyCustomProvider(providers: LocalCustomProvider[]): Promise<LocalCustomProvider[]> {
  if (providers.some((provider) => provider.id === LEGACY_CUSTOM_PROVIDER_ID)) return providers;
  try {
    const raw = JSON.parse(await readFile(path.join(DATA_DIR, "chats.json"), "utf8"));
    if (raw?.settings?.provider !== "local" && raw?.settings?.provider !== "custom") return providers;
    const provider = {
      id: LEGACY_CUSTOM_PROVIDER_ID,
      label: "Custom OpenAI Compatible",
      baseUrl: normalizeProviderBaseUrl(raw.settings.localBaseUrl || "http://127.0.0.1:1234/v1"),
      createdAt: new Date().toISOString(),
    };
    const next = [...providers, provider];
    await writeLocalCustomProviders(next);
    try {
      const legacyKey = (await readFile(path.join(DATA_DIR, "local-api-key.txt"), "utf8")).trim();
      if (legacyKey) await writeLocalCustomKey(provider.id, legacyKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return providers;
    throw error;
  }
}

async function writeLocalCustomProviders(providers: LocalCustomProvider[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CUSTOM_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(providers, null, 2)}\n`, "utf8");
  await rename(temporary, CUSTOM_FILE);
}

async function readLocalCustomKey(id: string): Promise<string | null> {
  try {
    return (await readFile(path.join(CUSTOM_KEY_DIR, `${id}.txt`), "utf8")).trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeLocalCustomKey(id: string, apiKey: string | null): Promise<void> {
  const file = path.join(CUSTOM_KEY_DIR, `${id}.txt`);
  if (!apiKey) {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  await mkdir(CUSTOM_KEY_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function customSummary(
  provider: Pick<LocalCustomProvider, "id" | "label" | "baseUrl">,
  configured: boolean,
): ProviderConnectionSummary {
  return {
    id: provider.id,
    kind: "custom",
    label: provider.label,
    note: "Custom OpenAI Compatible",
    baseUrl: provider.baseUrl,
    configured,
    required: false,
    source: configured ? "saved" : null,
    removable: true,
  };
}

export async function listProviderConnections(ownerUserId: string): Promise<ProviderConnectionSummary[]> {
  const statuses = await credentialStatuses(ownerUserId);
  const builtIns = BUILT_IN_PROVIDER_IDS.map((id) => {
    const option = PROVIDER_OPTIONS.find((candidate) => candidate.id === id)!;
    return {
      id,
      kind: id,
      label: option.label,
      note: option.note,
      baseUrl: null,
      removable: false,
      ...statuses[id],
    } satisfies ProviderConnectionSummary;
  });
  if (!isHosted) {
    const customs = await ensureLegacyCustomProvider(await readLocalCustomProviders());
    const summaries = await Promise.all(
      customs.map(async (provider) =>
        customSummary(provider, Boolean(await readLocalCustomKey(provider.id)))),
    );
    return [...builtIns, ...summaries];
  }
  const result = await query<{
    id: string; label: string; baseUrl: string; ciphertext: Buffer | null;
  }>(
    `select "id", "label", "baseUrl", "ciphertext"
       from "locus_custom_providers" where "ownerUserId" = $1 order by "createdAt" asc`,
    [ownerUserId],
  );
  return [...builtIns, ...result.rows.map((provider) => customSummary(provider, Boolean(provider.ciphertext)))];
}

export async function createCustomProvider(input: {
  ownerUserId: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<ProviderConnectionSummary> {
  const label = input.label.trim();
  if (!label || label.length > 120) throw new Error("Enter a provider name of at most 120 characters");
  const baseUrl = await assertSafeProviderBaseUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim() || null;
  if (apiKey && apiKey.length > 5_000) throw new Error("The API key is too long");
  const id = randomUUID();
  if (!isHosted) {
    const providers = await ensureLegacyCustomProvider(await readLocalCustomProviders());
    providers.push({ id, label, baseUrl, createdAt: new Date().toISOString() });
    await writeLocalCustomProviders(providers);
    await writeLocalCustomKey(id, apiKey);
    return customSummary({ id, label, baseUrl }, Boolean(apiKey));
  }
  const encrypted = apiKey ? encryptCredential(input.ownerUserId, `custom:${id}`, apiKey) : null;
  await query(
    `insert into "locus_custom_providers"
       ("ownerUserId", "id", "label", "baseUrl", "ciphertext", "nonce", "authTag", "keyVersion")
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.ownerUserId, id, label, baseUrl, encrypted?.ciphertext ?? null, encrypted?.nonce ?? null, encrypted?.authTag ?? null, encrypted?.keyVersion ?? null],
  );
  return customSummary({ id, label, baseUrl }, Boolean(apiKey));
}

export async function updateCustomProvider(input: {
  ownerUserId: string;
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string | null;
}): Promise<ProviderConnectionSummary | null> {
  if (!validCustomId(input.id)) return null;
  const label = input.label.trim();
  if (!label || label.length > 120) throw new Error("Enter a provider name of at most 120 characters");
  const baseUrl = await assertSafeProviderBaseUrl(input.baseUrl);
  if (!isHosted) {
    const providers = await ensureLegacyCustomProvider(await readLocalCustomProviders());
    const provider = providers.find((candidate) => candidate.id === input.id);
    if (!provider) return null;
    provider.label = label;
    provider.baseUrl = baseUrl;
    await writeLocalCustomProviders(providers);
    if (input.apiKey !== undefined) await writeLocalCustomKey(input.id, input.apiKey?.trim() || null);
    return customSummary(provider, Boolean(await readLocalCustomKey(input.id)));
  }
  let encrypted: ReturnType<typeof encryptCredential> | null | undefined;
  if (input.apiKey !== undefined) {
    const secret = input.apiKey?.trim() || null;
    if (secret && secret.length > 5_000) throw new Error("The API key is too long");
    encrypted = secret ? encryptCredential(input.ownerUserId, `custom:${input.id}`, secret) : null;
  }
  const result = await query<{ ciphertext: Buffer | null }>(
    `update "locus_custom_providers" set "label" = $3, "baseUrl" = $4,
       "ciphertext" = case when $5::boolean then $6 else "ciphertext" end,
       "nonce" = case when $5::boolean then $7 else "nonce" end,
       "authTag" = case when $5::boolean then $8 else "authTag" end,
       "keyVersion" = case when $5::boolean then $9 else "keyVersion" end,
       "updatedAt" = current_timestamp
     where "ownerUserId" = $1 and "id" = $2 returning "ciphertext"`,
    [input.ownerUserId, input.id, label, baseUrl, input.apiKey !== undefined, encrypted?.ciphertext ?? null, encrypted?.nonce ?? null, encrypted?.authTag ?? null, encrypted?.keyVersion ?? null],
  );
  return result.rows[0] ? customSummary({ id: input.id, label, baseUrl }, Boolean(result.rows[0].ciphertext)) : null;
}

export async function deleteCustomProvider(ownerUserId: string, id: string): Promise<boolean> {
  if (!validCustomId(id)) return false;
  if (!isHosted) {
    const providers = await ensureLegacyCustomProvider(await readLocalCustomProviders());
    const next = providers.filter((provider) => provider.id !== id);
    if (next.length === providers.length) return false;
    await writeLocalCustomProviders(next);
    await writeLocalCustomKey(id, null);
    return true;
  }
  const result = await query(`delete from "locus_custom_providers" where "ownerUserId" = $1 and "id" = $2`, [ownerUserId, id]);
  return Boolean(result.rowCount);
}

export async function resolveProviderConnection(ownerUserId: string, id: string): Promise<ResolvedProviderConnection | null> {
  if ((BUILT_IN_PROVIDER_IDS as readonly string[]).includes(id)) {
    const provider = id as BuiltInProviderId;
    const apiKey = isHosted ? await resolveCredential(ownerUserId, provider) : await readProviderApiKey(provider);
    const option = PROVIDER_OPTIONS.find((candidate) => candidate.id === provider)!;
    return { id, kind: provider, label: option.label, ...(apiKey ? { apiKey } : {}) };
  }
  if (!validCustomId(id)) return null;
  if (!isHosted) {
    const provider = (await ensureLegacyCustomProvider(await readLocalCustomProviders())).find((candidate) => candidate.id === id);
    if (!provider) return null;
    return { id, kind: "custom", label: provider.label, baseUrl: normalizeProviderBaseUrl(provider.baseUrl), apiKey: (await readLocalCustomKey(id)) ?? undefined };
  }
  const result = await query<LocalCustomProvider & StoredCredential & { ciphertext: Buffer | null; nonce: Buffer | null; authTag: Buffer | null; keyVersion: number | null }>(
    `select "id", "label", "baseUrl", "ciphertext", "nonce", "authTag", "keyVersion"
       from "locus_custom_providers" where "ownerUserId" = $1 and "id" = $2`,
    [ownerUserId, id],
  );
  const provider = result.rows[0];
  if (!provider) return null;
  const baseUrl = await assertSafeProviderBaseUrl(provider.baseUrl);
  const apiKey = provider.ciphertext && provider.nonce && provider.authTag && provider.keyVersion !== null
    ? decryptCredential(ownerUserId, `custom:${id}`, provider as StoredCredential)
    : undefined;
  return { id, kind: "custom", label: provider.label, baseUrl, apiKey };
}
