import DiffMatchPatch from "diff-match-patch";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { HighlightAnchor } from "../types";

export interface SourceRange {
  start: number;
  end: number;
}

export interface RewriteMarker {
  key: string;
  markerId: string;
  quote: string;
}

interface PositionedNode {
  type?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function markdownBlockRanges(source: string): SourceRange[] {
  const tree = markdownParser.parse(source) as { children?: PositionedNode[] };
  return (tree.children ?? [])
    .filter((node) => node.type !== "definition")
    .map((node) => ({
      start: node.position?.start?.offset,
      end: node.position?.end?.offset,
    }))
    .filter(
      (range): range is SourceRange =>
        Number.isSafeInteger(range.start) &&
        Number.isSafeInteger(range.end) &&
        Number(range.end) >= Number(range.start),
    )
    .map((range) => ({ start: Number(range.start), end: Number(range.end) }));
}

export function containingMarkdownSection(
  source: string,
  startBlockIndex: number,
  endBlockIndex = startBlockIndex,
): SourceRange & { content: string } {
  const blocks = markdownBlockRanges(source);
  const startBlock = blocks[Math.max(0, Math.min(startBlockIndex, blocks.length - 1))];
  const endBlock = blocks[Math.max(0, Math.min(endBlockIndex, blocks.length - 1))];
  if (!startBlock || !endBlock) {
    return { start: 0, end: source.length, content: source };
  }
  const start = Math.min(startBlock.start, endBlock.start);
  const end = Math.max(startBlock.end, endBlock.end);
  return { start, end, content: source.slice(start, end) };
}

/**
 * Resolves rendered Markdown block indices back into the original stored
 * source. Rendering may normalize copied math delimiters and thereby change
 * the parser's top-level block count, so the two index spaces cannot safely
 * be treated as identical.
 */
export function containingOriginalMarkdownSection(
  source: string,
  renderedSource: string,
  startBlockIndex: number,
  endBlockIndex = startBlockIndex,
): SourceRange & { content: string } {
  const rendered = containingMarkdownSection(
    renderedSource,
    startBlockIndex,
    endBlockIndex,
  );
  if (source === renderedSource) {
    return { ...rendered, content: source.slice(rendered.start, rendered.end) };
  }

  const mapper = createPositionMapper(renderedSource, source);
  let start = mapper.map(rendered.start);
  let end = mapper.map(rendered.end);
  if (end < start) [start, end] = [end, start];
  start = Math.max(0, Math.min(source.length, start));
  end = Math.max(start, Math.min(source.length, end));
  return { start, end, content: source.slice(start, end) };
}

function quoteVariants(quote: string): string[] {
  const trimmed = quote.trim();
  const variants = new Set([quote, trimmed]);
  const display = trimmed.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
  if (display) {
    const body = display[1].trim();
    variants.add(`$$\n${body}\n$$`);
    variants.add(`\\[\n${body}\n\\]`);
    variants.add(`[\n${body}\n]`);
    variants.add(body);
  }
  const inline = trimmed.match(/^\$([^$]+)\$$/);
  if (inline) {
    variants.add(`\\(${inline[1]}\\)`);
    variants.add(`(${inline[1]})`);
    variants.add(inline[1]);
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

function closestOccurrence(
  source: string,
  candidates: string[],
  expected: number,
  within?: SourceRange,
): SourceRange | null {
  let best: (SourceRange & { distance: number }) | null = null;
  for (const candidate of candidates) {
    let index = source.indexOf(candidate, within?.start ?? 0);
    while (index >= 0 && (!within || index + candidate.length <= within.end)) {
      const distance = Math.abs(index - expected);
      if (!best || distance < best.distance) {
        best = { start: index, end: index + candidate.length, distance };
      }
      index = source.indexOf(candidate, index + Math.max(1, candidate.length));
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}

export function resolveAnchorRange(source: string, anchor: HighlightAnchor): SourceRange {
  if (
    Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end) &&
    anchor.start! >= 0 &&
    anchor.end! >= anchor.start! &&
    anchor.end! <= source.length
  ) {
    return { start: anchor.start!, end: anchor.end! };
  }
  const blocks = markdownBlockRanges(source);
  const block = blocks[anchor.blockIndex];
  const expected = block?.start ?? 0;
  return (
    closestOccurrence(source, quoteVariants(anchor.quote), expected, block) ??
    closestOccurrence(source, quoteVariants(anchor.quote), expected) ??
    block ?? { start: 0, end: source.length }
  );
}

function contextFor(source: string, range: SourceRange) {
  return {
    prefix: source.slice(Math.max(0, range.start - 64), range.start),
    suffix: source.slice(range.end, Math.min(source.length, range.end + 64)),
  };
}

export function anchorForSelection(
  source: string,
  anchor: Pick<HighlightAnchor, "sourceNodeId" | "sourceMessageId" | "quote" | "blockIndex">,
  endBlockIndex = anchor.blockIndex,
  sourceSection?: SourceRange,
): HighlightAnchor {
  const section = sourceSection ??
    containingMarkdownSection(source, anchor.blockIndex, endBlockIndex);
  const range =
    closestOccurrence(source, quoteVariants(anchor.quote), section.start, section) ?? section;
  return {
    ...anchor,
    ...range,
    ...contextFor(source, range),
    status: "resolved",
  };
}

function blockIndexForOffset(source: string, offset: number): number {
  const blocks = markdownBlockRanges(source);
  const containing = blocks.findIndex(
    (block) => offset >= block.start && offset <= block.end,
  );
  if (containing >= 0) return containing;
  const following = blocks.findIndex((block) => block.start > offset);
  return following >= 0 ? Math.max(0, following - 1) : Math.max(0, blocks.length - 1);
}

function readableQuote(source: string, fallback: string): string {
  const trimmed = source.trim();
  if (!trimmed) return fallback;
  const copiedDisplay = trimmed.match(/^\\?\[\s*\n([\s\S]*?)\n\s*\\?\]$/);
  if (copiedDisplay) return `$$\n${copiedDisplay[1].trim()}\n$$`;
  if (/^\$\$[\s\S]*\$\$$/.test(trimmed) || /^\$[^$]+\$$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .trim();
}

export interface PositionMapper {
  map(position: number): number;
}

export function createPositionMapper(oldSource: string, newSource: string): PositionMapper {
  const differ = new DiffMatchPatch();
  differ.Diff_Timeout = 1;
  const diffs = differ.diff_main(oldSource, newSource, true);
  differ.diff_cleanupSemanticLossless(diffs);
  return {
    map(position: number) {
      return Math.max(0, Math.min(newSource.length, differ.diff_xIndex(diffs, position)));
    },
  };
}

export function remapAnchor(
  oldSource: string,
  newSource: string,
  anchor: HighlightAnchor,
  mapper = createPositionMapper(oldSource, newSource),
): HighlightAnchor {
  const oldRange = resolveAnchorRange(oldSource, anchor);
  let start = mapper.map(oldRange.start);
  let end = mapper.map(oldRange.end);
  if (end < start) [start, end] = [end, start];

  const expected = start;
  const exact = closestOccurrence(newSource, quoteVariants(anchor.quote), expected);
  if (exact) {
    start = exact.start;
    end = exact.end;
  }
  const mappedSource = newSource.slice(start, end);
  const oldSelectedSource = oldSource.slice(oldRange.start, oldRange.end);
  const resolved = Boolean(exact) || mappedSource === oldSelectedSource;
  const range = { start, end };
  return {
    ...anchor,
    ...range,
    quote: exact ? anchor.quote : readableQuote(mappedSource, anchor.quote),
    blockIndex: blockIndexForOffset(newSource, start),
    ...contextFor(newSource, range),
    status: resolved ? "resolved" : "needs-review",
  };
}

export function anchorFromReplacementRange(
  source: string,
  anchor: HighlightAnchor,
  range: SourceRange,
): HighlightAnchor {
  const bounded = {
    start: Math.max(0, Math.min(source.length, range.start)),
    end: Math.max(0, Math.min(source.length, range.end)),
  };
  if (bounded.end < bounded.start) [bounded.start, bounded.end] = [bounded.end, bounded.start];
  const selected = source.slice(bounded.start, bounded.end);
  return {
    ...anchor,
    ...bounded,
    quote: readableQuote(selected, anchor.quote),
    blockIndex: blockIndexForOffset(source, bounded.start),
    ...contextFor(source, bounded),
    status: selected.trim() ? "resolved" : "needs-review",
  };
}

function stripOuterMarkdownFence(source: string): string {
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i);
  return fenced?.[1] ?? trimmed;
}

export function parseMarkedRewrite(
  response: string,
  annotations: RewriteMarker[],
): { content: string; ranges: Record<string, SourceRange> } {
  const marked = stripOuterMarkdownFence(response);
  const tokens: Array<{ value: string; index: number }> = [];
  const positions = new Map<string, { start: number; end: number }>();
  for (const annotation of annotations) {
    const startToken = `<<<LOCUS_START_${annotation.markerId}>>>`;
    const endToken = `<<<LOCUS_END_${annotation.markerId}>>>`;
    const start = marked.indexOf(startToken);
    const end = marked.indexOf(endToken);
    if (
      start < 0 ||
      end < start + startToken.length ||
      marked.indexOf(startToken, start + startToken.length) >= 0 ||
      marked.indexOf(endToken, end + endToken.length) >= 0
    ) {
      throw new Error(
        `The rewrite did not preserve the annotation markers for “${annotation.quote.slice(0, 90)}”. Try again or use raw Markdown editing.`,
      );
    }
    positions.set(annotation.key, { start, end });
    tokens.push({ value: startToken, index: start }, { value: endToken, index: end });
  }
  const unexpected = marked.match(/<<<LOCUS_(?:START|END)_[A-Za-z0-9_-]+>>>/g) ?? [];
  if (unexpected.length !== tokens.length) {
    throw new Error("The rewrite returned unexpected annotation markers. Try again.");
  }
  const cleanOffset = (rawOffset: number) =>
    rawOffset -
    tokens
      .filter((token) => token.index < rawOffset)
      .reduce((total, token) => total + token.value.length, 0);
  const ranges = Object.fromEntries(
    annotations.map((annotation) => {
      const position = positions.get(annotation.key)!;
      return [
        annotation.key,
        { start: cleanOffset(position.start), end: cleanOffset(position.end) },
      ];
    }),
  );
  let content = marked;
  [...tokens]
    .sort((left, right) => right.index - left.index)
    .forEach((token) => {
      content = content.slice(0, token.index) + content.slice(token.index + token.value.length);
    });
  return { content, ranges };
}
