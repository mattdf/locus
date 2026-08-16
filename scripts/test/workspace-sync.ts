import assert from "node:assert/strict";
import type { ChatTree, WorkspaceState } from "../../src/types";
import { workspaceSyncChanges } from "../../src/lib/workspaceSync";

const createdAt = new Date(0).toISOString();
const chat = {
  id: "book",
  title: "Large book",
  rootId: "root",
  categoryId: null,
  nodes: {
    root: {
      id: "root",
      parentId: null,
      title: "Large book",
      messages: [{ id: "source", role: "source", content: "x".repeat(2_000_000), createdAt }],
      createdAt,
      updatedAt: createdAt,
    },
  },
  createdAt,
  updatedAt: createdAt,
  toJSON() {
    throw new Error("Workspace dirty detection must not serialize chats");
  },
} as ChatTree & { toJSON(): never };
const settings = {} as WorkspaceState["settings"];
const categories: WorkspaceState["categories"] = [];
const before = {
  version: 1,
  settings,
  categories,
  chats: [chat],
  activeChatId: "book",
} as WorkspaceState;

assert.equal(
  workspaceSyncChanges(before, { ...before, activeChatId: null }, 4),
  null,
  "Browser-local navigation must not dirty persisted workspace content",
);

const updatedAt = new Date(1_000).toISOString();
const changedChat = { ...chat, title: "Renamed", updatedAt };
const chatChanges = workspaceSyncChanges(
  before,
  { ...before, chats: [changedChat] },
  4,
);
assert.deepEqual(chatChanges?.upsertChats, [changedChat]);
assert.deepEqual(chatChanges?.chatBaseUpdatedAt, { book: createdAt });
assert.equal(chatChanges?.settings, undefined);
assert.equal(chatChanges?.categories, undefined);

const nextSettings = { ...settings };
const settingsChanges = workspaceSyncChanges(
  before,
  { ...before, settings: nextSettings },
  4,
);
assert.equal(settingsChanges?.settings, nextSettings);
assert.equal(settingsChanges?.upsertChats, undefined);

console.log("Workspace structural dirty tracking checks passed");
