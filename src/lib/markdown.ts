import {
  mapMarkdownMathBodies,
  mapOutsideMarkdownCode,
  mapMarkdownPlainText,
  normalizeSlashMathDelimiters,
  unwrapMisclassifiedIndentedPdfMath,
  unwrapMisclassifiedPdfPageFences,
} from "./markdownScanner";

function scriptArgumentEnd(source: string, start: number): number {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] !== "{") {
    if (source[cursor] === "\\") {
      cursor += 1;
      while (/[A-Za-z@]/.test(source[cursor] ?? "")) cursor += 1;
      return cursor;
    }
    return Math.min(source.length, cursor + 1);
  }
  let depth = 1;
  cursor += 1;
  while (cursor < source.length && depth > 0) {
    if (!escapedAt(source, cursor)) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
    }
    cursor += 1;
  }
  return cursor;
}

function hasExplicitSuperscriptAfterPrime(source: string, start: number): boolean {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  while (source[cursor] === "_") {
    cursor = scriptArgumentEnd(source, cursor + 1);
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  return source[cursor] === "^";
}

function groupPrimedCommandWithLaterSuperscript(source: string): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (let cursor = 0; cursor < source.length - 2; cursor += 1) {
    if (source[cursor] !== "\\" || escapedAt(source, cursor)) continue;
    let commandEnd = cursor + 1;
    while (/[A-Za-z@]/.test(source[commandEnd] ?? "")) commandEnd += 1;
    if (commandEnd === cursor + 1 || source[commandEnd] !== "'") continue;
    if (!hasExplicitSuperscriptAfterPrime(source, commandEnd + 1)) continue;
    replacements.push({
      start: cursor,
      end: commandEnd + 1,
      value: `{${source.slice(cursor, commandEnd)}'}`,
    });
    cursor = commandEnd;
  }
  if (!replacements.length) return source;
  const output: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    output.push(source.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  output.push(source.slice(cursor));
  return output.join("");
}

function closeBracesBeforeRightDelimiters(source: string): string {
  const output: string[] = [];
  const leftDepths: number[] = [];
  let braceDepth = 0;
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("\\left", cursor) && !escapedAt(source, cursor)) {
      leftDepths.push(braceDepth);
      output.push("\\left");
      cursor += 5;
      continue;
    }
    if (source.startsWith("\\right", cursor) && !escapedAt(source, cursor)) {
      const expectedDepth = leftDepths.pop();
      if (expectedDepth !== undefined && braceDepth > expectedDepth) {
        output.push("}".repeat(braceDepth - expectedDepth));
        braceDepth = expectedDepth;
      }
      output.push("\\right");
      cursor += 6;
      continue;
    }
    const character = source[cursor];
    if (!escapedAt(source, cursor)) {
      if (character === "{") braceDepth += 1;
      else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
    output.push(character);
    cursor += 1;
  }
  return output.join("");
}

function closeUnclosedLatexEnvironments(source: string): string {
  const stack: string[] = [];
  for (const match of source.matchAll(/\\(begin|end)\{([A-Za-z*]+)\}/g)) {
    if (match[1] === "begin") {
      stack.push(match[2]);
      continue;
    }
    if (stack.at(-1) === match[2]) stack.pop();
  }
  if (!stack.length) return source;
  const closers = stack.reverse().map((name) => `\\end{${name}}`).join("");
  const tags = latexTags(source);
  const trailingTag = tags.find(
    (tag) => !source.slice(tag.end).trim(),
  );
  const insertAt = trailingTag?.start ?? source.length;
  return `${source.slice(0, insertAt)}${closers}${source.slice(insertAt)}`;
}

function appendMissingLatexBraces(source: string): string {
  let depth = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (escapedAt(source, cursor)) continue;
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") depth = Math.max(0, depth - 1);
  }
  return depth > 0 ? source + "}".repeat(depth) : source;
}

function repairLatexBody(source: string): string {
  let repaired = source.replace(
    /(?:_\{\\phantom\{([^{}]*)\}\}){2,}/g,
    (_match, finalSubscript: string) => `_{${finalSubscript}}`,
  );
  repaired = groupPrimedCommandWithLaterSuperscript(repaired);
  repaired = closeBracesBeforeRightDelimiters(repaired);
  repaired = closeUnclosedLatexEnvironments(repaired);
  return appendMissingLatexBraces(repaired);
}

function repairLatexMathBodies(markdown: string): string {
  return mapMarkdownMathBodies(markdown, repairLatexBody);
}

