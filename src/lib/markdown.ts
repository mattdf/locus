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
  const output: string[] = [];
  let proseStart = 0;
  let cursor = 0;

  const protect = (end: number) => {
    output.push(transform(markdown.slice(proseStart, cursor)), markdown.slice(cursor, end));
    cursor = end;
    proseStart = end;
  };

  while (cursor < markdown.length) {
    if (markdown.startsWith("```", cursor) || markdown.startsWith("~~~", cursor)) {
      const marker = markdown.slice(cursor, cursor + 3);
      const closing = markdown.indexOf(marker, cursor + marker.length);
      if (closing >= 0) {
        protect(closing + marker.length);
        continue;
      }
    }

    if (markdown[cursor] === "`") {
      let runLength = 1;
      while (markdown[cursor + runLength] === "`") runLength += 1;
      const closing = closingInlineCode(markdown, cursor, runLength);
      if (closing >= 0) {
        protect(closing + runLength);
        continue;
      }
    }

    if (markdown[cursor] === "$" && !escapedAt(markdown, cursor)) {
      const delimiter: "$" | "$$" = markdown[cursor + 1] === "$" ? "$$" : "$";
      const closing = closingDollar(markdown, cursor + delimiter.length, delimiter);
      if (closing >= 0) {
        protect(closing + delimiter.length);
        continue;
      }
    }

    cursor += 1;
  }

  output.push(transform(markdown.slice(proseStart)));
  return output.join("");
}

function normalizeCopiedInlineMath(markdown: string): string {
  return mapMarkdownProse(markdown, (source) =>
    source.replace(
        /\\\((.*?)\\\)/g,
        (_match, equation: string) => `$${equation}$`,
      ),
  );
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
  markdown = separateAdjacentDisplayBlocks(markdown);
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
    return repairDisplayMath(
      mapMarkdownProse(markdown, (source) =>
        source
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, equation: string) =>
          `$$\n${equation.trim()}\n$$`,
        )
        .replace(/\\\((.*?)\\\)/g, (_match, equation: string) => `$${equation}$`),
      ),
    );
  }

  const withDisplayMath = normalizeLegacyPdfMarkup(markdown).replace(
    /(^|\n)[ \t]*\\?\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\\?\][ \t]*(?=\r?\n|$)/g,
    (_match, leading: string, equation: string) =>
      `${leading}$$\n${cleanCopiedDisplayMath(equation)}\n$$`,
  );

  return repairDisplayMath(
    withDisplayMath
      .split(/(\$\$[\s\S]*?\$\$)/g)
      .map((part) => (part.startsWith("$$") ? part : normalizeCopiedInlineMath(part)))
      .join(""),
  );
}

export function markdownBlockquote(source: string): string {
  return source
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
