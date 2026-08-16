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
  "Outside $x+1$, existing $y+1$, and display $$\nz+1\n$$.",
);

assert.equal(
  normalizeMathDelimiters(String.raw`Existing $f(\(x\))$ remains byte-for-byte intact.`),
  String.raw`Existing $f(\(x\))$ remains byte-for-byte intact.`,
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

console.log("Markdown math normalization checks passed");
