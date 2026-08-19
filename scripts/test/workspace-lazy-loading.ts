import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatTree } from "../../src/types";

const dataDir = await mkdtemp(path.join(tmpdir(), "locus-lazy-workspace-"));
process.env.DATA_DIR = dataDir;

try {
  const {
    emptyState,
    readState,
    readStateIndex,
    readStoredChat,
    syncState,
    writeState,
  } = await import("../../server/storage.ts");

  const createdAt = new Date(0).toISOString();
  const chat: ChatTree = {
    id: "large-book",
    title: "Large book",
    categoryId: null,
    rootId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        title: "Large book",
        messages: [
          {
            id: "source",
            role: "source",
            content: "large private payload".repeat(10_000),
            createdAt,
          },
        ],
        createdAt,
        updatedAt: createdAt,
      },
      branch: {
        id: "branch",
        parentId: "root",
        title: "Elaboration",
        messages: [],
        createdAt,
        updatedAt: createdAt,
      },
    },
    createdAt,
    updatedAt: createdAt,
  };
  await writeState({ ...emptyState(), chats: [chat] });

  const index = await readStateIndex();
  assert.equal(index.chats.length, 1);
  assert.deepEqual(index.chats[0].nodes, {});
  assert.equal(index.chats[0].branchCount, 1);
  assert.equal(JSON.stringify(index).includes("large private payload"), false);

  const loaded = await readStoredChat(chat.id);
  assert.equal(loaded?.nodes.root.messages[0].content.length, 210_000);

  const renamedAt = new Date(1_000).toISOString();
  await syncState({
    upsertChats: [{ ...index.chats[0], title: "Renamed", updatedAt: renamedAt }],
    chatBaseUpdatedAt: { [chat.id]: createdAt },
  });
  const saved = await readState();
  assert.equal(saved.chats[0].title, "Renamed");
  assert.equal(saved.chats[0].nodes.root.messages[0].content.length, 210_000);
  assert.equal(saved.chats[0].branchCount, undefined);

  console.log("Workspace index and lazy chat persistence checks passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
