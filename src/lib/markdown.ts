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
      const marker = "`".repeat(runLength);
      const closing = markdown.indexOf(marker, cursor + runLength);
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

export function normalizeMathDelimiters(
  markdown: string,
  recoverCopiedChatGptMath = false,
): string {
  if (!recoverCopiedChatGptMath) {
    return mapMarkdownProse(markdown, (source) =>
      source
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, equation: string) =>
          `$$\n${equation.trim()}\n$$`,
        )
        .replace(/\\\((.*?)\\\)/g, (_match, equation: string) => `$${equation}$`),
    );
  }

  const withDisplayMath = normalizeLegacyPdfMarkup(markdown).replace(
    /(^|\n)[ \t]*\\?\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\\?\][ \t]*(?=\r?\n|$)/g,
    (_match, leading: string, equation: string) =>
      `${leading}$$\n${cleanCopiedDisplayMath(equation)}\n$$`,
  );

  return withDisplayMath
    .split(/(\$\$[\s\S]*?\$\$)/g)
    .map((part) => (part.startsWith("$$") ? part : normalizeCopiedInlineMath(part)))
    .join("");
}

export function markdownBlockquote(source: string): string {
  return source
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