function cleanCopiedDisplayMath(equation: string): string {
  const lines: string[] = [];

  for (const sourceLine of equation.trim().split(/\r?\n/)) {
    const trimmed = sourceLine.trim();
    if (!trimmed) continue;

    // Copying rendered ChatGPT math can turn a single relation sign into a
    // horizontal run of equals characters.
    if (/^={2,}$/.test(trimmed)) {
      lines.push("=");
      continue;
    }

    // The same clipboard representation occasionally emits the second equals
    // sign in a chained equation as a Markdown heading marker.
    if (/^#\s+/.test(trimmed)) {
      lines.push(trimmed.replace(/^#\s+/, ""), "=");
      continue;
    }

    let line = sourceLine
      .replace(/\*\{([^{}\n]+)\}/g, "_{$1}")
      .replace(/\\(left|right)([{}])/g, "\\$1\\$2");
    const trailingSlashes = line.match(/\\+$/)?.[0].length ?? 0;
    if (trailingSlashes % 2 === 1) line += "\\";
    lines.push(line);
  }

  return lines.join("\n");
}

function normalizeCopiedBracketDisplayBlocks(markdown: string): string {
  return mapOutsideMarkdownCode(markdown, (prose) => {
    const lines = prose.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
    const output: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const content = lines[index].replace(/\r?\n$/, "");
      const opening = /^([ \t]*)\\?\[[ \t]*$/.exec(content);
      if (!opening) {
        output.push(lines[index]);
        continue;
      }

      let closingIndex = index + 1;
      while (closingIndex < lines.length) {
        const candidate = lines[closingIndex].replace(/\r?\n$/, "");
        if (/^[ \t]*\\?\][ \t]*$/.test(candidate)) break;
        if (
          /^---[ \t]*$/.test(candidate) ||
          /^\*\*Page\s+\d+\*\*[ \t]*$/.test(candidate)
        ) {
          closingIndex = lines.length;
          break;
        }
        closingIndex += 1;
      }
      if (closingIndex >= lines.length) {
        output.push(lines[index]);
        continue;
      }

      const body = lines.slice(index + 1, closingIndex).join("");
      // A standalone bracketed prose aside is legal Markdown. Recover the
      // copied-display form only when its body carries strong TeX/equation
      // syntax; otherwise preserve it exactly.
      if (!/[\\_^=]|\b(?:frac|begin|end|det|sum|int)\b/.test(body)) {
        output.push(lines[index]);
        continue;
      }
      const ending = lines[closingIndex].match(/\r?\n$/)?.[0] ?? "";
      output.push(
        `${opening[1]}$$\n${cleanCopiedDisplayMath(body)}\n${opening[1]}$$${ending}`,
      );
      index = closingIndex;
    }
    return output.join("");
  });
}

function normalizeLegacyPdfMarkup(markdown: string): string {
  return markdown
    .replace(
      /<hr\s*\/?>\s*\n+\s*<p\b[^>]*\bid=["']page-(\d+)["'][^>]*>\s*<strong>\s*Page\s+\1\s*<\/strong>\s*<\/p>/gi,
      (_match, pageNumber: string) => `---\n\n**Page ${pageNumber}**`,
    )
    .replace(
      /<p\b[^>]*\balign=["']center["'][^>]*>\s*<img\b([^>]*)\/?>\s*<\/p>/gi,
      (_match, attributes: string) => {
        const source = attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1];
        if (!source) return _match;
        const alt = attributes.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
        return `![${alt}](${source})`;
      },
    );
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function containsUnescapedDollar(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "$" && !escapedAt(source, index)) return true;
  }
  return false;
}

function closingDollar(
  source: string,
  start: number,
  delimiter: "$" | "$$",
): number {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (delimiter === "$" && source[cursor] === "\n") return -1;
    if (!source.startsWith(delimiter, cursor) || escapedAt(source, cursor)) continue;
    if (delimiter === "$" && (source[cursor - 1] === "$" || source[cursor + 1] === "$")) {
      continue;
    }
    return cursor;
  }
  return -1;
}

function closingInlineCode(source: string, start: number, runLength: number): number {
  const marker = "`".repeat(runLength);
  const closing = source.indexOf(marker, start + runLength);
  if (closing < 0) return -1;
  const newline = source.indexOf("\n", start + runLength);
  return newline >= 0 && closing > newline ? -1 : closing;
}

/**
 * Applies a Markdown repair only to prose. Existing code and dollar-delimited
 * math are copied verbatim so delimiter recovery is idempotent and can never
 * inject a `$` into a region that remark-math already considers math.
 */
function mapMarkdownProse(
  markdown: string,
  transform: (source: string) => string,
): string {
  return mapMarkdownPlainText(markdown, transform);
}

interface ParenthesizedLatexRange {
  start: number;
  end: number;
}

