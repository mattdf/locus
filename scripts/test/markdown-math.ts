import assert from "node:assert/strict";
import katex from "katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { normalizeMathDelimiters } from "../../src/lib/markdown.ts";

function assertMarkdownMathRenders(source: string): number {
  const normalized = normalizeMathDelimiters(source, true);
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(normalized);
  let count = 0;
  visit(tree, (node) => {
    if (node.type !== "math" && node.type !== "inlineMath") return;
    count += 1;
    assert.doesNotThrow(() =>
      katex.renderToString(node.value, {
        displayMode: node.type === "math",
        strict: false,
      }),
    );
  });
  return count;
}

assert.equal(
  normalizeMathDelimiters(String.raw`Outside \(x+1\), existing $y+1$, and display \[z+1\].`),
  "Outside $x+1$, existing $y+1$, and display \n$$\nz+1\n$$\n.",
);

assert.equal(
  normalizeMathDelimiters(String.raw`Existing $f(\(x\))$ remains byte-for-byte intact.`),
  String.raw`Existing $f(\(x\))$ remains byte-for-byte intact.`,
);

assert.equal(
  normalizeMathDelimiters(String.raw`The metric tensor (g_{\mu\nu}) was omitted.`),
  String.raw`The metric tensor $g_{\mu\nu}$ was omitted.`,
);
assert.equal(
  normalizeMathDelimiters(String.raw`For the nested expression (F_{\mu}(x)), continue.`),
  String.raw`For the nested expression $F_{\mu}(x)$, continue.`,
);
assert.equal(
  normalizeMathDelimiters(String.raw`Plain prose (with no TeX command) stays prose.`),
  String.raw`Plain prose (with no TeX command) stays prose.`,
);
assert.equal(
  normalizeMathDelimiters(String.raw`Keep [the link](docs/\alpha) unchanged.`),
  String.raw`Keep [the link](docs/\alpha) unchanged.`,
);
assert.equal(
  normalizeMathDelimiters(String.raw`Keep the path (C:\Users\matt) unchanged.`),
  String.raw`Keep the path (C:\Users\matt) unchanged.`,
);
assert.equal(
  normalizeMathDelimiters(String.raw`Keep <span title="(\alpha)">HTML</span> unchanged.`),
  String.raw`Keep <span title="(\alpha)">HTML</span> unchanged.`,
);
assert.equal(
  normalizeMathDelimiters("Code: `" + String.raw`(g_{\mu\nu})` + "`."),
  "Code: `" + String.raw`(g_{\mu\nu})` + "`.",
);
assert.equal(
  normalizeMathDelimiters(String.raw`Malformed (g_{\mu) remains prose.`),
  String.raw`Malformed (g_{\mu) remains prose.`,
);
const parenthesizedCommandInsideDisplay = String.raw`$$
I_s(\mu) = \iint |x-y|^{-s} \, d\mu x \, d\mu y.
$$`;
assert.equal(
  normalizeMathDelimiters(parenthesizedCommandInsideDisplay, true),
  parenthesizedCommandInsideDisplay,
  "parenthesized TeX inside existing display math must not gain inline delimiters",
);
const malformedDelimiterBeforeParenthesizedMath = String.raw`Earlier malformed $$ marker.

$$
I_s(\mu) = \int k_s * \mu \, d\mu.
$$

The metric tensor (g_{\mu\nu}) is nondegenerate.`;
const recoveredAfterMalformedDelimiter = normalizeMathDelimiters(
  malformedDelimiterBeforeParenthesizedMath,
  true,
);
assert.match(recoveredAfterMalformedDelimiter, /I_s\(\\mu\)/);
assert.doesNotMatch(recoveredAfterMalformedDelimiter, /I_s\$\\mu\$/);
assert.match(recoveredAfterMalformedDelimiter, /\$g_\{\\mu\\nu\}\$/);

