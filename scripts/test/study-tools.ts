import assert from "node:assert/strict";
import { annotationIntegrity, searchWorkspace, workspaceJobs } from "../../src/lib/study.ts";
import { recoveredThreadTitle, titleFrom } from "../../src/lib/tree.ts";
import type { ChatTree, WorkspaceState } from "../../src/types.ts";
import { emptyState } from "../../server/storage.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const rootId = "root";
const sourceId = "source";
const chat: ChatTree = {
  id: "chat",
  title: "Attention notes",
  rootId,
  createdAt,
  updatedAt: createdAt,
  nodes: {
    [rootId]: {
      id: rootId,
      parentId: null,
      title: "Attention notes",
      createdAt,
      updatedAt: createdAt,
      messages: [
        {
          id: sourceId,
          role: "source",
          content: "# Scaled attention\n\nThe score is $q^T k / \\sqrt{d}$ before softmax.",
          createdAt,
        },
        {
          id: "assistant",
          role: "assistant",
          content: "This normalization controls the variance.",
          createdAt,
          pending: true,
          requestId: "request",
        },
      ],
      definitions: [
        {
          id: "definition",
          anchor: {
            sourceNodeId: rootId,
            sourceMessageId: sourceId,
            quote: "softmax",
            blockIndex: 1,
            start: 0,
            end: 7,
          },
          content: "A normalized exponential weighting.",
          createdAt,
        },
      ],
    },
  },
};

const workspace: WorkspaceState = {
  ...emptyState(),
  chats: [chat],
};

const equationResults = searchWorkspace(workspace, "\\sqrt{d}");
assert.equal(equationResults[0]?.chatId, chat.id);
assert.equal(equationResults[0]?.kind, "message");

const definitionResults = searchWorkspace(workspace, "exponential weighting");
assert.equal(definitionResults[0]?.kind, "definition");
assert.equal(definitionResults[0]?.annotation?.id, "definition");

const integrity = annotationIntegrity(chat);
assert.equal(integrity.length, 1);
assert.equal(integrity[0].status, "needs-review");
assert.ok(integrity[0].suggestedAnchor);
assert.equal(integrity[0].suggestedAnchor?.quote, "softmax");

const jobs = workspaceJobs(workspace);
assert.equal(jobs[0]?.kind, "response");
assert.equal(jobs[0]?.status, "running");
assert.equal(jobs[0]?.requestId, "request");

assert.equal(
  titleFrom("Why $\\sqrt{d_k}$ keeps the variance stable"),
  "Why $\\sqrt{d_k}$ keeps the variance stable",
);
const longEquationTitle = titleFrom(
  "$$\\begin{aligned}F(p)&=\\sum_jp_js_j-\\sum_jp_j\\log p_j\\\\&=\\log Z-D_{\\mathrm{KL}}(p\\|a).\\end{aligned}$$",
);
assert.ok(longEquationTitle.includes("p_j"));
assert.ok(longEquationTitle.endsWith("$$"));
assert.ok(!longEquationTitle.includes("…"));

assert.equal(
  recoveredThreadTitle({
    id: "legacy-math-title",
    parentId: rootId,
    title: "Pfi = \\sumjP{ij}fj.",
    anchor: {
      sourceNodeId: rootId,
      sourceMessageId: sourceId,
      quote: "$(Pf)(i)=\\sum_jP_{ij}f(j).$",
      blockIndex: 1,
    },
    messages: [],
    createdAt,
    updatedAt: createdAt,
  }),
  "$(Pf)(i)=\\sum_jP_{ij}f(j).$",
);
assert.equal(
  recoveredThreadTitle({
    id: "legacy-delimited-title",
    parentId: rootId,
    title: "$s(X)=(s{i1}(X),\\ldots,s{in}(X))\\in\\mathbb R^n,$",
    anchor: {
      sourceNodeId: rootId,
      sourceMessageId: sourceId,
      quote: "$s(X)=(s_{i1}(X),\\ldots,s_{in}(X))\\in\\mathbb R^n,$",
      blockIndex: 1,
    },
    messages: [],
    createdAt,
    updatedAt: createdAt,
  }),
  "$s(X)=(s_{i1}(X),\\ldots,s_{in}(X))\\in\\mathbb R^n,$",
);

console.log("Study search, annotation integrity, and job indexing invariants passed");