function balancedLatexBraces(source: string): boolean {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (escapedAt(source, index)) continue;
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function looksLikeNonLatexPath(source: string): boolean {
  return (
    /(?:^|[\s(])[a-z]:\\/i.test(source) ||
    /(?:^|[\s(])\\\\[^\\\s]+\\/.test(source) ||
    /(?:https?|file):/i.test(source)
  );
}

/**
 * OCR frequently leaves inline math in ordinary parentheses, for example
 * `(g_{\\mu\\nu})`. Recover only balanced, single-line parenthetical spans
 * containing a named TeX command. The caller runs this on prose segments, so
 * existing math and code have already been excluded.
 */
function wrapParenthesizedLatex(source: string): string {
  const stack: Array<{ start: number; protected: boolean }> = [];
  const candidates: ParenthesizedLatexRange[] = [];
  let inHtmlTag = false;
  let htmlQuote: "\"" | "'" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n" || character === "\r") {
      stack.length = 0;
      inHtmlTag = false;
      htmlQuote = null;
      continue;
    }

    // Existing TeX inline delimiters are converted after this scan. Treat the
    // complete region as protected now so ordinary function parentheses
    // inside `\(...\)` are never mistaken for missing delimiters themselves.
    if (
      character === "\\" &&
      source[index + 1] === "(" &&
      !escapedAt(source, index)
    ) {
      let closing = index + 2;
      let foundClosing = false;
      while (closing < source.length && source[closing] !== "\n") {
        if (
          source[closing] === "\\" &&
          source[closing + 1] === ")" &&
          !escapedAt(source, closing)
        ) {
          index = closing + 1;
          foundClosing = true;
          break;
        }
        closing += 1;
      }
      if (foundClosing) continue;
    }

    if (inHtmlTag) {
      if (htmlQuote) {
        if (character === htmlQuote && !escapedAt(source, index)) htmlQuote = null;
      } else if (character === "\"" || character === "'") {
        htmlQuote = character;
      } else if (character === ">") {
        inHtmlTag = false;
      }
      continue;
    }
    if (
      character === "<" &&
      /[A-Za-z!/?]/.test(source[index + 1] ?? "")
    ) {
      inHtmlTag = true;
      continue;
    }

    if (character === "(" && !escapedAt(source, index)) {
      const parentProtected = stack.some((entry) => entry.protected);
      stack.push({
        start: index,
        protected: parentProtected || source[index - 1] === "]",
      });
      continue;
    }
    if (character !== ")" || escapedAt(source, index) || stack.length === 0) {
      continue;
    }

    const opening = stack.pop()!;
    if (opening.protected) continue;
    const content = source.slice(opening.start + 1, index);
    if (
      /\\[A-Za-z@]+\*?/.test(content) &&
      balancedLatexBraces(content) &&
      !looksLikeNonLatexPath(content)
    ) {
      candidates.push({ start: opening.start, end: index });
    }
  }

  if (!candidates.length) return source;
  const selected: ParenthesizedLatexRange[] = [];
  candidates
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .forEach((candidate) => {
      if (
        selected.some(
          (range) => range.start <= candidate.start && range.end >= candidate.end,
        )
      ) {
        return;
      }
      selected.push(candidate);
    });

  const output: string[] = [];
  let cursor = 0;
  selected.forEach((range) => {
    output.push(
      source.slice(cursor, range.start),
      `$${source.slice(range.start + 1, range.end)}$`,
    );
    cursor = range.end + 1;
  });
  output.push(source.slice(cursor));
  return output.join("");
}

function unmatchedInlineDollar(line: string): number {
  let candidate = -1;
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (line[cursor] === "`" && !escapedAt(line, cursor)) {
      let runLength = 1;
      while (line[cursor + runLength] === "`") runLength += 1;
      const closing = closingInlineCode(line, cursor, runLength);
      if (closing >= 0) {
        cursor = closing + runLength - 1;
        continue;
      }
    }
    if (line[cursor] !== "$" || escapedAt(line, cursor)) continue;
    if (line[cursor + 1] === "$" || line[cursor - 1] === "$") {
      cursor += line[cursor + 1] === "$" ? 1 : 0;
      continue;
    }
    const closing = closingDollar(line, cursor + 1, "$");
    if (closing >= 0) {
      cursor = closing;
      continue;
    }
    candidate = cursor;
  }
  return candidate;
}

function looksLikeInlineMathFragment(source: string): boolean {
  const value = source.trim();
  if (value.length < 2 || /^\d+(?:[.,]\d+)?$/.test(value)) return false;
  return (
    /\\(?:[A-Za-z@]+\*?|[{}])/.test(value) ||
    /[_^=<>]|[≤≥≠∈∉⊂⊆→↦∞]/u.test(value)
  );
}

