import assert from "node:assert/strict";
import {
  createPdfMarkdownPages,
  createPdfSearchPages,
  pdfPageForBlock,
  searchPdfPages,
  stabilizePdfActiveRange,
} from "../../src/lib/pdfVirtualization";
import { createMarkdownDocumentIndex } from "../../src/lib/sourceEditing";

const source = `Introductory material

---

**Page 12**

First page paragraph with $x^2$.

---

**Page 13**

## A section

Second page paragraph.

---

**Page 14**

Final page.
`;

const index = createMarkdownDocumentIndex(source);
const pages = createPdfMarkdownPages(source, index, 12);

assert.deepEqual(
  pages.map((page) => page.page),
  [12, 13, 14],
  "page markers should produce one virtual item per PDF page",
);
assert.match(pages[0].content, /Introductory material/);
assert.match(pages[0].content, /First page paragraph/);
assert.doesNotMatch(pages[0].content, /Second page paragraph/);
assert.match(pages[1].content, /^---/);
assert.match(pages[1].content, /Second page paragraph/);
assert.equal(
  pages[0].endBlockIndex + 1,
  pages[1].startBlockIndex,
  "virtual pages must preserve a contiguous global Markdown block index",
);
assert.equal(pdfPageForBlock(pages, pages[1].startBlockIndex), 13);
assert.equal(pdfPageForBlock(pages, pages[2].endBlockIndex), 14);

const page365Window = stabilizePdfActiveRange(
  { start: 355, end: 375 },
  366,
  10,
);
assert.deepEqual(
  page365Window,
  { start: 355, end: 376 },
  "crossing one page boundary must not evict a page above the viewport",
);
assert.deepEqual(
  stabilizePdfActiveRange(page365Window, 371, 10),
  { start: 361, end: 381 },
  "the retained window should eventually trim old pages in a batch",
);
assert.deepEqual(
  stabilizePdfActiveRange(page365Window, 120, 10),
  { start: 110, end: 130 },
  "a distant page jump should reset the active window around its target",
);

const searchPages = createPdfSearchPages(source, 12);
assert.deepEqual(
  searchPages.map((page) => page.page),
  [12, 13, 14],
  "search indexing must cover every page without rendering it",
);
const search = searchPdfPages(searchPages, "page");
assert.equal(search.total, 6);
assert.deepEqual(
  search.matches.map((match) => match.page),
  [12, 12, 13, 13, 14, 14],
);
const limitedSearch = searchPdfPages(searchPages, "page", 2);
assert.equal(limitedSearch.total, 6);
assert.equal(limitedSearch.matches.length, 2);
assert.equal(limitedSearch.truncated, true);

console.log("PDF page virtualization invariants passed");
