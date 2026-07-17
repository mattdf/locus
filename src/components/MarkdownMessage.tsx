import { CornerUpRight, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/markdown";
import type { HighlightAnchor, Message, SelectionDraft } from "../types";
import { InlineMath } from "./MathText";

interface LinkedAnchor {
  childId: string;
  title: string;
  anchor: HighlightAnchor;
}

interface MarkdownMessageProps {
  message: Message;
  nodeId: string;
  linkedAnchors: LinkedAnchor[];
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
}

interface Point {
  node: Text;
  offset: number;
}

interface RangeTarget {
  range: Range;
  childId: string;
}

interface BlockTarget {
  element: Element;
  childId: string;
}

function textMap(container: HTMLElement): { text: string; points: Point[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (
        !parent ||
        parent.closest(".katex-mathml, annotation, .elaboration-links")
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const points: Point[] = [];
  let node = walker.nextNode() as Text | null;
  let previousWasSpace = false;

  while (node) {
    const value = node.data;
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset];
      const isSpace = /\s/.test(character);
      if (isSpace && previousWasSpace) continue;
      text += isSpace ? " " : character;
      points.push({ node, offset });
      previousWasSpace = isSpace;
    }
    node = walker.nextNode() as Text | null;
  }
  return { text, points };
}

function normalizedQuote(quote: string) {
  return quote.replace(/\s+/g, " ").trim();
}

function topLevelBlockIndex(container: HTMLElement, sourceNode: Node): number {
  let element = sourceNode instanceof Element ? sourceNode : sourceNode.parentElement;
  if (!element) return 0;
  while (element.parentElement && element.parentElement !== container) {
    element = element.parentElement;
  }
  return Math.max(0, Array.from(container.children).indexOf(element));
}

function mathSource(math: Element): string | null {
  const annotation =
    math.querySelector('annotation[encoding="application/x-tex"]') ??
    math.querySelector("annotation");
  const source = annotation?.textContent?.trim();
  if (!source) return null;
  const display = Boolean(math.closest(".katex-display"));
  return display ? `$$\n${source}\n$$` : `$${source}$`;
}

function sourceQuoteFromRange(range: Range, container: HTMLElement): string {
  const sourceRange = range.cloneRange();
  const startElement =
    sourceRange.startContainer instanceof Element
      ? sourceRange.startContainer
      : sourceRange.startContainer.parentElement;
  const endElement =
    sourceRange.endContainer instanceof Element
      ? sourceRange.endContainer
      : sourceRange.endContainer.parentElement;
  const startMath = startElement?.closest(".katex");
  const endMath = endElement?.closest(".katex");

  // A visual selection often begins inside KaTeX's generated spans. Expand to
  // the complete formula so the copied quote can be replaced by its TeX source.
  if (startMath && container.contains(startMath)) sourceRange.setStartBefore(startMath);
  if (endMath && container.contains(endMath)) sourceRange.setEndAfter(endMath);

  const holder = document.createElement("div");
  holder.appendChild(sourceRange.cloneContents());
  holder.querySelectorAll(".katex").forEach((math) => {
    const source = mathSource(math);
    if (source) math.replaceWith(document.createTextNode(source));
  });

  // innerText preserves paragraph and line-break boundaries more faithfully
  // than textContent. It needs a rendered element to compute those boundaries.
  holder.style.cssText =
    "position:fixed;left:-100000px;top:0;width:800px;white-space:pre-wrap;pointer-events:none";
  document.body.appendChild(holder);
  const quote = holder.innerText;
  holder.remove();
  return quote.trim();
}

export function MarkdownMessage({
  message,
  nodeId,
  linkedAnchors,
  onSelect,
  onOpenElaboration,
}: MarkdownMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const targetsRef = useRef<RangeTarget[]>([]);
  const blockTargetsRef = useRef<BlockTarget[]>([]);
  const highlightName = useMemo(
    () => `elaboration-${message.id.replace(/[^a-zA-Z0-9-]/g, "")}`,
    [message.id],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !linkedAnchors.length) return;

    const { text, points } = textMap(container);
    const ranges: Range[] = [];
    const targets: RangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: BlockTarget[] = [];

    for (const linked of linkedAnchors) {
      const block = container.children[linked.anchor.blockIndex];
      if (block) {
        block.classList.add("has-linked-elaboration");
        styledBlocks.push(block);
        blockTargets.push({ element: block, childId: linked.childId });
      }

      const quote = normalizedQuote(linked.anchor.quote);
      const index = quote ? text.indexOf(quote) : -1;
      if (index >= 0 && points[index] && points[index + quote.length - 1]) {
        const start = points[index];
        const end = points[index + quote.length - 1];
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        ranges.push(range);
        targets.push({ range, childId: linked.childId });
      }
    }

    targetsRef.current = targets;
    blockTargetsRef.current = blockTargets;
    const css = CSS as typeof CSS & {
      highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
    };
    const HighlightConstructor = (
      window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const style = document.createElement("style");
    if (css.highlights && HighlightConstructor && ranges.length) {
      css.highlights.set(highlightName, new HighlightConstructor(...ranges));
      style.textContent = `::highlight(${highlightName}) { background: rgba(238, 190, 84, .42); text-decoration: underline; text-decoration-color: rgba(159, 105, 0, .5); text-underline-offset: 3px; }`;
      document.head.appendChild(style);
    }

    return () => {
      css.highlights?.delete(highlightName);
      style.remove();
      styledBlocks.forEach((block) => block.classList.remove("has-linked-elaboration"));
      targetsRef.current = [];
      blockTargetsRef.current = [];
    };
  }, [highlightName, linkedAnchors, message.content]);

  const captureSelection = () => {
    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const quote = sourceQuoteFromRange(range, container);
    if (!quote.trim() || quote.length > 12_000) return;
    const bounds = range.getBoundingClientRect();
    onSelect({
      sourceNodeId: nodeId,
      sourceMessageId: message.id,
      quote,
      blockIndex: topLevelBlockIndex(container, range.startContainer),
      rect: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    });
  };

  return (
    <div
      className="markdown-message"
      ref={containerRef}
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
      onClickCapture={(event) => {
        if (window.getSelection()?.toString()) return;
        const interactive =
          event.target instanceof Element ? event.target.closest("a, button") : null;
        if (interactive) return;

        const rangeMatch = targetsRef.current.find((target) =>
          Array.from(target.range.getClientRects()).some(
            (rect) =>
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom,
          ),
        );
        const blockMatch =
          event.target instanceof Node
            ? blockTargetsRef.current.find((target) => target.element.contains(event.target as Node))
            : undefined;
        const match = rangeMatch ?? blockMatch;
        if (match) {
          event.preventDefault();
          onOpenElaboration(match.childId);
        }
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          ),
        }}
      >
        {normalizeMathDelimiters(message.content, message.role === "source")}
      </ReactMarkdown>
      {!!linkedAnchors.length && (
        <div className="elaboration-links" aria-label="Elaborations from this passage">
          {linkedAnchors.map((linked) => (
            <button
              type="button"
              key={linked.childId}
              onClick={() => onOpenElaboration(linked.childId)}
              title={linked.anchor.quote.trim()}
            >
              <CornerUpRight size={12} />
              <InlineMath source={linked.title} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