/**
 * PDF OCR can split one inline expression across physical pages. In the
 * combined Markdown the opening `$` then precedes a page marker while the
 * continuation begins with the `$` that originally closed the expression.
 *
 * Repair only the unambiguous form: the unmatched opener is on the previous
 * page's final content line, both fragments look mathematical, and the next
 * page's leading fragment has its own same-line closing `$`. We add a closing
 * delimiter before the page marker and reinterpret the existing next-page
 * delimiter as an opener. Ambiguous page breaks remain byte-for-byte intact.
 */
function repairInlineMathAcrossPdfPageBreaks(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const inFence: boolean[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  lines.forEach((line, index) => {
    const content = line.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    inFence[index] = fence !== null;
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.length) {
        fence = null;
      }
    } else if (marker) {
      fence = { marker: marker[0] as "`" | "~", length: marker.length };
      inFence[index] = true;
    }
  });

  for (let markerIndex = 0; markerIndex < lines.length; markerIndex += 1) {
    if (!/^[ \t]*---[ \t]*(?:\r?\n)?$/.test(lines[markerIndex])) continue;
    let pageLabelIndex = markerIndex + 1;
    while (pageLabelIndex < lines.length && !lines[pageLabelIndex].trim()) {
      pageLabelIndex += 1;
    }
    if (!/^\*\*Page\s+\d+\*\*$/.test(lines[pageLabelIndex]?.trim() ?? "")) {
      continue;
    }

    let previousIndex = markerIndex - 1;
    while (previousIndex >= 0 && !lines[previousIndex].trim()) previousIndex -= 1;
    if (previousIndex < 0 || inFence[previousIndex]) continue;
    const previousEnding = lines[previousIndex].match(/\r?\n$/)?.[0] ?? "";
    const previousContent = lines[previousIndex].slice(
      0,
      lines[previousIndex].length - previousEnding.length,
    );
    const opening = unmatchedInlineDollar(previousContent);
    if (
      opening < 0 ||
      !looksLikeInlineMathFragment(previousContent.slice(opening + 1))
    ) {
      continue;
    }

    let nextIndex = pageLabelIndex + 1;
    let nonemptyLines = 0;
    let continuationFound = false;
    while (nextIndex < lines.length && nonemptyLines < 8) {
      const nextContent = lines[nextIndex].replace(/\r?\n$/, "");
      const trimmed = nextContent.trim();
      if (/^---$/.test(trimmed) || /^\*\*Page\s+\d+\*\*$/.test(trimmed)) break;
      if (trimmed) {
        nonemptyLines += 1;
        if (trimmed.startsWith("$") && !trimmed.startsWith("$$")) {
          const closing = closingDollar(trimmed, 1, "$");
          if (
            closing > 1 &&
            looksLikeInlineMathFragment(trimmed.slice(1, closing))
          ) {
            continuationFound = true;
          }
          break;
        }
      }
      nextIndex += 1;
    }
    if (!continuationFound) continue;

    const trailingWhitespace = previousContent.match(/[ \t]*$/)?.[0] ?? "";
    lines[previousIndex] =
      previousContent.slice(0, previousContent.length - trailingWhitespace.length) +
      "$" +
      trailingWhitespace +
      previousEnding;
  }

  return lines.join("");
}

function normalizeCopiedInlineMath(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const normalizeLine = (line: string) =>
    mapMarkdownProse(line, (source) =>
      wrapParenthesizedLatex(source).replace(
        /\\\((.*?)\\\)/g,
        (_match, equation: string) => `$${equation}$`,
      ),
    );

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const content = line.replace(/\r?\n$/, "");
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) {
      output.push(line);
      if (
        fenceMarker?.[0] === fence.marker &&
        fenceMarker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      fence = {
        marker: fenceMarker[0] as "`" | "~",
        length: fenceMarker.length,
      };
      output.push(line);
      continue;
    }

    if (/^[ \t]*\$\$[ \t]*$/.test(content)) {
      let closingIndex = -1;
      let boundaryIndex = lines.length;
      for (let candidate = index + 1; candidate < boundaryIndex; candidate += 1) {
        const candidateContent = lines[candidate].replace(/\r?\n$/, "");
        if (/^[ \t]*\$\$[ \t]*$/.test(candidateContent)) {
          closingIndex = candidate;
          break;
        }
        // A blank line terminates an ambiguous OCR region. Never let one
        // unmatched delimiter change how the rest of a book is classified.
        if (!candidateContent.trim()) {
          boundaryIndex = candidate;
          break;
        }
      }
      const protectedEnd = closingIndex >= 0 ? closingIndex : boundaryIndex - 1;
      output.push(...lines.slice(index, Math.max(index, protectedEnd) + 1));
      index = Math.max(index, protectedEnd);
      continue;
    }

    output.push(normalizeLine(line));
  }
  return output.join("");
}

