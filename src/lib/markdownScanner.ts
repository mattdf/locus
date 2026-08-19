export interface MarkdownFence {
  start: number;
  end: number;
  openerStart: number;
  openerEnd: number;
  bodyStart: number;
  bodyEnd: number;
  closerStart: number | null;
  closerEnd: number | null;
  marker: "`" | "~";
  markerLength: number;
  info: string;
}

interface SourceLine {
  start: number;
  contentEnd: number;
  end: number;
  content: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const contentEnd = newline < 0
      ? source.length
      : newline > start && source[newline - 1] === "\r"
        ? newline - 1
        : newline;
    lines.push({
      start,
      contentEnd,
      end,
      content: source.slice(start, contentEnd),
    });
    start = end;
  }
  if (!source.length) return [];
  return lines;
}

interface FenceMarker {
  marker: "`" | "~";
  length: number;
  info: string;
}

function openingFence(line: string): FenceMarker | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  // CommonMark does not permit a backtick in the info string of a backtick
  // fence. Treating that shape as prose prevents an accidental, document-wide
  // code region when OCR emits a run of backticks in ordinary text.
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
    info: match[2].trim(),
  };
}

function closesFence(line: string, fence: FenceMarker): boolean {
  const indent = line.match(/^ */)?.[0].length ?? 0;
  if (indent > 3) return false;
  let cursor = indent;
  while (line[cursor] === fence.marker) cursor += 1;
  return cursor - indent >= fence.length && /^[ \t]*$/.test(line.slice(cursor));
}

/**
 * Lex Markdown fenced-code blocks using CommonMark's fence rules. This is the
 * shared structural scanner for the import normalizer; math repair must never
 * infer fence boundaries by searching for the next literal three backticks.
 */
export function scanMarkdownFences(source: string): MarkdownFence[] {
  const lines = sourceLines(source);
  const fences: MarkdownFence[] = [];
  let active:
    | {
        marker: FenceMarker;
        line: SourceLine;
      }
    | null = null;

  for (const line of lines) {
    if (active) {
      if (!closesFence(line.content, active.marker)) continue;
      fences.push({
        start: active.line.start,
        end: line.end,
        openerStart: active.line.start,
        openerEnd: active.line.end,
        bodyStart: active.line.end,
        bodyEnd: line.start,
        closerStart: line.start,
        closerEnd: line.end,
        marker: active.marker.marker,
        markerLength: active.marker.length,
        info: active.marker.info,
      });
      active = null;
      continue;
    }

    const marker = openingFence(line.content);
    if (marker) active = { marker, line };
  }

  if (active) {
    fences.push({
      start: active.line.start,
      end: source.length,
      openerStart: active.line.start,
      openerEnd: active.line.end,
      bodyStart: active.line.end,
      bodyEnd: source.length,
      closerStart: null,
      closerEnd: null,
      marker: active.marker.marker,
      markerLength: active.marker.length,
      info: active.marker.info,
    });
  }
  return fences;
}

export function mapOutsideMarkdownCode(
  source: string,
  transform: (prose: string) => string,
): string {
  const fences = scanMarkdownFences(source);
  if (!fences.length) return transform(source);
  const output: string[] = [];
  let cursor = 0;
  for (const fence of fences) {
    output.push(transform(source.slice(cursor, fence.start)));
    output.push(source.slice(fence.start, fence.end));
    cursor = fence.end;
  }
  output.push(transform(source.slice(cursor)));
  return output.join("");
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function closingInlineCode(source: string, start: number, length: number): number {
  const marker = "`".repeat(length);
  const lineEnd = source.indexOf("\n", start + length);
  let cursor = start + length;
  while (cursor < source.length && (lineEnd < 0 || cursor < lineEnd)) {
    const closing = source.indexOf(marker, cursor);
    if (closing < 0 || (lineEnd >= 0 && closing >= lineEnd)) return -1;
    if (source[closing - 1] !== "`" && source[closing + length] !== "`") {
      return closing;
    }
    cursor = closing + length;
  }
  return -1;
}

function pageBoundaryAt(source: string, index: number): boolean {
  if (index > 0 && source[index - 1] !== "\n") return false;
  const rest = source.slice(index);
  return /^---[ \t]*(?:\r?\n){2,}\*\*Page\s+\d+\*\*/.test(rest);
}

function closingSlashDelimiter(
  source: string,
  start: number,
  close: ")" | "]",
): number {
  for (let cursor = start; cursor < source.length - 1; cursor += 1) {
    if (close === ")" && source[cursor] === "\n") return -1;
    if (close === "]" && pageBoundaryAt(source, cursor)) return -1;
    if (
      source[cursor] === "\\" &&
      source[cursor + 1] === close &&
      !escapedAt(source, cursor)
    ) {
      return cursor;
    }
  }
  return -1;
}

function closingDollarDelimiter(
  source: string,
  start: number,
  display: boolean,
): number {
  const delimiter = display ? "$$" : "$";
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (!display && source[cursor] === "\n") return -1;
    if (display && pageBoundaryAt(source, cursor)) return -1;
    if (!source.startsWith(delimiter, cursor) || escapedAt(source, cursor)) continue;
    if (!display && (source[cursor - 1] === "$" || source[cursor + 1] === "$")) {
      continue;
    }
    return cursor;
  }
  return -1;
}

