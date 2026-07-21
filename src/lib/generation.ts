import type { GenerationMetrics } from "../types";
import { providerLabel } from "./providers";

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function generationDetails(generation: GenerationMetrics): string {
  const duration = formatDuration(generation.durationMs);
  const route = [
    generation.providerLabel || (generation.provider ? providerLabel(generation.provider) : null),
    generation.model,
  ]
    .filter(Boolean)
    .join(" · ");
  const prefix = route ? `${duration} · ${route}` : duration;
  if (
    generation.totalTokens === null ||
    generation.inputTokens === null ||
    generation.outputTokens === null ||
    generation.reasoningTokens === null
  ) {
    return `${prefix} · token usage unavailable`;
  }
  const format = (value: number) => value.toLocaleString();
  const costKind = generation.provider === "openrouter" ? "reported" : "estimated";
  const cost =
    typeof generation.totalCostUsd === "number"
      ? generation.totalCostUsd < 0.0001
        ? `< $0.0001 ${costKind}`
        : `$${generation.totalCostUsd.toFixed(generation.totalCostUsd < 0.01 ? 5 : 4)} ${costKind}`
      : "cost unavailable";
  return `${prefix} · ${format(generation.totalTokens)} tokens total · ${format(generation.inputTokens)} input · ${format(generation.outputTokens)} generated (including ${format(generation.reasoningTokens)} reasoning) · ${cost}`;
}
