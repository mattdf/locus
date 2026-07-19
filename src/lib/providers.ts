import type { ProviderId, ReasoningEffort } from "../types";

export const PROVIDER_OPTIONS: Array<{
  id: ProviderId;
  label: string;
  note: string;
}> = [
  { id: "openai", label: "OpenAI", note: "Responses API" },
  { id: "openrouter", label: "OpenRouter", note: "OpenAI-compatible gateway" },
  { id: "local", label: "Local endpoint", note: "OpenAI-compatible server" },
];

export const DEFAULT_PROVIDER_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.6-sol",
  openrouter: "~openai/gpt-latest",
  local: "local-model",
};

export const DEFAULT_DEFINITION_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.4-mini",
  openrouter: "~openai/gpt-latest",
  local: "local-model",
};

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === "openai" || value === "openrouter" || value === "local";
}

export function compatibleReasoningEffort(
  provider: ProviderId,
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  return provider === "openai" && effort === "max" && !model.startsWith("gpt-5.6")
    ? "xhigh"
    : effort;
}