const inlineMathSplitAcrossPdfPages = String.raw`The set $A = \{x :

---

**Page 28**

20

Measure theoretic preliminaries

$\int |x-y|^{-s}\,d\mu x < M$ has positive measure.`;
const repairedPageSplit = normalizeMathDelimiters(
  inlineMathSplitAcrossPdfPages,
  true,
);
assert.match(repairedPageSplit, /The set \$A = \\\{x :\$/);
assert.equal(assertMarkdownMathRenders(inlineMathSplitAcrossPdfPages), 2);
assert.equal(
  normalizeMathDelimiters(repairedPageSplit, true),
  repairedPageSplit,
  "page-split inline math repair must be idempotent",
);
const ambiguousPageSplit = String.raw`This costs $5

---

**Page 2**

$10 per copy.`;
assert.equal(
  normalizeMathDelimiters(ambiguousPageSplit, true),
  ambiguousPageSplit,
  "currency split across pages must remain prose",
);

assert.equal(
  normalizeMathDelimiters(String.raw`$$
f(\(x\)) = x
$$`),
  String.raw`$$
f(\(x\)) = x
$$`,
);

const indentedDisplayMath = String.raw`- Householder reflector:

  $$
  H=I-2\frac{vv^\top}{v^\top v}.
  $$

- Existing inline math $\pm1$ remains outside the display.`;
assert.equal(normalizeMathDelimiters(indentedDisplayMath), indentedDisplayMath);

const protectedCodeMath = [
  "Code: `" + String.raw`\(notMath\)` + "`",
  "",
  "```tex",
  String.raw`\[notMathEither\]`,
  "```",
  "",
  String.raw`But \(math\).`,
].join("\n");
assert.equal(
  normalizeMathDelimiters(protectedCodeMath),
  protectedCodeMath.replace(String.raw`But \(math\).`, "But $math$."),
);

assert.equal(
  normalizeMathDelimiters(String.raw`Already $x$ and \(y\).`),
  normalizeMathDelimiters(normalizeMathDelimiters(String.raw`Already $x$ and \(y\).`)),
);

const multiplyTaggedArray = String.raw`$$
\begin{array}{l} \int \widehat{f}g = \int f\widehat{g}, \ f, g \in L^1(\mathbb{R}^n), \quad (\text{product formula}), \\ (\widehat{f * g}) = \widehat{f}\widehat{g}, \ f, g \in L^1(\mathbb{R}^n), \quad (\text{convolution formula}). \end{array} \tag{3.2} \tag{3.3}
$$`;
const repairedTaggedArray = normalizeMathDelimiters(multiplyTaggedArray, true);
const repairedDisplays = [...repairedTaggedArray.matchAll(/\$\$\s*([\s\S]*?)\s*\$\$/g)].map(
  (match) => match[1],
);
assert.equal(repairedDisplays.length, 2);
assert.match(repairedDisplays[0], /\\tag\{3\.2\}/);
assert.doesNotMatch(repairedDisplays[0], /\\tag\{3\.3\}/);
assert.match(repairedDisplays[1], /\\tag\{3\.3\}/);
repairedDisplays.forEach((equation) => {
  assert.doesNotThrow(() => katex.renderToString(equation, { displayMode: true, strict: false }));
});
assert.equal(
  normalizeMathDelimiters(repairedTaggedArray, true),
  repairedTaggedArray,
  "multiple-tag repair must be idempotent",
);
assert.equal(
  (
    normalizeMathDelimiters(
      `Earlier malformed OCR left an unmatched $$ marker in prose.\n\n${multiplyTaggedArray}`,
      true,
    ).match(/\\tag\{3\.[23]\}/g) ?? []
  ).length,
  2,
  "an unrelated malformed dollar marker must not hide a later display block",
);

const multiplyTaggedAligned = String.raw`$$
\begin{aligned} \int_\mathbb{R} \varrho(\lambda) \psi(2^j (\pi_\lambda(x) - \pi_\lambda(y))) \, d\lambda \\
= \int_\mathbb{R} \varrho(\lambda) \psi(2^j r \Phi(\lambda)) \varphi(C_0^{-1} \Phi(\lambda)) \, d\lambda \tag{18.18} \\
+ \int_\mathbb{R} \varrho(\lambda) \psi(2^j r \Phi(\lambda)) (1 - \varphi(C_0^{-1} \Phi(\lambda))) \, d\lambda. \tag{18.19} \end{aligned}
$$`;
const repairedTaggedAligned = normalizeMathDelimiters(multiplyTaggedAligned, true);
const repairedAlignedDisplays = [
  ...repairedTaggedAligned.matchAll(/\$\$\s*([\s\S]*?)\s*\$\$/g),
].map((match) => match[1]);
assert.equal(repairedAlignedDisplays.length, 2);
assert.match(repairedAlignedDisplays[0], /\\tag\{18\.18\}/);
assert.match(repairedAlignedDisplays[1], /\\tag\{18\.19\}/);
repairedAlignedDisplays.forEach((equation) => {
  assert.doesNotThrow(() => katex.renderToString(equation, { displayMode: true, strict: false }));
});

const adjacentDisplayMath = String.raw`Here and below $a_j$ and $b_j$ are constants.

$$
S(\mu)(u) = a_2 \int_0^\infty \cos(2\pi r u) \Sigma(\mu)(r) \, dr,$$
$$L(\mu)(u) = \sqrt{u} \int_0^\infty \sqrt{r} \Sigma(\mu)(r) K(ru) \, dr.
$$

$$
H : L^2(\mathbb{R}) \to L^2(\mathbb{R}) \quad \text{with}$$
$$\|Hf\|_2 = \|f\|_2.
$$

$$
A = B,$$ $$C = D.
$$`;
assert.equal(assertMarkdownMathRenders(adjacentDisplayMath), 8);
assert.equal(
  normalizeMathDelimiters(
    normalizeMathDelimiters(adjacentDisplayMath, true),
    true,
  ),
  normalizeMathDelimiters(adjacentDisplayMath, true),
  "adjacent display repair must be idempotent",
);

const adjacentDisplaysInCode = [
  "```tex",
  "$$A$$",
  "$$B$$ $$C$$",
  "```",
].join("\n");
assert.equal(
  normalizeMathDelimiters(adjacentDisplaysInCode, true),
  adjacentDisplaysInCode,
  "adjacent display delimiters inside code fences must be untouched",
);

const taggedMathInCode = [
  "```tex",
  String.raw`$$x \tag{1} \tag{2}$$`,
  "```",
].join("\n");
assert.equal(
  normalizeMathDelimiters(taggedMathInCode, true),
  taggedMathInCode,
  "display math inside code fences must not be rewritten",
);

const invalidNestedInlineMathDisplay = String.raw`$$
$T$ is invertible $\iff T$ is injective $\iff T$ is surjective.
$$`;
const repairedNestedInlineMathDisplay = normalizeMathDelimiters(
  invalidNestedInlineMathDisplay,
  true,
);
assert.doesNotMatch(repairedNestedInlineMathDisplay, /^\$\$/);
assert.equal(assertMarkdownMathRenders(invalidNestedInlineMathDisplay), 3);

const numberedNestedDisplay = String.raw`$$
7.15 $$\langle T^*v,v\rangle=\overline{\langle Tv,v\rangle}.$$
$$`;
const repairedNumberedDisplay = normalizeMathDelimiters(numberedNestedDisplay, true);
assert.match(repairedNumberedDisplay, /^7\.15\s+\$\$/s);
assert.equal(assertMarkdownMathRenders(numberedNestedDisplay), 1);
assert.equal(
  normalizeMathDelimiters(repairedNumberedDisplay, true),
  repairedNumberedDisplay,
  "nested display repair must be idempotent",
);

const displayImmediatelyFollowedByProse = String.raw`$$\rho(x,y)=x_1y_1$$
is symmetric and satisfies $q=q_\rho$.`;
assert.equal(assertMarkdownMathRenders(displayImmediatelyFollowedByProse), 2);

const tableMathWithVerticalBars = String.raw`| property | eigenvalues |
| --- | --- |
| unitary | $\{\lambda\in\mathbf C: |\lambda|=1\}$ |
| restriction | $T|_U$ |
| modulus | $|z|$ |`;
const repairedTableMath = normalizeMathDelimiters(tableMathWithVerticalBars, true);
assert.match(repairedTableMath, /\\vert\{\}\\lambda\\vert\{\}/);
assert.match(repairedTableMath, /T\\vert\{\}_U/);
assert.match(repairedTableMath, /\\vert\{\}z\\vert\{\}/);
assert.equal(assertMarkdownMathRenders(tableMathWithVerticalBars), 3);
const repairedTableTree = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .parse(repairedTableMath);
let repairedTableRows = 0;
visit(repairedTableTree, "tableRow", (node: any) => {
  repairedTableRows += 1;
  assert.equal(node.children.length, 2, "math bars must not create extra GFM cells");
});
assert.equal(repairedTableRows, 4);

const protectedBrokenShapes = [
  "```tex",
  "$$",
  "$T$ remains literal inside code.",
  "$$",
  "5.25 $$x=y$$",
  "| $|z|$ |",
  "```",
].join("\n");
assert.equal(
  normalizeMathDelimiters(protectedBrokenShapes, true),
  protectedBrokenShapes,
  "nested displays and table pipes inside fenced code must remain untouched",
);

const parentheticalContainingExistingMath = String.raw`A rotation (with the angle \(\theta\) fixed) preserves length.`;
const normalizedParenthetical = normalizeMathDelimiters(
  parentheticalContainingExistingMath,
  true,
);
assert.equal(
  normalizedParenthetical,
  String.raw`A rotation (with the angle $\theta$ fixed) preserves length.`,
  "ordinary parentheses containing TeX math must not become nested math",
);
assert.equal(assertMarkdownMathRenders(parentheticalContainingExistingMath), 1);

const inlineBracketDisplay = String.raw`The result is \[x^2+y^2=z^2\] (1.2).`;
assert.equal(assertMarkdownMathRenders(inlineBracketDisplay), 1);
assert.equal(
  normalizeMathDelimiters(
    normalizeMathDelimiters(inlineBracketDisplay, true),
    true,
  ),
  normalizeMathDelimiters(inlineBracketDisplay, true),
  "slash-delimited display normalization must be idempotent",
);

const strayDisplayMarker = String.raw`OCR left a $$ marker in prose.

$$
I_s(\mu)=\int k_s\,d\mu.
$$`;
assert.match(
  normalizeMathDelimiters(strayDisplayMarker, true),
  /\$\$ marker in prose[\s\S]*\$\$\nI_s\(\\mu\)/,
  "a stray display marker must not steal a later display opener",
);
assert.equal(assertMarkdownMathRenders(strayDisplayMarker), 1);

const prosePageMisclassifiedAsSql = String.raw`---

**Page 20**

\`\`\`sql
where $n,m=1,2,3$ and the vectors form an orthonormal basis. Any vector in the space can be written as a superposition of them. Therefore the resulting expression is independent of the chosen coordinates.
\`\`\`

---

**Page 21**

Ordinary prose.`;
const repairedProsePage = normalizeMathDelimiters(
  prosePageMisclassifiedAsSql,
  true,
);
assert.doesNotMatch(repairedProsePage, /```sql/);
assert.equal(assertMarkdownMathRenders(prosePageMisclassifiedAsSql), 1);

const genuineSqlPage = String.raw`---

**Page 1**

\`\`\`sql
SELECT users.id, users.name
FROM users
JOIN accounts ON accounts.user_id = users.id;
SELECT count(*)
FROM accounts;
\`\`\`

---

**Page 2**

Text.`;
assert.equal(
  normalizeMathDelimiters(genuineSqlPage, true),
  genuineSqlPage,
  "a genuine full-page SQL listing must remain fenced",
);

const indentedOcrEquation = String.raw`The second term contains

    $\Gamma^\lambda_{\mu\nu}=0$

but this code stays:

    const answer = 42;`;
const repairedIndentedEquation = normalizeMathDelimiters(indentedOcrEquation, true);
assert.match(repairedIndentedEquation, /^\$\\Gamma/m);
assert.match(repairedIndentedEquation, /^    const answer/m);
assert.equal(assertMarkdownMathRenders(indentedOcrEquation), 1);

const incompleteAlignedEnvironment = String.raw`$$
{\begin{alignedat}{2}|A\rangle &=& \mathbf 1|A\rangle \\ &=& \sum_i |i\rangle A^i.
$$`;
assert.equal(assertMarkdownMathRenders(incompleteAlignedEnvironment), 1);
assert.match(
  normalizeMathDelimiters(incompleteAlignedEnvironment, true),
  /\\end\{alignedat\}\}\n\$\$/,
);

const duplicatedPhantomScripts = String.raw`The OCR result was $\Gamma^{\lambda}_{\phantom{\lambda}}_{\phantom{\mu\nu}}_{\phantom{\mu\nu}}=0$.`;
const repairedPhantomScripts = normalizeMathDelimiters(
  duplicatedPhantomScripts,
  true,
);
assert.match(repairedPhantomScripts, /\\Gamma\^\{\\lambda\}_\{\\mu\\nu\}=0/);
assert.equal(assertMarkdownMathRenders(duplicatedPhantomScripts), 1);

const primedCommandWithSuperscript = String.raw`$$
\Gamma'_{\mu\nu}^{\lambda}=\Lambda_\rho^{\lambda'}.
$$`;
assert.match(
  normalizeMathDelimiters(primedCommandWithSuperscript, true),
  /\{\\Gamma'\}_\{\\mu\\nu\}\^\{\\lambda\}/,
);
assert.equal(assertMarkdownMathRenders(primedCommandWithSuperscript), 1);

const missingGroupBeforeRight = String.raw`$\left({\frac{x}{y}\right)$`;
assert.equal(assertMarkdownMathRenders(missingGroupBeforeRight), 1);
assert.match(
  normalizeMathDelimiters(missingGroupBeforeRight, true),
  /\\frac\{x\}\{y\}\}\\right/,
);

const missingOuterAlignedEnd = String.raw`$$
\begin{aligned}
& x=1 \\
& \begin{aligned} y&=2 \\ z&=3 \end{aligned}
\tag{7.35}
$$`;
assert.equal(assertMarkdownMathRenders(missingOuterAlignedEnd), 1);
assert.match(
  normalizeMathDelimiters(missingOuterAlignedEnd, true),
  /\\end\{aligned\}\\tag\{7\.35\}/,
);

console.log("Markdown math normalization checks passed");
