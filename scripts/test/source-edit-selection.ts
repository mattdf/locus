import assert from "node:assert/strict";
import { normalizeMathDelimiters } from "../../src/lib/markdown.ts";
import {
  anchorForSelection,
  containingOriginalMarkdownSection,
  markdownBlockRanges,
} from "../../src/lib/sourceEditing.ts";

const source = String.raw`## 5. Why this disproves the conjecture

The map satisfies the hypothesis:

[
\det DF\equiv-2\neq0.
]

Thus it is locally invertible at every point by the inverse function theorem.

But it is not globally injective, since three distinct points have the same image:

[
F\left(0,0,-\frac14\right)
==========================

# F\left(1,-\frac32,\frac{13}{2}\right)

# F\left(-1,\frac32,\frac{13}{2}\right)

\left(-\frac14,0,0\right).
]

A noninjective function cannot possess any inverse, polynomial or otherwise. Therefore this polynomial map satisfies the Jacobian condition but violates the conclusion of the Jacobian Conjecture.

For the formulation requiring determinant $1$, replace $F=(P,Q,R)$ with

[
\widetilde F=\left(-\frac12P,Q,R\right).
]`;

const rendered = normalizeMathDelimiters(source, true);
const renderedBlocks = markdownBlockRanges(rendered);

function renderedBlockIndexContaining(text: string): number {
  const index = renderedBlocks.findIndex((range) =>
    rendered.slice(range.start, range.end).includes(text),
  );
  assert.notEqual(index, -1, `Expected a rendered block containing ${JSON.stringify(text)}`);
  return index;
}

const target =
  "A noninjective function cannot possess any inverse, polynomial or otherwise. Therefore this polynomial map satisfies the Jacobian condition but violates the conclusion of the Jacobian Conjecture.";
const targetBlockIndex = renderedBlockIndexContaining(target);
const targetSection = containingOriginalMarkdownSection(
  source,
  rendered,
  targetBlockIndex,
);
assert.equal(
  targetSection.content,
  target,
  "A prose selection after normalized copied math must map to its exact raw Markdown paragraph",
);

const selectedPhrase = "violates the conclusion of the Jacobian Conjecture";
const anchor = anchorForSelection(
  source,
  {
    sourceNodeId: "root",
    sourceMessageId: "source",
    quote: selectedPhrase,
    blockIndex: targetBlockIndex,
  },
  targetBlockIndex,
  targetSection,
);
assert.equal(source.slice(anchor.start, anchor.end), selectedPhrase);

const equationBlockIndex = renderedBlockIndexContaining(
  String.raw`F\left(0,0,-\frac14\right)`,
);
const equationSection = containingOriginalMarkdownSection(
  source,
  rendered,
  equationBlockIndex,
);
assert.match(equationSection.content, /^\[\n/);
assert.match(equationSection.content, /\n\]$/);
assert.match(equationSection.content, /^\[\nF\\left/m);
assert.match(equationSection.content, /# F\\left\(-1/);

assert.notEqual(
  markdownBlockRanges(source).length,
  renderedBlocks.length,
  "The fixture must retain the source/rendered block-count mismatch that caused the regression",
);

const legacyPdfSource = String.raw`<hr>

<p id="page-1" align="center"><strong>Page 1</strong></p>

# First page

Opening paragraph.

<hr>

<p id="page-2" align="center"><strong>Page 2</strong></p>

# Second page

The exact paragraph that must remain selectable after the page boundary.

$$\operatorname{Tagged}(x) = x^2 \tag{7}$$`;
const renderedPdf = normalizeMathDelimiters(legacyPdfSource, true);
assert.match(renderedPdf, /^---\n\n\*\*Page 1\*\*/);
assert.match(renderedPdf, /\n---\n\n\*\*Page 2\*\*/);
assert.match(
  renderedPdf,
  /\$\$\n\\operatorname\{Tagged\}\(x\) = x\^2 \\tag\{7\}\n\$\$/,
);

const proseWithCodeIdentifiers =
  "Use two attention heads (via num_heads=2) to obtain " +
  "a four-dimensional vector (d_out*num_heads=4).";
assert.equal(
  normalizeMathDelimiters(proseWithCodeIdentifiers, true),
  proseWithCodeIdentifiers,
  "Parenthetical prose and snake_case code expressions must not become math",
);
assert.equal(
  normalizeMathDelimiters(
    "The batch setting (batch_size=32) and keyword argument (dim=1) stay literal.",
    true,
  ),
  "The batch setting (batch_size=32) and keyword argument (dim=1) stay literal.",
  "Multi-character code identifiers must remain literal text",
);
assert.equal(
  normalizeMathDelimiters(
    "Literal parentheses stay literal: (a*b=c), (x_i, y_j), and (z_1=z_2).",
    true,
  ),
  "Literal parentheses stay literal: (a*b=c), (x_i, y_j), and (z_1=z_2).",
  "Plain parentheses must never be inferred as math delimiters",
);
assert.equal(
  normalizeMathDelimiters(
    String.raw`Explicit inline math \(a*b=c\) still renders.`,
    true,
  ),
  "Explicit inline math $a*b=c$ still renders.",
  "Explicit LaTeX inline delimiters must continue to normalize",
);
const pdfTarget =
  "The exact paragraph that must remain selectable after the page boundary.";
const pdfRenderedBlocks = markdownBlockRanges(renderedPdf);
const pdfTargetBlockIndex = pdfRenderedBlocks.findIndex((range) =>
  renderedPdf.slice(range.start, range.end).includes(pdfTarget),
);
assert.notEqual(pdfTargetBlockIndex, -1);
const pdfTargetSection = containingOriginalMarkdownSection(
  legacyPdfSource,
  renderedPdf,
  pdfTargetBlockIndex,
);
assert.equal(
  pdfTargetSection.content,
  pdfTarget,
  "Legacy PDF page markers must not shift selected source sections",
);

console.log("Source edit selection mapping invariants passed");
