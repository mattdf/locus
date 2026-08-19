import type { MarkdownDocumentIndex, SourceRange } from "./sourceEditing";

export interface PdfMarkdownPage {
  page: number;
  content: string;
  startBlockIndex: number;
  endBlockIndex: number;
  estimatedHeight: number;
}

export interface PdfActiveRange {
  start: number;
  end: number;
}

export interface PdfSearchPage {
  page: number;
  content: string;
  sourceStart: number;
}

export interface PdfSearchMatch {
  page: number;
  pageOccurrence: number;
  index: number;
  sourceIndex: number;
  length: number;
  snippet: string;
}

export interface PdfSearchResult {
  matches: PdfSearchMatch[];
  total: number;
  truncated: boolean;
}

/**
 * Keeps the mounted PDF page window stable while the reader crosses nearby
 * page boundaries. Pages are added ahead of the reader immediately, but old
 * pages are retained for half a buffer before being evicted in a batch. This
 * prevents small shell/rendered-height differences from making the page
 * detector toggle the virtual window backward and forward at one boundary.
 */
export function stabilizePdfActiveRange(
  previous: PdfActiveRange,
  currentPage: number,
  buffer: number,
  reset = false,
): PdfActiveRange {
  if (
    reset ||
    currentPage < previous.start ||
    currentPage > previous.end
  ) {
    return {
      start: currentPage - buffer,
      end: currentPage + buffer,
    };
  }

  const retention = Math.max(2, Math.ceil(buffer / 2));
  let start = Math.min(previous.start, currentPage - buffer);
  let end = Math.max(previous.end, currentPage + buffer);
  if (currentPage - start > buffer + retention) start = currentPage - buffer;
  if (end - currentPage > buffer + retention) end = currentPage + buffer;
  return { start, end };
}

const PAGE_MARKER = /^\s*(?:\*\*|__)?Page\s+(\d+)(?:\*\*|__)?\s*$/i;
const GLOBAL_PAGE_MARKER = /^\s*(?:\*\*|__)?Page\s+(\d+)(?:\*\*|__)?\s*$/gim;
const THEMATIC_BREAK = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/;

/**
 * Builds a lightweight, full-document search index without mounting every PDF
 * page. This intentionally scans the stored Markdown directly: the result
 * snippets retain equations and code, while page virtualization remains
 * untouched.
 */
export function createPdfSearchPages(
  source: string,
  fallbackPageStart = 1,
): PdfSearchPage[] {
  const markers = Array.from(source.matchAll(GLOBAL_PAGE_MARKER))
    .map((match) => ({
      page: Number(match[1]),
      index: match.index ?? 0,
    }))
    .filter((marker) => Number.isSafeInteger(marker.page));

  if (!markers.length) {
    return source
      ? [{ page: fallbackPageStart, content: source, sourceStart: 0 }]
      : [];
  }

  return markers.map((marker, index) => {
    const sourceStart = index === 0 ? 0 : marker.index;
    const sourceEnd = markers[index + 1]?.index ?? source.length;
    return {
      page: marker.page,
      content: source.slice(sourceStart, sourceEnd),
      sourceStart,
    };
  });
}

