import type { WorkspaceState } from "../src/types.ts";
import { searchWorkspace, type StudySearchResult } from "../src/lib/study.ts";
import { isHosted } from "./config.ts";
import { readState } from "./storage.ts";
import { readHostedWorkspace } from "./workspaces.ts";

interface CachedWorkspace {
  state: WorkspaceState;
  expiresAt: number;
}

const workspaceCache = new Map<string, CachedWorkspace>();
const CACHE_TTL_MS = 30_000;
const MAX_CACHED_OWNERS = 100;

async function searchableWorkspace(ownerUserId: string): Promise<WorkspaceState> {
  const cached = workspaceCache.get(ownerUserId);
  if (cached && cached.expiresAt > Date.now()) {
    workspaceCache.delete(ownerUserId);
    workspaceCache.set(ownerUserId, cached);
    return cached.state;
  }

  const state = isHosted
    ? (await readHostedWorkspace(ownerUserId)).state
    : await readState();
  workspaceCache.set(ownerUserId, {
    state,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  while (workspaceCache.size > MAX_CACHED_OWNERS) {
    const oldestOwner = workspaceCache.keys().next().value as string | undefined;
    if (!oldestOwner) break;
    workspaceCache.delete(oldestOwner);
  }
  return state;
}

export function invalidateWorkspaceSearch(ownerUserId: string): void {
  workspaceCache.delete(ownerUserId);
}

export async function searchStoredWorkspace(
  ownerUserId: string,
  query: string,
  limit = 80,
): Promise<StudySearchResult[]> {
  return searchWorkspace(
    await searchableWorkspace(ownerUserId),
    query,
    Math.max(1, Math.min(80, limit)),
  );
}
