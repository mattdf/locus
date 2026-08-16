import assert from "node:assert/strict";
import { createPdfMarkdownPages, pdfPageForBlock } from "../../src/lib/pdfVirtualization";
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

console.log("PDF page virtualization invariants passed");
