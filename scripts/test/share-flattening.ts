import assert from "node:assert/strict";
import { createPublicSnapshot } from "../../server/shares.ts";
import type { AnnotationAnchorSnapshotSet, ChatTree } from "../../src/types.ts";

const createdAt = "2026-07-21T00:00:00.000Z";
const emptyAnchors = (): AnnotationAnchorSnapshotSet => ({
  branches: [],
  definitions: [],
  visualizations: [],
  inlineElaborations: [],
});

const chat: ChatTree = {
  id: "share-flattening",
  title: "Flattened share",
  rootId: "root",
  nodes: {
    root: {
      id: "root",
      parentId: null,
      title: "Flattened share",
      messages: [
        { id: "user-root", role: "user", content: "Original question", createdAt },
        { id: "assistant-root", role: "assistant", content: "Original answer", createdAt },
        { id: "source-root", role: "source", content: "Edited imported Markdown", createdAt },
      ],
      messageRevisions: {
        "user-root": {
          userMessageId: "user-root",
          assistantMessageId: "assistant-root",
          activeVariantId: "edited-pair",
          variants: [
            {
              id: "original-pair",
              userMessage: { id: "user-root", role: "user", content: "Original question", createdAt },
              assistantMessage: { id: "assistant-root", role: "assistant", content: "Original answer", createdAt },
            },
            {
              id: "edited-pair",
              userMessage: { id: "user-edited", role: "user", content: "Active edited question", createdAt },
              assistantMessage: { id: "assistant-edited", role: "assistant", content: "First edited answer", createdAt },
            },
          ],
        },
      },
      responseRevisions: {
        "assistant-edited": {
          assistantMessageId: "assistant-edited",
          activeResponseId: "assistant-regenerated",
          responses: [
            { id: "assistant-edited", role: "assistant", content: "First edited answer", createdAt },
            { id: "assistant-regenerated", role: "assistant", content: "Regenerated answer", createdAt },
          ],
        },
      },
      assistantEdits: {
        "assistant-regenerated": {
          assistantMessageId: "assistant-regenerated",
          activeVariantId: "assistant-rewrite",
          variants: [
            { id: "assistant-original", content: "Regenerated answer", anchors: emptyAnchors(), kind: "original", createdAt },
            { id: "assistant-rewrite", content: "Active rewritten answer", anchors: emptyAnchors(), kind: "rewrite", createdAt },
          ],
        },
        "inline-share": {
          assistantMessageId: "inline-share",
          activeVariantId: "inline-rewrite",
          variants: [
            { id: "inline-original", content: "Original inline explanation", anchors: emptyAnchors(), kind: "original", createdAt },
            { id: "inline-rewrite", content: "Active rewritten inline explanation", anchors: emptyAnchors(), kind: "rewrite", createdAt },
          ],
        },
      },
      inlineElaborations: [
        {
          id: "inline-share",
          anchor: {
            sourceNodeId: "root",
            sourceMessageId: "assistant-regenerated",
            quote: "answer",
            blockIndex: 0,
            start: 21,
            end: 27,
            status: "resolved",
          },
          hint: "private hint",
          content: "Original inline explanation",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      sourceEditUndo: {
        id: "source-undo",
        sourceMessageId: "source-root",
        previousContent: "Original imported Markdown",
        branches: [],
        definitions: [],
        visualizations: [],
        inlineElaborations: [],
        createdAt,
      },
      createdAt,
      updatedAt: createdAt,
    },
  },
  createdAt,
  updatedAt: createdAt,
};

const snapshot = createPublicSnapshot(chat);
const node = snapshot.nodes.root;
assert.deepEqual(
  node.messages.map(({ id, content }) => ({ id, content })),
  [
    { id: "user-edited", content: "Active edited question" },
    { id: "assistant-regenerated", content: "Active rewritten answer" },
    { id: "source-root", content: "Edited imported Markdown" },
  ],
  "A share must contain only the active user, generation, assistant-edit, and source-edit content",
);
assert.equal(
  node.inlineElaborations?.[0].content,
  "Active rewritten inline explanation",
  "A share must flatten the active inline-elaboration rewrite",
);

for (const privateField of [
  "messageRevisions",
  "responseRevisions",
  "assistantEdits",
  "sourceEditUndo",
] as const) {
  assert.equal(
    Object.hasOwn(node, privateField),
    false,
    `Public nodes must not serialize ${privateField}`,
  );
}
node.messages.forEach((message) => {
  assert.equal(Object.hasOwn(message, "revisionGroupId"), false);
  assert.equal(Object.hasOwn(message, "revisionVariantId"), false);
  assert.equal(Object.hasOwn(message, "responseRevisionGroupId"), false);
});

const serialized = JSON.stringify(snapshot);
for (const hiddenContent of [
  "Original question",
  "Original answer",
  "First edited answer",
  "Regenerated answer",
  "Original imported Markdown",
  "Original inline explanation",
  "private hint",
]) {
  assert.equal(
    serialized.includes(hiddenContent),
    false,
    `The share leaked hidden content: ${hiddenContent}`,
  );
}

console.log("Public share flattening invariants passed");