interface DollarSpan {
  end: number;
  closingStart: number;
  delimiterLength: 1 | 2;
}

function dollarSpanAt(source: string, start: number): DollarSpan | null {
  const display = source[start + 1] === "$";
  if (!display) {
    const closing = closingDollarDelimiter(source, start + 1, false);
    return closing < 0
      ? null
      : { end: closing + 1, closingStart: closing, delimiterLength: 1 };
  }

  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = source.indexOf("\n", start + 2);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;

  // A paired `$$...$$` on one line is valid even when prose or an equation
  // number appears beside it.
  const sameLineClosing = source.indexOf("$$", start + 2);
  if (
    sameLineClosing >= 0 &&
    sameLineClosing < lineEnd &&
    !escapedAt(source, sameLineClosing) &&
    source.slice(start + 2, sameLineClosing).trim()
  ) {
    return {
      end: sameLineClosing + 2,
      closingStart: sameLineClosing,
      delimiterLength: 2,
    };
  }

  // A multiline display opener must occupy its line. This is the key rule
  // that prevents an unmatched `$$` in prose from stealing the opener of a
  // later, otherwise valid display.
  if (
    source.slice(lineStart, start).trim() ||
    source.slice(start + 2, lineEnd).trim()
  ) {
    return null;
  }

  let cursor = nextNewline < 0 ? source.length : nextNewline + 1;
  while (cursor < source.length) {
    if (pageBoundaryAt(source, cursor)) return null;
    const end = source.indexOf("\n", cursor);
    const candidateEnd = end < 0 ? source.length : end;
    const candidate = source.slice(cursor, candidateEnd);
    const closing = /^([ \t]*)\$\$[ \t]*$/.exec(candidate);
    if (closing) {
      return {
        end: candidateEnd,
        closingStart: cursor + closing[1].length,
        delimiterLength: 2,
      };
    }
    cursor = end < 0 ? source.length : end + 1;
  }
  return null;
}

function appendDisplay(output: string[], body: string) {
  const before = output.at(-1) ?? "";
  if (before && !before.endsWith("\n")) output.push("\n");
  output.push("$$\n", body.trim(), "\n$$\n");
}

/**
 * Tokenize inline code and math delimiters in prose. Existing dollar math is
 * copied as an opaque token; TeX `\\(...\\)` and `\\[...\\]` are converted
 * only when their matching closer is found before the relevant line/page
 * boundary. Unmatched input stays byte-for-byte unchanged.
 */
export function normalizeSlashMathDelimiters(source: string): string {
  return mapOutsideMarkdownCode(source, (prose) => {
    const output: string[] = [];
    let plainStart = 0;
    let cursor = 0;

    const copyProtected = (end: number) => {
      output.push(prose.slice(plainStart, end));
      cursor = end;
      plainStart = end;
    };

    while (cursor < prose.length) {
      if (prose[cursor] === "`") {
        let length = 1;
        while (prose[cursor + length] === "`") length += 1;
        const closing = closingInlineCode(prose, cursor, length);
        if (closing >= 0) {
          copyProtected(closing + length);
          continue;
        }
      }

      if (prose[cursor] === "$" && !escapedAt(prose, cursor)) {
        const span = dollarSpanAt(prose, cursor);
        if (span) {
          copyProtected(span.end);
          continue;
        }
      }

      if (
        prose[cursor] === "\\" &&
        (prose[cursor + 1] === "(" || prose[cursor + 1] === "[") &&
        !escapedAt(prose, cursor)
      ) {
        const display = prose[cursor + 1] === "[";
        const closing = closingSlashDelimiter(
          prose,
          cursor + 2,
          display ? "]" : ")",
        );
        if (closing >= 0) {
          output.push(prose.slice(plainStart, cursor));
          const body = prose.slice(cursor + 2, closing);
          if (display) appendDisplay(output, body);
          else output.push("$", body, "$");
          cursor = closing + 2;
          plainStart = cursor;
          continue;
        }
      }
      cursor += 1;
    }

    output.push(prose.slice(plainStart));
    return output.join("");
  });
}

/** Apply a transform only to literal prose, excluding fenced/inline code and
 * well-formed dollar math. Delimiter recognition is local to a line or PDF
 * page, so malformed OCR cannot shift tokenization through the rest of a book.
 */