/**
 * remark-math treats consecutive display blocks as one block unless Markdown
 * gives them a blank-line boundary. OCR commonly emits either `$$\n$$` or
 * `$$ $$` between two equations, which leaves a literal `$` inside the math
 * node and makes KaTeX fail with “Can't use function '$' in math mode”.
 *
 * Normalize only outside fenced code. This changes delimiter whitespace, not
 * equation contents, and is idempotent once the blank line exists.
 */
function separateAdjacentDisplayBlocks(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let prose: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  const flushProse = () => {
    if (prose.length === 0) return;
    let source = prose.join("");
    let previous: string;
    do {
      previous = source;
      source = source.replace(
        /([^$\r\n])\$\$([ \t]*(?:\r?\n[ \t]*)?)\$\$([^$\r\n])/g,
        (match, before: string, gap: string, after: string, offset: number) => {
          // Two delimiter pairs separated by at most one line break are a
          // closing display followed by an opening display. Put both fences
          // on their own lines so remark-math cannot absorb the second pair.
          const newline = gap.includes("\r\n") ? "\r\n" : "\n";
          const lineStart = source.lastIndexOf("\n", offset) + 1;
          const currentIndent = source.slice(lineStart).match(/^[ \t]*/)?.[0] ?? "";
          const nextIndent = gap.match(/\r?\n([ \t]*)$/)?.[1] ?? currentIndent;
          return [
            before,
            newline,
            `${currentIndent}$$`,
            newline,
            newline,
            `${nextIndent}$$`,
            newline,
            nextIndent,
            after,
          ].join("");
        },
      );
    } while (source !== previous);

    const separatedLines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
    for (let index = 0; index < separatedLines.length; index += 1) {
      const line = separatedLines[index];
      output.push(line);
      const ending = line.match(/\r?\n$/)?.[0] ?? "";
      const content = line.slice(0, line.length - ending.length);
      const nextContent = separatedLines[index + 1]?.replace(/\r?\n$/, "") ?? "";
      if (
        ending &&
        /^[ \t]*\$\$[ \t]*$/.test(content) &&
        /^[ \t]*\$\$[ \t]*$/.test(nextContent)
      ) {
        output.push(ending);
      }
    }
    prose = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const content = line.replace(/\r?\n$/, "");
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];

    if (fence) {
      output.push(line);
      if (
        fenceMarker?.[0] === fence.marker &&
        fenceMarker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      flushProse();
      fence = {
        marker: fenceMarker[0] as "`" | "~",
        length: fenceMarker.length,
      };
      output.push(line);
      continue;
    }
    prose.push(line);
  }

  flushProse();
  return output.join("");
}

/**
 * The OCR layout API occasionally marks mixed prose/inline-math as an
 * equation. Older imports consequently contain an invalid outer display such
 * as `$$\n$T$ is invertible ...\n$$`. Remove only outer display fences whose
 * body contains another unescaped dollar delimiter. A valid TeX display never
 * contains nested dollar math, so this repair is unambiguous.
 */
