import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { ProviderId, ProviderModelOption } from "../src/types.ts";
import { isHosted } from "./config.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const PROVIDER_KEYS: Record<
  ProviderId,
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
  local: {
    savedFile: path.resolve("data", "local-api-key.txt"),
    projectFile: path.resolve("LOCAL_API_KEY.txt"),
    assignment: "LOCAL_API_KEY",
    required: false,
  },
};

export interface ProviderCredentialStatus {
  configured: boolean;
  required: boolean;
  source: "saved" | "project-file" | null;
}

export type ProviderStatuses = Record<ProviderId, ProviderCredentialStatus>;

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

export async function readProviderApiKey(provider: ProviderId): Promise<string | null> {
  const config = PROVIDER_KEYS[provider];
  return (
    (await readKeyFile(config.savedFile, config.assignment)) ??
    (await readKeyFile(config.projectFile, config.assignment))
  );
}

export async function getProviderStatus(
  provider: ProviderId,
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
  const [openai, openrouter, local] = await Promise.all([
    getProviderStatus("openai"),
    getProviderStatus("openrouter"),
    getProviderStatus("local"),
  ]);
  return { openai, openrouter, local };
}

export async function saveProviderApiKey(
  provider: ProviderId,
  raw: string,
): Promise<ProviderCredentialStatus> {
  const config = PROVIDER_KEYS[provider];
  const apiKey = normalizeApiKey(raw, config.assignment);
  const minimumLength = provider === "local" ? 1 : 10;
  if (apiKey.length < minimumLength) {
    const label =
      provider === "openrouter" ? "OpenRouter" : provider === "local" ? "local" : "OpenAI";
    throw new Error(`Enter a valid ${label} API key.`);
  }

  await mkdir(path.dirname(config.savedFile), { recursive: true });
  const temporaryFile = `${config.savedFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryFile, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, config.savedFile);
  return { configured: true, required: config.required, source: "saved" };
}

export async function clearProviderApiKey(
  provider: ProviderId,
): Promise<ProviderCredentialStatus> {
  try {
    await unlink(PROVIDER_KEYS[provider].savedFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return getProviderStatus(provider);
}

export function normalizeLocalBaseUrl(raw: string): string {
  if (raw.length > 2_000) throw new Error("The local endpoint URL is too long");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a valid local endpoint URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The local endpoint must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new Error("Put endpoint credentials in the API key field, not the URL");
  }
  return url.toString().replace(/\/$/, "");
}

export async function createProviderClient(
  provider: ProviderId,
  localBaseUrl?: string,
  credential?: string,
): Promise<OpenAI> {
  const savedKey = credential ?? (isHosted ? null : await readProviderApiKey(provider));
  if (!savedKey && provider !== "local") {
    const label = provider === "openrouter" ? "OpenRouter" : "OpenAI";
    const projectFile = provider === "openrouter" ? "OPENROUTER_API_KEY.txt" : "OPENAI_API_KEY.txt";
    throw new Error(`No ${label} API key is configured. Add one in Settings or ${projectFile}.`);
  }

  return new OpenAI({
    apiKey: savedKey ?? "local",
    ...(provider === "openrouter"
      ? {
          baseURL: OPENROUTER_BASE_URL,
          defaultHeaders: { "X-OpenRouter-Title": "Locus" },
        }
      : provider === "local"
        ? { baseURL: normalizeLocalBaseUrl(localBaseUrl ?? "") }
        : {}),
  });
}

export async function listProviderModels(
  provider: Exclude<ProviderId, "openai">,
  localBaseUrl?: string,
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

  const client = await createProviderClient("local", localBaseUrl);
  const page = await client.models.list();
  return page.data.map((model) => ({ id: model.id }));
}