export function mapMarkdownPlainText(
  source: string,
  transform: (plain: string) => string,
): string {
  return mapOutsideMarkdownCode(source, (prose) => {
    const output: string[] = [];
    let plainStart = 0;
    let cursor = 0;
    const protect = (end: number) => {
      output.push(transform(prose.slice(plainStart, cursor)), prose.slice(cursor, end));
      cursor = end;
      plainStart = end;
    };

    while (cursor < prose.length) {
      if (prose[cursor] === "`") {
        let length = 1;
        while (prose[cursor + length] === "`") length += 1;
        const closing = closingInlineCode(prose, cursor, length);
        if (closing >= 0) {
          protect(closing + length);
          continue;
        }
      }
      if (prose[cursor] === "$" && !escapedAt(prose, cursor)) {
        const span = dollarSpanAt(prose, cursor);
        if (span) {
          protect(span.end);
          continue;
        }
      }
      cursor += 1;
    }
    output.push(transform(prose.slice(plainStart)));
    return output.join("");
  });
}

/** Transform the TeX body of each well-formed dollar-math token while
 * preserving delimiters and all non-math bytes. */
export function mapMarkdownMathBodies(
  source: string,
  transform: (body: string, display: boolean) => string,
): string {
  return mapOutsideMarkdownCode(source, (prose) => {
    const output: string[] = [];
    let cursor = 0;
    let copied = 0;
    while (cursor < prose.length) {
      if (prose[cursor] === "`") {
        let length = 1;
        while (prose[cursor + length] === "`") length += 1;
        const closing = closingInlineCode(prose, cursor, length);
        if (closing >= 0) {
          cursor = closing + length;
          continue;
        }
      }
      if (prose[cursor] !== "$" || escapedAt(prose, cursor)) {
        cursor += 1;
        continue;
      }
      const span = dollarSpanAt(prose, cursor);
      if (!span) {
        cursor += prose[cursor + 1] === "$" ? 2 : 1;
        continue;
      }
      const rawBody = prose.slice(
        cursor + span.delimiterLength,
        span.closingStart,
      );
      const trailingBlockWhitespace = span.delimiterLength === 2
        ? rawBody.match(/(?:\r?\n)[ \t]*$/)?.[0] ?? ""
        : "";
      const repairableBody = trailingBlockWhitespace
        ? rawBody.slice(0, -trailingBlockWhitespace.length)
        : rawBody;
      output.push(
        prose.slice(copied, cursor + span.delimiterLength),
        transform(repairableBody, span.delimiterLength === 2),
        trailingBlockWhitespace,
        prose.slice(span.closingStart, span.end),
      );
      cursor = span.end;
      copied = cursor;
    }
    output.push(prose.slice(copied));
    return output.join("");
  });
}