function unwrapInvalidNestedDisplayBlocks(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].replace(/\r?\n$/, "");
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) {
      output.push(lines[index]);
      if (
        fenceMarker?.[0] === fence.marker &&
        fenceMarker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      fence = {
        marker: fenceMarker[0] as "`" | "~",
        length: fenceMarker.length,
      };
      output.push(lines[index]);
      continue;
    }

    if (/^[ \t]*\$\$[ \t]*$/.test(content)) {
      let closingIndex = index + 1;
      let ambiguousBoundary = false;
      while (closingIndex < lines.length) {
        const closing = lines[closingIndex].replace(/\r?\n$/, "");
        if (/^[ \t]*\$\$[ \t]*$/.test(closing)) break;
        if (!closing.trim()) {
          ambiguousBoundary = true;
          break;
        }
        // OCR also emits adjacent displays as `formula$$` followed by
        // `$$formula`. A lone same-line delimiter is a boundary, not evidence
        // that this entire multi-equation region is one nested wrapper.
        if (closing.includes("$$") && !inlineDisplayPair(closing, 0)) {
          ambiguousBoundary = true;
          break;
        }
        // A Markdown code fence cannot legally occur inside a TeX display.
        // Treat it as a boundary instead of allowing a malformed `$` to make
        // us unwrap unrelated content later in the document.
        if (/^ {0,3}(`{3,}|~{3,})/.test(closing)) {
          closingIndex = lines.length;
          break;
        }
        closingIndex += 1;
      }
      if (!ambiguousBoundary && closingIndex < lines.length) {
        const body = lines.slice(index + 1, closingIndex).join("");
        if (containsUnescapedDollar(body)) {
          output.push(...lines.slice(index + 1, closingIndex));
          index = closingIndex;
          continue;
        }
      }
    }

    output.push(lines[index]);
  }
  return output.join("");
}

function inlineDisplayPair(
  source: string,
  start: number,
): { opening: number; closing: number } | null {
  for (let cursor = start; cursor < source.length - 1; cursor += 1) {
    if (source[cursor] === "`") {
      let runLength = 1;
      while (source[cursor + runLength] === "`") runLength += 1;
      const closing = closingInlineCode(source, cursor, runLength);
      if (closing >= 0) {
        cursor = closing + runLength - 1;
        continue;
      }
    }
    if (!source.startsWith("$$", cursor) || escapedAt(source, cursor)) continue;
    for (let closing = cursor + 2; closing < source.length - 1; closing += 1) {
      if (!source.startsWith("$$", closing) || escapedAt(source, closing)) continue;
      if (source.slice(cursor + 2, closing).trim()) {
        return { opening: cursor, closing };
      }
      cursor = closing + 1;
      break;
    }
  }
  return null;
}

/**
 * remark-math requires display delimiters to form their own block. Mistral
 * sometimes emits `7.15 $$equation$$` or a one-line `$$equation$$` followed
 * immediately by prose. Canonicalize those paired delimiters to fenced display
 * blocks while leaving inline code and fenced code byte-for-byte intact.
 */
function canonicalizeInlineDisplayBlocks(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  const pushBlank = (ending: string) => {
    if (output.length === 0 || output.at(-1)?.trim()) output.push(ending || "\n");
  };

  for (const line of lines) {
    const ending = line.match(/\r?\n$/)?.[0] ?? "";
    const content = line.slice(0, line.length - ending.length);
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) {
      output.push(line);
      if (
        fenceMarker?.[0] === fence.marker &&
        fenceMarker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      fence = {
        marker: fenceMarker[0] as "`" | "~",
        length: fenceMarker.length,
      };
      output.push(line);
      continue;
    }
    // Display math is not valid inside a GFM table cell. Leave such rows to
    // the table-specific inline-math protection below.
    if (/^[ \t]*\|.*\|[ \t]*$/.test(content)) {
      output.push(line);
      continue;
    }

    const firstPair = inlineDisplayPair(content, 0);
    if (!firstPair) {
      output.push(line);
      continue;
    }

    const indent = content.match(/^[ \t]*/)?.[0] ?? "";
    let cursor = 0;
    let pair: { opening: number; closing: number } | null = firstPair;
    while (pair) {
      const prefix = content.slice(cursor, pair.opening).trim();
      if (prefix) {
        output.push(`${indent}${prefix}${ending || "\n"}`);
        pushBlank(ending);
      }
      const body = content.slice(pair.opening + 2, pair.closing).trim();
      output.push(`${indent}$$${ending || "\n"}`);
      output.push(`${indent}${body}${ending || "\n"}`);
      output.push(`${indent}$$${ending || "\n"}`);
      cursor = pair.closing + 2;
      pair = inlineDisplayPair(content, cursor);
      // A display block must be separated from subsequent prose/list items.
      // Always add that boundary; an existing following blank line merely
      // remains an additional harmless Markdown blank and the transform stays
      // idempotent once the display is canonicalized.
      pushBlank(ending);
    }
    const suffix = content.slice(cursor).trim();
    if (suffix) output.push(`${indent}${suffix}${ending}`);
  }
  return output.join("");
}

/**
 * An unescaped `|` inside `$...$` is TeX, but remark-gfm sees it first and
 * treats it as a table-cell separator. On actual table rows only, spell such
 * bars as `\vert`, which preserves their mathematical meaning and prevents
 * GFM from splitting the expression. Structural table pipes and code are not
 * touched.
 */
function protectMathPipesInGfmTables(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const ending = line.match(/\r?\n$/)?.[0] ?? "";
    const content = line.slice(0, line.length - ending.length);
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) {
      output.push(line);
      if (
        fenceMarker?.[0] === fence.marker &&
        fenceMarker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      fence = {
        marker: fenceMarker[0] as "`" | "~",
        length: fenceMarker.length,
      };
      output.push(line);
      continue;
    }
    if (!/^[ \t]*\|.*\|[ \t]*$/.test(content)) {
      output.push(line);
      continue;
    }

    const replacements: string[] = [];
    let cursor = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] !== "$" || escapedAt(content, index)) continue;
      if (content[index + 1] === "$" || content[index - 1] === "$") continue;
      const closing = closingDollar(content, index + 1, "$");
      if (closing < 0) continue;
      const body = content.slice(index + 1, closing);
      let repaired = "";
      for (let bodyIndex = 0; bodyIndex < body.length; bodyIndex += 1) {
        repaired +=
          body[bodyIndex] === "|" && !escapedAt(body, bodyIndex)
            ? "\\vert{}"
            : body[bodyIndex];
      }
      replacements.push(content.slice(cursor, index + 1), repaired, "$");
      cursor = closing + 1;
      index = closing;
    }
    replacements.push(content.slice(cursor));
    output.push(replacements.join("") + ending);
  }
  return output.join("");
}