function searchSnippet(content: string, index: number, length: number): string {
  const start = Math.max(0, index - 72);
  const end = Math.min(content.length, index + Math.max(length, 24) + 96);
  const compact = content
    .slice(start, end)
    .replace(/^\s*(?:\*\*|__)?Page\s+\d+(?:\*\*|__)?\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${compact}${end < content.length ? "…" : ""}`;
}

/** Searches every indexed page while bounding only the rendered result list. */
export function searchPdfPages(
  pages: readonly PdfSearchPage[],
  rawQuery: string,
  limit = 500,
): PdfSearchResult {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return { matches: [], total: 0, truncated: false };

  const matches: PdfSearchMatch[] = [];
  let total = 0;
  pages.forEach((page) => {
    const searchable = page.content.toLocaleLowerCase();
    let index = searchable.indexOf(query);
    let pageOccurrence = 0;
    while (index >= 0) {
      total += 1;
      if (matches.length < limit) {
        matches.push({
          page: page.page,
          pageOccurrence,
          index,
          sourceIndex: page.sourceStart + index,
          length: query.length,
          snippet: searchSnippet(page.content, index, query.length),
        });
      }
      pageOccurrence += 1;
      index = searchable.indexOf(query, index + Math.max(1, query.length));
    }
  });

  return { matches, total, truncated: total > matches.length };
}

function blockSource(source: string, range: SourceRange): string {
  return source.slice(range.start, range.end);
}

function estimatedPageHeight(content: string): number {
  const lines = content.split("\n");
  const imageCount = (content.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;
  const tableRows = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length;
  const fencedCodeLines = lines.filter((line) => /^\s{0,3}```/.test(line)).length
    ? lines.length
    : 0;
  const displayMathCount = (content.match(/\$\$|\\\[|\\begin\{/g) ?? []).length;
  const approximateWrappedLines = Math.ceil(content.replace(/\s+/g, " ").length / 84);
  return Math.max(
    320,
    Math.min(
      6_000,
      120 +
        Math.max(lines.length, approximateWrappedLines) * 25 +
        imageCount * 540 +
        tableRows * 12 +
        fencedCodeLines * 3 +
        displayMathCount * 24,
    ),
  );
}

/**
 * Splits normalized OCR Markdown at its explicit `**Page N**` markers while
 * retaining the original top-level Markdown block index space. Annotation
 * anchors therefore remain stable even though only a window of pages is
 * mounted in the browser.
 */
export function createPdfMarkdownPages(
  renderedSource: string,
  documentIndex: MarkdownDocumentIndex,
  fallbackPageStart = 1,
): PdfMarkdownPage[] {
  const blocks = documentIndex.renderedBlocks;
  if (!blocks.length) {
    return renderedSource
      ? [
          {
            page: fallbackPageStart,
            content: renderedSource,
            startBlockIndex: 0,
            endBlockIndex: 0,
            estimatedHeight: estimatedPageHeight(renderedSource),
          },
        ]
      : [];
  }

  const starts: Array<{ page: number; blockIndex: number }> = [];
  blocks.forEach((range, blockIndex) => {
    const marker = PAGE_MARKER.exec(blockSource(renderedSource, range).trim());
    if (!marker) return;
    const parsedPage = Number(marker[1]);
    if (!Number.isSafeInteger(parsedPage)) return;
    const previousBlock = blocks[blockIndex - 1];
    const includePreviousSeparator =
      previousBlock &&
      THEMATIC_BREAK.test(blockSource(renderedSource, previousBlock).trim());
    starts.push({
      page: parsedPage,
      blockIndex: includePreviousSeparator ? blockIndex - 1 : blockIndex,
    });
  });

  if (!starts.length) {
    return [
      {
        page: fallbackPageStart,
        content: renderedSource,
        startBlockIndex: 0,
        endBlockIndex: blocks.length - 1,
        estimatedHeight: estimatedPageHeight(renderedSource),
      },
    ];
  }

  // Preserve any preamble before the first marker as part of the first page.
  starts[0] = { ...starts[0], blockIndex: 0 };

  return starts.map((start, index) => {
    const nextBlockIndex = starts[index + 1]?.blockIndex ?? blocks.length;
    const contentStart = blocks[start.blockIndex]?.start ?? 0;
    const contentEnd =
      nextBlockIndex < blocks.length
        ? blocks[nextBlockIndex]?.start ?? renderedSource.length
        : renderedSource.length;
    const content = renderedSource.slice(contentStart, contentEnd);
    return {
      page: start.page,
      content,
      startBlockIndex: start.blockIndex,
      endBlockIndex: Math.max(start.blockIndex, nextBlockIndex - 1),
      estimatedHeight: estimatedPageHeight(content),
    };
  });
}

export function pdfPageForBlock(
  pages: readonly PdfMarkdownPage[],
  blockIndex: number,
): number | null {
  const page = pages.find(
    (candidate) =>
      blockIndex >= candidate.startBlockIndex && blockIndex <= candidate.endBlockIndex,
  );
  return page?.page ?? null;
}