function codeKeywordCount(body: string, info: string): number {
  const language = info.toLowerCase().split(/[\s,{]/)[0];
  const patterns: Record<string, RegExp> = {
    python: /^\s*(?:@\w+|async\s+def\s+|def\s+|class\s+|from\s+\S+\s+import\s+|import\s+|if\s+__name__|for\s+\w+\s+in\s+|while\s+.+:|try:|except\b|return\b|yield\b)/gm,
    py: /^\s*(?:@\w+|async\s+def\s+|def\s+|class\s+|from\s+\S+\s+import\s+|import\s+|if\s+__name__|for\s+\w+\s+in\s+|while\s+.+:|try:|except\b|return\b|yield\b)/gm,
    sql: /^\s*(?:SELECT\b.+\bFROM\b|INSERT\s+INTO\b|UPDATE\b.+\bSET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|VIEW)\b|ALTER\s+TABLE\b)/gim,
    javascript: /^\s*(?:import\s+|export\s+|(?:const|let|var)\s+|function\s+|class\s+|if\s*\(|for\s*\(|while\s*\()/gm,
    js: /^\s*(?:import\s+|export\s+|(?:const|let|var)\s+|function\s+|class\s+|if\s*\(|for\s*\(|while\s*\()/gm,
    typescript: /^\s*(?:import\s+|export\s+|(?:const|let|var|interface|type|enum)\s+|function\s+|class\s+|if\s*\(|for\s*\()/gm,
    ts: /^\s*(?:import\s+|export\s+|(?:const|let|var|interface|type|enum)\s+|function\s+|class\s+|if\s*\(|for\s*\()/gm,
  };
  const pattern = patterns[language];
  if (!pattern) return 0;
  return body.match(pattern)?.length ?? 0;
}

function looksLikeMisclassifiedPage(body: string, info: string): boolean {
  const lines = body.split(/\r?\n/).filter((line) => line.trim());
  const words = body.match(/[\p{L}]{3,}/gu)?.length ?? 0;
  if (words < 24) return false;

  const codeKeywords = codeKeywordCount(body, info);
  if (codeKeywords >= 2) return false;

  const texTokens = body.match(
    /\\(?:\(|\[|frac\b|begin\b|vec\b|mathbf\b|partial\b|sum\b|int\b|mu\b|nu\b|lambda\b|Gamma\b)/g,
  )?.length ?? 0;
  const sentenceLines = lines.filter((line) =>
    /[.!?][”"')\]]?\s*$/.test(line.trim()),
  ).length;
  const proseConnectives = body.match(
    /\b(?:the|and|that|which|where|with|from|this|these|then|therefore|because|when|into|under|between|defined|denotes|means)\b/gi,
  )?.length ?? 0;
  const indexLines = lines.filter((line) =>
    /^[\p{L}“”'(.][^{};]{2,}(?:\d+(?:[-–]\d+)?|See(?: also)?\b)/u.test(
      line.trim(),
    ),
  ).length;

  // A whole page of index entries is prose even though it contains few full
  // sentences. This catches OCR's recurring `python`/`sql` hallucination on
  // back-of-book indexes without touching a real source-code listing.
  if (lines.length >= 8 && indexLines / lines.length >= 0.35) return true;

  return (
    texTokens >= 2 ||
    sentenceLines >= 2 ||
    proseConnectives >= Math.max(8, Math.floor(words / 16))
  );
}

interface PdfPageRange {
  number: number;
  labelEnd: number;
  bodyEnd: number;
}

function pdfPageRanges(source: string): PdfPageRange[] {
  const labels = [
    ...source.matchAll(/^\*\*Page\s+(\d+)\*\*[ \t]*(?:\r?\n|$)/gm),
  ];
  return labels.map((label, index) => {
    const nextStart = labels[index + 1]?.index ?? source.length;
    let bodyEnd = nextStart;
    const beforeNext = source.slice(0, bodyEnd);
    const divider = /(?:^|\n)---[ \t]*(?:\r?\n)*$/.exec(beforeNext);
    if (divider && (divider.index ?? -1) >= (label.index ?? 0)) {
      bodyEnd = divider.index! + (divider[0].startsWith("\n") ? 1 : 0);
    }
    return {
      number: Number(label[1]),
      labelEnd: (label.index ?? 0) + label[0].length,
      bodyEnd,
    };
  });
}

function onlyWhitespace(source: string, start: number, end: number): boolean {
  return /^[\s]*$/.test(source.slice(start, end));
}

/**
 * Mistral occasionally wraps an entire OCR page in a hallucinated Markdown
 * code fence. Remove the fence only when it is the page's sole block and its
 * contents classify strongly as prose/math (or a book index), while retaining
 * genuine code pages and every partial-page code block.
 */
export function unwrapMisclassifiedPdfPageFences(source: string): string {
  const fences = scanMarkdownFences(source);
  if (!fences.length) return source;
  const pages = pdfPageRanges(source);
  const removals: Array<{ start: number; end: number }> = [];

  for (const page of pages) {
    const fence = fences.find(
      (candidate) =>
        candidate.start >= page.labelEnd && candidate.end <= page.bodyEnd,
    );
    if (!fence?.closerStart || !fence.closerEnd) continue;
    if (!onlyWhitespace(source, page.labelEnd, fence.openerStart)) continue;
    if (!onlyWhitespace(source, fence.closerEnd, page.bodyEnd)) continue;
    const body = source.slice(fence.bodyStart, fence.bodyEnd);
    if (!looksLikeMisclassifiedPage(body, fence.info)) continue;
    removals.push(
      { start: fence.openerStart, end: fence.openerEnd },
      { start: fence.closerStart, end: fence.closerEnd },
    );
  }

  if (!removals.length) return source;
  removals.sort((left, right) => left.start - right.start);
  const output: string[] = [];
  let cursor = 0;
  for (const removal of removals) {
    output.push(source.slice(cursor, removal.start));
    cursor = removal.end;
  }
  output.push(source.slice(cursor));
  return output.join("");
}

/**
 * OCR sometimes emits a standalone TeX equation with four leading spaces,
 * which CommonMark necessarily parses as an indented code block. Remove one
 * indentation level only when the complete nonblank line is dollar-delimited
 * math. Ordinary indented prose and actual code remain untouched.
 */
export function unwrapMisclassifiedIndentedPdfMath(source: string): string {
  return mapOutsideMarkdownCode(source, (prose) =>
    prose.replace(
      /^( {4}|\t)(\$[^\r\n]*\$[.,;:]?)[ \t]*$/gm,
      (_match, _indent: string, equation: string) => equation,
    ),
  );
}
