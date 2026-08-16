import assert from "node:assert/strict";
import { normalizeMathDelimiters } from "../../src/lib/markdown.ts";

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

assert.equal(
  normalizeMathDelimiters(String.raw`Code: \`\(notMath\)\`

\`\`\`tex
\[notMathEither\]
\`\`\`

But \(math\).`),
  String.raw`Code: \`\(notMath\)\`

\`\`\`tex
\[notMathEither\]
\`\`\`

But $math$.`,
);

assert.equal(
  normalizeMathDelimiters(String.raw`Already $x$ and \(y\).`),
  normalizeMathDelimiters(normalizeMathDelimiters(String.raw`Already $x$ and \(y\).`)),
);

console.log("Markdown math normalization checks passed");
