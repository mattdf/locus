import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceState } from "../src/types.ts";

const DATA_DIR = path.resolve("data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");

export const emptyState = (): WorkspaceState => ({
  version: 1,
  chats: [],
  activeChatId: null,
  settings: {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    customInstructions: "",
    focusDrawerWidth: 440,
    sidebarCollapsed: false,
    theme: "light",
  },
});

function normalizeState(state: WorkspaceState): WorkspaceState {
  const hasReasoningEffort = Boolean(state.settings?.reasoningEffort);
  const model =
    !hasReasoningEffort && state.chats.length === 0
      ? "gpt-5.6-sol"
      : state.settings?.model || "gpt-5.6-sol";
  return {
    ...state,
    settings: {
      model,
      reasoningEffort:
        state.settings?.reasoningEffort ?? (model.startsWith("gpt-5.6") ? "max" : "xhigh"),
      customInstructions: state.settings?.customInstructions ?? "",
      focusDrawerWidth:
        typeof state.settings?.focusDrawerWidth === "number"
          ? Math.min(720, Math.max(320, state.settings.focusDrawerWidth))
          : 440,
      sidebarCollapsed: state.settings?.sidebarCollapsed === true,
      theme: state.settings?.theme === "dark" ? "dark" : "light",
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
