import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceState } from "../src/types.ts";
import {
  DEFAULT_DEFINITION_MODELS,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_VISUALIZATION_MODELS,
  LEGACY_CUSTOM_PROVIDER_ID,
  isProviderId,
} from "../src/lib/providers.ts";
import { normalizeChatRevisions } from "../src/lib/revisions.ts";

const DATA_DIR = path.resolve(process.env.DATA_DIR?.trim() || "data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");

export const emptyState = (): WorkspaceState => ({
  version: 1,
  categories: [],
  chats: [],
  activeChatId: null,
  settings: {
    provider: "openai",
    definitionProvider: "openai",
    visualizationProvider: "openai",
    rewriteProvider: "openai",
    providerModels: { ...DEFAULT_PROVIDER_MODELS },
    definitionModels: { ...DEFAULT_DEFINITION_MODELS },
    visualizationModels: { ...DEFAULT_VISUALIZATION_MODELS },
    rewriteModels: { ...DEFAULT_PROVIDER_MODELS },
    definitionReasoningEfforts: { openai: "medium", openrouter: "medium", anthropic: "medium", kimi: "medium", glm: "medium", minimax: "medium", deepseek: "high", qwen: "medium", custom: "medium" },
    visualizationReasoningEfforts: { openai: "high", openrouter: "high", anthropic: "high", kimi: "high", glm: "high", minimax: "high", deepseek: "max", qwen: "high", custom: "medium" },
    rewriteReasoningEfforts: { openai: "high", openrouter: "high", anthropic: "high", kimi: "high", glm: "high", minimax: "high", deepseek: "max", qwen: "high", custom: "medium" },
    localBaseUrl: DEFAULT_LOCAL_BASE_URL,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    maxOutputTokens: 50_000,
    customInstructions: "",
    focusDrawerWidth: 440,
    sidebarCollapsed: false,
    collapsedCategoryIds: [],
    theme: "light",
    textScale: 100,
    sendShortcut: "enter",
  },
});

