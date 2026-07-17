import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceState } from "../src/types.ts";

const DATA_DIR = path.resolve("data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");

export const emptyState = (): WorkspaceState => ({
  version: 1,
  categories: [],
  chats: [],
  activeChatId: null,
  settings: {
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

function normalizeState(state: WorkspaceState): WorkspaceState {
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
  const model =
    !hasReasoningEffort && state.chats.length === 0
      ? "gpt-5.6-sol"
      : state.settings?.model || "gpt-5.6-sol";
  return {
    ...state,
    categories,
    chats: (Array.isArray(state.chats) ? state.chats : []).map((chat) => ({
      ...chat,
      categoryId:
        typeof chat.categoryId === "string" && categoryIds.has(chat.categoryId)
          ? chat.categoryId
          : null,
    })),
    settings: {
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
