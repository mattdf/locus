import assert from "node:assert/strict";
import {
  ANNOTATION_CONTEXT_TOKENS_PER_SIDE,
  contextForAnchoredRequest,
  countTextTokens,
  tokenContextWindowForAnchor,
} from "../../src/lib/tokenContext";
import type { ChatTree, HighlightAnchor, ThreadNode } from "../../src/types";

const left = Array.from({ length: 14_000 }, (_, index) => `left_${index} `).join("");
const selected = "SELECTED_EQUATION";
const right = Array.from({ length: 14_000 }, (_, index) => ` right_${index}`).join("");
const document = `${left}${selected}${right}`;
const anchor: HighlightAnchor = {
  sourceNodeId: "root",
  sourceMessageId: "source",
  quote: selected,
  blockIndex: 0,
  start: left.length,
  end: left.length + selected.length,
};

const window = await tokenContextWindowForAnchor(document, anchor);
assert.equal(window.selected, selected);
assert.equal(window.content, `${window.before}${selected}${window.after}`);
assert.ok(document.startsWith(left));
assert.ok(document.endsWith(right));
assert.ok(
  (await countTextTokens(window.before)) <= ANNOTATION_CONTEXT_TOKENS_PER_SIDE,
);
assert.ok(
  (await countTextTokens(window.after)) <= ANNOTATION_CONTEXT_TOKENS_PER_SIDE,
);
assert.ok(window.before.length < left.length);
assert.ok(window.after.length < right.length);
assert.ok(
  (await countTextTokens("A tokenizer may literally print <|endoftext|>.")) > 0,
);

const createdAt = new Date(0).toISOString();
const root: ThreadNode = {
  id: "root",
  parentId: null,
  title: "Imported book",
  messages: [
    {
      id: "source",
      role: "source",
      content: document,
      createdAt,
    },
  ],
  createdAt,
  updatedAt: createdAt,
};
const child: ThreadNode = {
  id: "child",
  parentId: "root",
  title: "Elaboration",
  anchor,
  messages: [
    {
      id: "question",
      role: "user",
      content: "Explain this.",
      createdAt,
    },
  ],
  createdAt,
  updatedAt: createdAt,
};
const chat = {
  id: "chat",
  title: "Imported book",
  rootId: "root",
  categoryId: null,
  nodes: { root, child },
  createdAt,
  updatedAt: createdAt,
} as ChatTree;

const context = await contextForAnchoredRequest(
  chat,
  "child",
  ["question"],
  anchor,
);
assert.equal(context.length, 2);
assert.equal(context[0]?.messages.length, 1);
assert.equal(context[0]?.messages[0]?.content, window.content);
assert.equal(context[1]?.messages.length, 0);

console.log("Token context tests passed.");
