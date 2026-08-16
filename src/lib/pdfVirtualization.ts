import type { MarkdownDocumentIndex, SourceRange } from "./sourceEditing";

export interface PdfMarkdownPage {
  page: number;
  content: string;
  startBlockIndex: number;
  endBlockIndex: number;
  estimatedHeight: number;
}

const PAGE_MARKER = /^\s*(?:\*\*|__)?Page\s+(\d+)(?:\*\*|__)?\s*$/i;
const THEMATIC_BREAK = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/;

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
