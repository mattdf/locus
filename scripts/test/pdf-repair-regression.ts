import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPdfSearchPages } from "../../src/lib/pdfVirtualization.ts";
import {
  applyExactRepairEdits,
  validateAndNormalizeRepair,
} from "../../server/pdf-repair.ts";

const malformed = [
  "```ruby",
  "The tensor equation is",
  "",
  "$$",
  "$T$ is invertible $\\iff T$ is injective.",
  "$$",
  "```",
].join("\n");
const repairedCandidate = applyExactRepairEdits(malformed, [
  {
    before: "```ruby\n",
    after: "",
    occurrence: 1,
    reason: "Ordinary mathematical prose was fenced as Ruby",
    confidence: "high",
  },
  {
    before: "\n```",
    after: "",
    occurrence: 1,
    reason: "Remove the matching hallucinated fence",
    confidence: "high",
  },
]);
const repaired = validateAndNormalizeRepair(malformed, repairedCandidate);
assert.doesNotMatch(repaired.markdown, /```ruby/);
assert.ok(repaired.mathNodeCount >= 2);
assert.throws(() => validateAndNormalizeRepair(
  "![figure](assets-hq/page-0001.png)",
  "![figure](https://example.test/changed.png)",
));

const workspacePath = path.resolve("data/chats.json");
const workspace = JSON.parse(await readFile(workspacePath, "utf8")) as {
  chats?: Array<{
    id?: string;
    title?: string;
    rootId?: string;
    source?: { kind?: string; pageStart?: number };
    nodes?: Record<string, { messages?: Array<{ role?: string; content?: string }> }>;
  }>;
};

let books = 0;
let pages = 0;
let mathNodes = 0;
const failures: Array<{
  label: string;
  chatId: string;
  documentId: string;
  page: number;
  content: string;
  previous: string;
  next: string;
}> = [];
for (const chat of workspace.chats ?? []) {
  if (chat.source?.kind !== "pdf" || !chat.rootId) continue;
  const source = chat.nodes?.[chat.rootId]?.messages?.find(
    (message) => message.role === "source",
  )?.content;
  if (!source) continue;
  books += 1;
  const bookPages = createPdfSearchPages(source, chat.source.pageStart ?? 1);
  for (const [pageIndex, page] of bookPages.entries()) {
    pages += 1;
    try {
      mathNodes += validateAndNormalizeRepair(page.content, page.content).mathNodeCount;
    } catch (error) {
      failures.push({
        label: `${chat.title ?? chat.id ?? "PDF"} page ${page.page}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        chatId: chat.id ?? "unknown-chat",
        documentId: (chat.source as { documentId?: string }).documentId ?? "unknown-document",
        page: page.page,
        content: page.content,
        previous: bookPages[pageIndex - 1]?.content ?? "",
        next: bookPages[pageIndex + 1]?.content ?? "",
      });
    }
  }
}

assert.ok(books >= 4, "Expected the existing localhost PDF corpus");
if (process.env.PDF_REPAIR_LIVE === "1") {
  const liveFailures: string[] = [];
  for (const issue of failures) {
    const sourceSha256 = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(issue.content),
    ).then((digest) => Buffer.from(digest).toString("hex"));
    const response = await fetch(
      process.env.PDF_REPAIR_LIVE_URL ?? "http://127.0.0.1:8787/api/internal/pdf-repair/page",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PDF_REPAIR_LIVE_TOKEN ?? "locus-local-pdf-admin"}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ownerUserId: process.env.PDF_REPAIR_LIVE_OWNER_ID ?? "local",
          jobId: `regression-${issue.chatId}`,
          documentId: issue.documentId,
          pageNumber: issue.page,
          sourceSha256,
          markdown: issue.content,
          previousMarkdown: issue.previous.slice(-8_000),
          nextMarkdown: issue.next.slice(0, 8_000),
        }),
      },
    );
    const result = await response.json() as { markdown?: string; error?: string };
    if (!response.ok || typeof result.markdown !== "string") {
      liveFailures.push(`${issue.label} -> ${result.error ?? `HTTP ${response.status}`}`);
      continue;
    }
    try {
      validateAndNormalizeRepair(issue.content, result.markdown);
    } catch (error) {
      liveFailures.push(
        `${issue.label} -> ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  assert.equal(liveFailures.length, 0, liveFailures.join("\n"));
}
console.log(
  `PDF repair regression checks passed: ${books} books, ${pages.toLocaleString()} pages, ${mathNodes.toLocaleString()} valid math nodes, ${failures.length} legacy pages selected as live repair fixtures.`,
);
