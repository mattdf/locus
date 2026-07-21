import assert from "node:assert/strict";
import {
  annotationSnapshots,
  applyAnnotationSnapshots,
  materializeAnnotationSnapshots,
  type AssistantAnnotationRef,
} from "../../src/lib/assistantEdits.ts";
import { makeChatExport, parseChatImport } from "../../src/lib/chatTransfer.ts";
import { messagesForNode } from "../../src/lib/tree.ts";
import type { ChatTree, HighlightAnchor, ThreadNode, WorkspaceState } from "../../src/types.ts";

const createdAt = "2026-07-21T00:00:00.000Z";
const anchor = (messageId: string, quote: string, start: number): HighlightAnchor => ({
  sourceNodeId: "root",
  sourceMessageId: messageId,
  quote,
  blockIndex: 0,
  start,
  end: start + quote.length,
  status: "resolved",
});

const baseNode: ThreadNode = {
  id: "root",
  parentId: null,
  title: "Assistant edits",
  messages: [
    { id: "user-a", role: "user", content: "Explain A", createdAt },
    { id: "generation-a", role: "assistant", content: "Original A", createdAt },
  ],
  responseRevisions: {
    "generation-a": {
      assistantMessageId: "generation-a",
      activeResponseId: "generation-b",
      responses: [
        { id: "generation-a", role: "assistant", content: "Original A", createdAt },
        { id: "generation-b", role: "assistant", content: "Original B", createdAt },
      ],
    },
  },
  assistantEdits: {
    "generation-a": {
      assistantMessageId: "generation-a",
      activeVariantId: "rewrite-a",
      variants: [
        { id: "original-a", content: "Original A", anchors: annotationSnapshots([]), kind: "original", createdAt },
        { id: "rewrite-a", content: "Rewritten A", anchors: annotationSnapshots([]), kind: "rewrite", createdAt },
      ],
    },
    "generation-b": {
      assistantMessageId: "generation-b",
      activeVariantId: "rewrite-b",
      variants: [
        { id: "original-b", content: "Original B", anchors: annotationSnapshots([]), kind: "original", createdAt },
        { id: "rewrite-b", content: "Rewritten B", anchors: annotationSnapshots([]), kind: "rewrite", createdAt },
      ],
    },
  },
  createdAt,
  updatedAt: createdAt,
};

assert.equal(
  messagesForNode(baseNode)[1].content,
  "Rewritten B",
  "The active rewrite must resolve beneath the active generation leaf",
);
const generationASwitched = {
  ...baseNode,
  responseRevisions: {
    ...baseNode.responseRevisions,
    "generation-a": {
      ...baseNode.responseRevisions!["generation-a"],
      activeResponseId: "generation-a",
    },
  },
};
assert.equal(
  messagesForNode(generationASwitched)[1].content,
  "Rewritten A",
  "Changing generations must select that generation's independent rewrite group",
);

const currentContent = "Alpha beta gamma";
const targetContent = "Intro. Alpha beta gamma";
const annotations: AssistantAnnotationRef[] = [
  { key: "branch:branch-1", kind: "branch", id: "branch-1", anchor: anchor("generation-b", "beta", 6) },
  { key: "definition:def-1", kind: "definition", id: "def-1", anchor: anchor("generation-b", "beta", 6) },
  { key: "visualization:viz-1", kind: "visualization", id: "viz-1", anchor: anchor("generation-b", "beta", 6) },
  { key: "inline-elaboration:inline-1", kind: "inline-elaboration", id: "inline-1", anchor: anchor("generation-b", "beta", 6) },
];
const targetSnapshots = materializeAnnotationSnapshots(
  annotations,
  currentContent,
  targetContent,
  annotationSnapshots([]),
);
for (const snapshots of Object.values(targetSnapshots)) {
  assert.equal(snapshots[0]?.anchor.start, 13, "New annotations must diff-map into older variants");
  assert.equal(snapshots[0]?.anchor.quote, "beta");
}

const chat: ChatTree = {
  id: "chat",
  title: "Assistant edits",
  rootId: "root",
  nodes: {
    root: {
      ...baseNode,
      definitions: [{ id: "def-1", anchor: annotations[1].anchor, content: "Definition", createdAt }],
      visualizations: [{
        id: "viz-1",
        anchor: annotations[2].anchor,
        hint: "",
        status: "ready",
        svg: "<svg />",
        createdAt,
        updatedAt: createdAt,
      }],
      inlineElaborations: [{
        id: "inline-1",
        anchor: annotations[3].anchor,
        hint: "",
        content: "Inline",
        createdAt,
        updatedAt: createdAt,
      }],
    },
    "branch-1": {
      id: "branch-1",
      parentId: "root",
      title: "Branch",
      anchor: annotations[0].anchor,
      messages: [],
      createdAt,
      updatedAt: createdAt,
    },
  },
  createdAt,
  updatedAt: createdAt,
};
const applied = applyAnnotationSnapshots(chat, "root", targetSnapshots, createdAt);
assert(applied);
assert.equal(applied.nodes["branch-1"].anchor?.start, 13);
assert.equal(applied.node.definitions?.[0].anchor.start, 13);
assert.equal(applied.node.visualizations?.[0].anchor.start, 13);
assert.equal(applied.node.inlineElaborations?.[0].anchor.start, 13);

const workspace = {
  version: 1,
  categories: [],
  chats: [chat],
  activeChatId: chat.id,
  settings: {},
} as unknown as WorkspaceState;
const exported = makeChatExport(workspace, { type: "all" });
const imported = parseChatImport(JSON.stringify(exported));
assert.equal(
  imported.chats[0].nodes.root.assistantEdits?.["generation-b"].variants.length,
  2,
  "Assistant edit variants must survive JSON export and import validation",
);

console.log("Assistant edit variant invariants passed");
