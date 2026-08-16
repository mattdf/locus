import type { ChatCategory, ChatTree, WorkspaceState } from "../types";

export interface WorkspaceSyncChanges {
  baseRevision: number;
  settings?: WorkspaceState["settings"];
  categories?: ChatCategory[];
  upsertChats?: ChatTree[];
  deleteChatIds?: string[];
  chatBaseUpdatedAt?: Record<string, string | null>;
}

/**
 * Workspace updates are immutable throughout the client. Reference changes
 * therefore form an exact dirty set without serializing every chat merely to
 * discover which one changed. The changed chat itself is serialized only when
 * the debounced sync request is finally sent.
 */
export function workspaceSyncChanges(
  before: WorkspaceState,
  after: WorkspaceState,
  baseRevision: number,
): WorkspaceSyncChanges | null {
  const changes: WorkspaceSyncChanges = { baseRevision };
  if (before.settings !== after.settings) changes.settings = after.settings;
  if (before.categories !== after.categories) changes.categories = after.categories;

  const previousChats = new Map(before.chats.map((chat) => [chat.id, chat]));
  const nextChatIds = new Set(after.chats.map((chat) => chat.id));
  const upsertChats = after.chats.filter(
    (chat) => previousChats.get(chat.id) !== chat,
  );
  const deleteChatIds = before.chats
    .filter((chat) => !nextChatIds.has(chat.id))
    .map((chat) => chat.id);
  if (upsertChats.length) changes.upsertChats = upsertChats;
  if (deleteChatIds.length) changes.deleteChatIds = deleteChatIds;
  if (upsertChats.length || deleteChatIds.length) {
    changes.chatBaseUpdatedAt = Object.fromEntries([
      ...upsertChats.map((chat) => [
        chat.id,
        previousChats.get(chat.id)?.updatedAt ?? null,
      ] as const),
      ...deleteChatIds.map((chatId) => [
        chatId,
        previousChats.get(chatId)?.updatedAt ?? null,
      ] as const),
    ]);
  }
  return Object.keys(changes).length === 1 ? null : changes;
}
