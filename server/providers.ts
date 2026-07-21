import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { ProviderId, ProviderKind, ProviderModelOption } from "../src/types.ts";
import { isHosted } from "./config.ts";
import { guardedProviderFetch, normalizeProviderBaseUrl } from "./provider-url.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const PROVIDER_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  openrouter: OPENROUTER_BASE_URL,
  anthropic: "https://api.anthropic.com/v1",
  kimi: "https://api.moonshot.ai/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  minimax: "https://api.minimax.io/v1",
};

export const BUILT_IN_PROVIDER_IDS = [
  "openai", "openrouter", "anthropic", "kimi", "glm", "minimax",
] as const satisfies ReadonlyArray<Exclude<ProviderId, "custom">>;
export type BuiltInProviderId = (typeof BUILT_IN_PROVIDER_IDS)[number];

const PROVIDER_KEYS: Record<
  BuiltInProviderId,
  { savedFile: string; projectFile: string; assignment: string; required: boolean }
> = {
  openai: {
    savedFile: path.resolve("data", "openai-api-key.txt"),
    projectFile: path.resolve("OPENAI_API_KEY.txt"),
    assignment: "OPENAI_API_KEY",
    required: true,
  },
  openrouter: {
    savedFile: path.resolve("data", "openrouter-api-key.txt"),
    projectFile: path.resolve("OPENROUTER_API_KEY.txt"),
    assignment: "OPENROUTER_API_KEY",
    required: true,
  },
  anthropic: {
    savedFile: path.resolve("data", "anthropic-api-key.txt"),
    projectFile: path.resolve("ANTHROPIC_API_KEY.txt"),
    assignment: "ANTHROPIC_API_KEY",
    required: true,
  },
  kimi: {
    savedFile: path.resolve("data", "kimi-api-key.txt"),
    projectFile: path.resolve("KIMI_API_KEY.txt"),
    assignment: "KIMI_API_KEY",
    required: true,
  },
  glm: {
    savedFile: path.resolve("data", "glm-api-key.txt"),
    projectFile: path.resolve("GLM_API_KEY.txt"),
    assignment: "GLM_API_KEY",
    required: true,
  },
  minimax: {
    savedFile: path.resolve("data", "minimax-api-key.txt"),
    projectFile: path.resolve("MINIMAX_API_KEY.txt"),
    assignment: "MINIMAX_API_KEY",
    required: true,
  },
};

export interface ProviderCredentialStatus {
  configured: boolean;
  required: boolean;
  source: "saved" | "project-file" | "managed" | null;
}

export type ProviderStatuses = Record<BuiltInProviderId, ProviderCredentialStatus>;

function normalizeApiKey(raw: string, assignment: string): string {
  const value = raw.trim();
  const match = value.match(new RegExp(`^${assignment}\\s*=\\s*([\\s\\S]+)$`));
  return (match?.[1] ?? value).trim().replace(/^['"]|['"]$/g, "");
}

async function readKeyFile(file: string, assignment: string): Promise<string | null> {
  try {
    return normalizeApiKey(await readFile(file, "utf8"), assignment) || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readProviderApiKey(provider: BuiltInProviderId): Promise<string | null> {
  const config = PROVIDER_KEYS[provider];
  return (
    (await readKeyFile(config.savedFile, config.assignment)) ??
    (await readKeyFile(config.projectFile, config.assignment))
  );
}

export async function getProviderStatus(
  provider: BuiltInProviderId,
): Promise<ProviderCredentialStatus> {
  const config = PROVIDER_KEYS[provider];
  if (await readKeyFile(config.savedFile, config.assignment)) {
    return { configured: true, required: config.required, source: "saved" };
  }
  if (await readKeyFile(config.projectFile, config.assignment)) {
    return { configured: true, required: config.required, source: "project-file" };
  }
  return { configured: false, required: config.required, source: null };
}

export async function getProviderStatuses(): Promise<ProviderStatuses> {
  const entries = await Promise.all(
    BUILT_IN_PROVIDER_IDS.map(async (provider) => [provider, await getProviderStatus(provider)] as const),
  );
  return Object.fromEntries(entries) as ProviderStatuses;
}

export async function saveProviderApiKey(
  provider: BuiltInProviderId,
  raw: string,
): Promise<ProviderCredentialStatus> {
  const config = PROVIDER_KEYS[provider];
  const apiKey = normalizeApiKey(raw, config.assignment);
  const minimumLength = 10;
  if (apiKey.length < minimumLength) {
    const label = provider;
    throw new Error(`Enter a valid ${label} API key.`);
  }

  await mkdir(path.dirname(config.savedFile), { recursive: true });
  const temporaryFile = `${config.savedFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryFile, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, config.savedFile);
  return { configured: true, required: config.required, source: "saved" };
}

export async function clearProviderApiKey(
  provider: BuiltInProviderId,
): Promise<ProviderCredentialStatus> {
  try {
    await unlink(PROVIDER_KEYS[provider].savedFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return getProviderStatus(provider);
}

export const normalizeLocalBaseUrl = normalizeProviderBaseUrl;

export async function createProviderClient(
  provider: ProviderKind,
  baseUrl?: string,
  credential?: string,
): Promise<OpenAI> {
  const builtIn = provider !== "custom" ? provider as BuiltInProviderId : null;
  const savedKey = credential ?? (!isHosted && builtIn ? await readProviderApiKey(builtIn) : null);
  if (!savedKey && provider !== "custom") {
    throw new Error(`No ${provider} API key is configured. Add one in Providers.`);
  }
  const resolvedBaseUrl = provider === "custom"
    ? normalizeProviderBaseUrl(baseUrl ?? "")
    : PROVIDER_BASE_URLS[provider];
  return new OpenAI({
    apiKey: savedKey ?? "no-key",
    ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
    ...(provider === "openrouter"
      ? {
          defaultHeaders: { "X-OpenRouter-Title": "Locus" },
        }
      : {}),
    ...(provider === "custom" && isHosted ? { fetch: guardedProviderFetch() } : {}),
  });
}

export async function listProviderModels(
  provider: Exclude<ProviderKind, "openai">,
  baseUrl?: string,
  credential?: string,
): Promise<ProviderModelOption[]> {
  if (provider === "openrouter") {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`);
    if (!response.ok) throw new Error(`OpenRouter model catalog returned ${response.status}`);
    const payload = (await response.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
    };
    return (payload.data ?? [])
      .filter((model): model is { id: string; name?: string } => typeof model.id === "string")
      .map((model) => ({
        id: model.id,
        name: typeof model.name === "string" ? model.name : undefined,
      }));
  }

  const client = await createProviderClient(provider, baseUrl, credential);
  const page = await client.models.list();
  return page.data.map((model) => ({ id: model.id }));
}
