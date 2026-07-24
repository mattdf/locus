import type { TokenUsage } from "./openai.ts";

interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  longContextThreshold?: number;
}

const STANDARD_PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-sol": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    longContextThreshold: 272_000,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    longContextThreshold: 272_000,
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    longContextThreshold: 272_000,
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  },
};

export function hasGenerationPricing(provider: string, model: string): boolean {
  return provider === "openrouter" || (
    provider === "openai" && Object.prototype.hasOwnProperty.call(STANDARD_PRICES, model)
  );
}

export interface GenerationCost {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export function calculateGenerationCost(
  model: string,
  usage?: TokenUsage | null,
): GenerationCost | null {
  const price = STANDARD_PRICES[model];
  if (!price || !usage) return null;

  const cachedInputTokens = Math.min(
    usage.inputTokens,
    Math.max(0, usage.cachedInputTokens),
  );
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const longContext = Boolean(
    price.longContextThreshold && usage.inputTokens > price.longContextThreshold,
  );
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const inputCostUsd =
    (uncachedInputTokens * price.inputPerMillion * inputMultiplier +
      cachedInputTokens * price.cachedInputPerMillion * inputMultiplier) /
    1_000_000;
  const outputCostUsd =
    (usage.outputTokens * price.outputPerMillion * outputMultiplier) / 1_000_000;

  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}
