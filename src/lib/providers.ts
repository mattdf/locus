import type { ProviderConnectionSummary, ProviderId, ProviderKind, ReasoningEffort } from "../types";

export const PROVIDER_OPTIONS: Array<{
  id: ProviderId;
  label: string;
  note: string;
}> = [
  { id: "openai", label: "OpenAI", note: "Responses API" },
  { id: "openrouter", label: "OpenRouter", note: "OpenAI-compatible gateway" },
  { id: "anthropic", label: "Claude", note: "Anthropic Messages API" },
  { id: "kimi", label: "Kimi", note: "Moonshot API" },
  { id: "glm", label: "GLM", note: "Z.AI API" },
  { id: "minimax", label: "MiniMax", note: "MiniMax API" },
  { id: "deepseek", label: "DeepSeek", note: "DeepSeek OpenAI-compatible API" },
  { id: "qwen", label: "Qwen", note: "Alibaba Model Studio · Singapore endpoint" },
  { id: "custom", label: "Custom OpenAI Compatible", note: "User-defined endpoint" },
];

export const DEFAULT_PROVIDER_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.6-sol",
  openrouter: "~openai/gpt-latest",
  anthropic: "claude-opus-4-8",
  kimi: "kimi-k2.5",
  glm: "glm-5.2",
  minimax: "MiniMax-M2.7",
  deepseek: "deepseek-v4-pro",
  qwen: "qwen3.7-max",
  custom: "",
};

export const DEFAULT_DEFINITION_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.4-mini",
  openrouter: "~openai/gpt-latest",
  anthropic: "claude-haiku-4-5",
  kimi: "kimi-k2.5",
  glm: "glm-5.2",
  minimax: "MiniMax-M2.7",
  deepseek: "deepseek-v4-flash",
  qwen: "qwen3.6-flash",
  custom: "",
};

export const DEFAULT_VISUALIZATION_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.4",
  openrouter: "~openai/gpt-latest",
  anthropic: "claude-opus-4-8",
  kimi: "kimi-k2.5",
  glm: "glm-5.2",
  minimax: "MiniMax-M2.7",
  deepseek: "deepseek-v4-pro",
  qwen: "qwen3.7-max",
  custom: "",
};

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";
export const LEGACY_CUSTOM_PROVIDER_ID = "00000000-0000-4000-8000-000000000001";

export function providerLabel(provider: string): string {
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}

export function isProviderId(value: unknown): value is ProviderId {
  return PROVIDER_OPTIONS.some((provider) => provider.id === value);
}

export function isBuiltInProviderId(value: unknown): value is Exclude<ProviderId, "custom"> {
  return isProviderId(value) && value !== "custom";
}

export function providerKindFor(
  providerRef: string,
  connections: ProviderConnectionSummary[],
): ProviderKind {
  return connections.find((connection) => connection.id === providerRef)?.kind ??
    (isProviderId(providerRef) ? providerRef : "custom");
}

export function compatibleReasoningEffort(
  provider: ProviderKind,
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  return provider === "openai" && effort === "max" && !model.startsWith("gpt-5.6")
    ? "xhigh"
    : effort;
}