export function normalizeState(state: WorkspaceState): WorkspaceState {
  const categories = Array.isArray(state.categories)
    ? state.categories.filter(
        (category, index, items) =>
          typeof category?.id === "string" &&
          typeof category?.name === "string" &&
          items.findIndex((candidate) => candidate?.id === category.id) === index,
      )
    : [];
  const categoryIds = new Set(categories.map((category) => category.id));
  const hasReasoningEffort = Boolean(state.settings?.reasoningEffort);
  const legacyProvider = state.settings?.provider === "local" || state.settings?.provider === "custom"
    ? LEGACY_CUSTOM_PROVIDER_ID
    : state.settings?.provider;
  const provider = typeof legacyProvider === "string" && legacyProvider.trim()
    ? legacyProvider.trim()
    : "openai";
  const legacyModel =
    !hasReasoningEffort && state.chats.length === 0
      ? "gpt-5.6-sol"
      : state.settings?.model || "gpt-5.6-sol";
  const savedProviderModels = state.settings?.providerModels;
  const providerModels: Record<string, string> = {
    ...DEFAULT_PROVIDER_MODELS,
    ...(savedProviderModels ?? {}),
    ...(provider === LEGACY_CUSTOM_PROVIDER_ID && (state.settings?.provider === "local" || state.settings?.provider === "custom")
      ? { [LEGACY_CUSTOM_PROVIDER_ID]: savedProviderModels?.local || savedProviderModels?.custom || legacyModel }
      : { [provider]: legacyModel }),
  };
  const model = providerModels[provider];
  const savedDefinitionModels = state.settings?.definitionModels;
  const definitionModels: Record<string, string> = {
    ...DEFAULT_DEFINITION_MODELS,
    ...(savedDefinitionModels ?? {}),
  };
  const savedVisualizationModels = state.settings?.visualizationModels;
  const visualizationModels: Record<string, string> = {
    ...DEFAULT_VISUALIZATION_MODELS,
    ...(savedVisualizationModels ?? {}),
  };
  const savedVisualizationEfforts = state.settings?.visualizationReasoningEfforts;
  const visualizationReasoningEfforts: Record<string, import("../src/types.ts").ReasoningEffort> = {
    openai: "high", openrouter: "high", anthropic: "high", kimi: "high", glm: "high", minimax: "high", deepseek: "max", qwen: "high", custom: "medium",
    ...(savedVisualizationEfforts ?? {}),
  };
  const definitionReasoningEfforts = {
    openai: "medium", openrouter: "medium", anthropic: "medium", kimi: "medium", glm: "medium", minimax: "medium", deepseek: "high", qwen: "medium", custom: "medium",
    ...(state.settings?.definitionReasoningEfforts ?? {}),
  } as Record<string, import("../src/types.ts").ReasoningEffort>;
  const definitionProvider = typeof state.settings?.definitionProvider === "string"
    ? state.settings.definitionProvider
    : provider;
  const visualizationProvider = typeof state.settings?.visualizationProvider === "string"
    ? state.settings.visualizationProvider
    : provider;
  const rewriteProvider = typeof state.settings?.rewriteProvider === "string"
    ? state.settings.rewriteProvider
    : provider;
  const rewriteModels = { ...providerModels, ...(state.settings?.rewriteModels ?? {}) };
  const rewriteReasoningEfforts = {
    ...visualizationReasoningEfforts,
    ...(state.settings?.rewriteReasoningEfforts ?? {}),
  };
  return {
    ...state,
    categories,
    chats: (Array.isArray(state.chats) ? state.chats : []).map((chat) =>
      normalizeChatRevisions({
        ...chat,
        categoryId:
          typeof chat.categoryId === "string" && categoryIds.has(chat.categoryId)
            ? chat.categoryId
            : null,
      }),
    ),
    settings: {
      provider,
      definitionProvider,
      visualizationProvider,
      rewriteProvider,
      providerModels,
      definitionModels,
      visualizationModels,
      rewriteModels,
      definitionReasoningEfforts,
      visualizationReasoningEfforts,
      rewriteReasoningEfforts,
      localBaseUrl:
        typeof state.settings?.localBaseUrl === "string" &&
        state.settings.localBaseUrl.trim()
          ? state.settings.localBaseUrl.trim()
          : DEFAULT_LOCAL_BASE_URL,
      model,
      reasoningEffort:
        state.settings?.reasoningEffort ?? (model.startsWith("gpt-5.6") ? "max" : "xhigh"),
      maxOutputTokens:
        Number.isSafeInteger(state.settings?.maxOutputTokens) &&
        state.settings.maxOutputTokens >= 0
          ? state.settings.maxOutputTokens
          : 50_000,
      customInstructions: state.settings?.customInstructions ?? "",
      focusDrawerWidth:
        typeof state.settings?.focusDrawerWidth === "number"
          ? Math.min(720, Math.max(320, state.settings.focusDrawerWidth))
          : 440,
      sidebarCollapsed: state.settings?.sidebarCollapsed === true,
      collapsedCategoryIds: Array.isArray(state.settings?.collapsedCategoryIds)
        ? [...new Set(state.settings.collapsedCategoryIds.filter((id) => typeof id === "string"))]
        : [],
      theme: state.settings?.theme === "dark" ? "dark" : "light",
      textScale:
        typeof state.settings?.textScale === "number"
          ? Math.min(140, Math.max(80, Math.round(state.settings.textScale / 5) * 5))
          : 100,
      sendShortcut:
        state.settings?.sendShortcut === "mod-enter" ? "mod-enter" : "enter",
    },
  };
}

export async function readState(): Promise<WorkspaceState> {
  try {
    return normalizeState(JSON.parse(await readFile(DATA_FILE, "utf8")) as WorkspaceState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function writeState(state: WorkspaceState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryFile, DATA_FILE);
}
