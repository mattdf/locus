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

function looksLikeBareInlineMath(value: string): boolean {
  const expression = value.trim();
  if (!expression || expression.includes("$")) return false;
  if (/\\[A-Za-z]+/.test(expression)) return true;
  if (/[_^=<>∑∏∫∞≤≥±×÷]/.test(expression)) return true;
  return /^[A-Za-z](?:\s*,\s*[A-Za-z])+$/.test(expression);
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

function normalizeDisplayMathFences(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part) => {
      if (part.startsWith("`") || part.startsWith("~~~")) return part;
      return part.replace(
        /\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$/g,
        (_match, equation: string) => `$$\n${equation.trim()}\n$$`,
      );
    })
    .join("");
}

function normalizeCopiedInlineMath(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`|\$[^$\n]+\$)/g)
    .map((part) => {
      if (part.startsWith("`") || part.startsWith("$")) return part;
      return part
        .replace(/\\\((.*?)\\\)/g, (_match, equation: string) => `$${equation}$`)
        .replace(/\(([^()\n]{1,120})\)/g, (match, equation: string) =>
          looksLikeBareInlineMath(equation) ? `$${equation.trim()}$` : match,
        );
    })
    .join("");
}

export function normalizeMathDelimiters(
  markdown: string,
  recoverCopiedChatGptMath = false,
): string {
  if (!recoverCopiedChatGptMath) {
    return normalizeDisplayMathFences(
      markdown
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

  return normalizeDisplayMathFences(
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