interface LatexTag {
  start: number;
  end: number;
  value: string;
  starred: boolean;
}

function latexTags(source: string): LatexTag[] {
  const tags: LatexTag[] = [];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (!source.startsWith("\\tag", cursor) || escapedAt(source, cursor)) continue;
    let brace = cursor + 4;
    const starred = source[brace] === "*";
    if (starred) brace += 1;
    while (/\s/.test(source[brace] ?? "")) brace += 1;
    if (source[brace] !== "{") continue;
    let depth = 1;
    let end = brace + 1;
    while (end < source.length && depth > 0) {
      if (!escapedAt(source, end)) {
        if (source[end] === "{") depth += 1;
        else if (source[end] === "}") depth -= 1;
      }
      end += 1;
    }
    if (depth !== 0) continue;
    tags.push({
      start: cursor,
      end,
      value: source.slice(brace + 1, end - 1),
      starred,
    });
    cursor = end - 1;
  }
  return tags;
}

function splitLatexRows(source: string): string[] {
  const rows: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let environmentDepth = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source.startsWith("\\begin{", cursor)) {
      environmentDepth += 1;
      continue;
    }
    if (source.startsWith("\\end{", cursor)) {
      environmentDepth = Math.max(0, environmentDepth - 1);
      continue;
    }
    if (!escapedAt(source, cursor)) {
      if (source[cursor] === "{") braceDepth += 1;
      else if (source[cursor] === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
    if (
      braceDepth === 0 &&
      environmentDepth === 0 &&
      source[cursor] === "\\" &&
      source[cursor + 1] === "\\"
    ) {
      rows.push(source.slice(start, cursor).trim());
      cursor += 1;
      if (source[cursor + 1] === "[") {
        const optionEnd = source.indexOf("]", cursor + 2);
        if (optionEnd >= 0) cursor = optionEnd;
      }
      start = cursor + 1;
    }
  }
  rows.push(source.slice(start).trim());
  return rows.filter(Boolean);
}

function splitTaggedEnvironment(
  equation: string,
  tags: LatexTag[],
): string[] | null {
  const outer = equation.match(
    /^\\begin\{(array|aligned|gathered|alignedat)\}(\{[^{}]*\})?([\s\S]*)\\end\{\1\}$/,
  );
  if (!outer) return null;
  const [, environment, argument = "", body] = outer;
  const rows = splitLatexRows(body);
  if (rows.length !== tags.length) return null;
  return rows.map((row, index) => {
    const tag = tags[index];
    return [
      "$$",
      `\\begin{${environment}}${argument}`,
      row,
      `\\end{${environment}} \\tag${tag.starred ? "*" : ""}{${tag.value}}`,
      "$$",
    ].join("\n");
  });
}

function splitInlineTaggedEnvironment(
  equation: string,
  tags: LatexTag[],
): string[] | null {
  const outer = equation.match(
    /^\\begin\{(array|aligned|gathered|alignedat)\}(\{[^{}]*\})?([\s\S]*)\\end\{\1\}$/,
  );
  if (!outer) return null;
  const [, environment, argument = "", body] = outer;
  const rows = splitLatexRows(body);
  if (rows.length < tags.length) return null;

  const groups: Array<{ rows: string[]; tag: LatexTag }> = [];
  let pendingRows: string[] = [];
  for (const row of rows) {
    const rowTags = latexTags(row);
    if (rowTags.length > 1) return null;
    pendingRows.push(row);
    if (rowTags.length === 0) continue;

    const tag = rowTags[0];
    pendingRows[pendingRows.length - 1] =
      row.slice(0, tag.start) + row.slice(tag.end);
    groups.push({ rows: pendingRows, tag });
    pendingRows = [];
  }

  if (groups.length !== tags.length || pendingRows.some((row) => row.trim())) {
    return null;
  }

  return groups.map(({ rows: groupedRows, tag }) => [
    "$$",
    `\\begin{${environment}}${argument}`,
    groupedRows.join(" \\\\\n"),
    `\\end{${environment}} \\tag${tag.starred ? "*" : ""}{${tag.value}}`,
    "$$",
  ].join("\n"));
}

function repairMultipleDisplayTags(display: string): string {
  const body = display.slice(2, -2);
  const tags = latexTags(body);
  if (tags.length < 2) return display;

  const inlineSplit = splitInlineTaggedEnvironment(body.trim(), tags);
  if (inlineSplit) return inlineSplit.join("\n\n");

  const firstTag = tags[0];
  const trailing = body.slice(firstTag.start);
  const withoutTags = tags
    .reduceRight(
      (value, tag) => value.slice(0, tag.start - firstTag.start) + value.slice(tag.end - firstTag.start),
      trailing,
    )
    .trim();
  if (withoutTags) return display;

  const equation = body.slice(0, firstTag.start).trim();
  const split = splitTaggedEnvironment(equation, tags);
  if (split) return split.join("\n\n");

  // KaTeX permits only one tag per display. When OCR supplied multiple tags
  // for a structure we cannot safely split, retain every printed number in a
  // single tag instead of turning the whole equation into a parse error.
  const combined = tags.map((tag) => tag.value.trim()).join(", ");
  return `$$\n${equation} \\tag{${combined}}\n$$`;
}

function repairDisplayMath(markdown: string): string {
  markdown = protectMathPipesInGfmTables(
    separateAdjacentDisplayBlocks(
      canonicalizeInlineDisplayBlocks(
        unwrapInvalidNestedDisplayBlocks(markdown),
      ),
    ),
  );
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ending = line.match(/\r?\n$/)?.[0] ?? "";
    const content = line.slice(0, line.length - ending.length);
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) {
      output.push(line);
      if (
        fenceMarker?.[0] === fence.marker &&
        fenceMarker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      fence = {
        marker: fenceMarker[0] as "`" | "~",
        length: fenceMarker.length,
      };
      output.push(line);
      continue;
    }

    const opening = /^([ \t]*)\$\$[ \t]*$/.exec(content);
    if (opening) {
      let closingIndex = index + 1;
      while (closingIndex < lines.length) {
        const closingContent = lines[closingIndex].replace(/\r?\n$/, "");
        if (/^[ \t]*\$\$[ \t]*$/.test(closingContent)) break;
        closingIndex += 1;
      }
      if (closingIndex < lines.length) {
        const indent = opening[1];
        const body = lines
          .slice(index + 1, closingIndex)
          .map((bodyLine) => bodyLine.replace(/\r?\n$/, ""))
          .map((bodyLine) =>
            indent && bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine,
          )
          .join("\n");
        const display = `$$\n${body}\n$$`;
        const repaired = repairMultipleDisplayTags(display);
        if (repaired === display) {
          output.push(...lines.slice(index, closingIndex + 1));
        } else {
          const closingEnding = lines[closingIndex].match(/\r?\n$/)?.[0] ?? "";
          output.push(
            repaired
              .split("\n")
              .map((replacementLine) => `${indent}${replacementLine}`)
              .join("\n") + closingEnding,
          );
        }
        index = closingIndex;
        continue;
      }
    }

    const inlineDisplay = /^([ \t]*)\$\$([\s\S]+)\$\$[ \t]*$/.exec(content);
    if (inlineDisplay) {
      const display = `$$${inlineDisplay[2]}$$`;
      const repaired = repairMultipleDisplayTags(display);
      if (repaired !== display) {
        output.push(
          repaired
            .split("\n")
            .map((replacementLine) => `${inlineDisplay[1]}${replacementLine}`)
            .join("\n") + ending,
        );
        continue;
      }
    }
    output.push(line);
  }
  return output.join("");
}

export function normalizeMathDelimiters(
  markdown: string,
  recoverCopiedChatGptMath = false,
): string {
  if (!recoverCopiedChatGptMath) {
    const normalizedDelimiters = normalizeSlashMathDelimiters(markdown);
    return repairLatexMathBodies(repairDisplayMath(
      mapMarkdownProse(normalizedDelimiters, (source) =>
        wrapParenthesizedLatex(source)
      ),
    ));
  }

  const importedMarkdown = unwrapMisclassifiedIndentedPdfMath(
    unwrapMisclassifiedPdfPageFences(normalizeLegacyPdfMarkup(markdown)),
  );
  const withDisplayMath = normalizeSlashMathDelimiters(
    normalizeCopiedBracketDisplayBlocks(
      repairInlineMathAcrossPdfPageBreaks(importedMarkdown),
    ),
  );

  // Repair display boundaries before scanning prose. A global `$$…$$` split
  // is unsafe for OCR because one malformed delimiter shifts every later
  // pair, allowing inline recovery to inject `$` inside valid display math.
  // mapMarkdownProse instead protects recognized math/code regions and errs
  // on the side of leaving ambiguous text unchanged.
  const repairedDisplayMath = repairDisplayMath(withDisplayMath);
  return repairLatexMathBodies(repairDisplayMath(
    mapMarkdownProse(repairedDisplayMath, wrapParenthesizedLatex),
  ));
}

export function markdownBlockquote(source: string): string {
  return source
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
