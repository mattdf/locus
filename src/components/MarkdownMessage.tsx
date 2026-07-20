import { CornerUpRight, ExternalLink } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/markdown";
import type {
  HighlightAnchor,
  InlineDefinition,
  InlineVisualization,
  Message,
  SelectionDraft,
} from "../types";
import { InlineMath } from "./MathText";

export interface LinkedAnchor {
  childId: string;
  title: string;
  anchor: HighlightAnchor;
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  ),
};

interface MarkdownMessageProps {
  message: Message;
  nodeId: string;
  linkedAnchors: LinkedAnchor[];
  definitions: InlineDefinition[];
  visualizations: InlineVisualization[];
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
  onOpenDefinition: (
    definitionId: string,
    rect: SelectionDraft["rect"],
    getAnchorRect?: () => SelectionDraft["rect"],
  ) => void;
  onOpenVisualization: (visualizationId: string) => void;
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

interface DefinitionRangeTarget {
  range: Range;
  definitionId: string;
}

interface DefinitionBlockTarget {
  element: Element;
  definitionId: string;
}

interface VisualizationRangeTarget {
  range: Range;
  visualizationId: string;
}

interface VisualizationBlockTarget {
  element: Element;
  visualizationId: string;
}

function textMap(container: HTMLElement): { text: string; points: Point[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (
        !parent ||
        parent.closest(
          ".katex-mathml, annotation, .elaboration-links, .inline-visualization-slot",
        )
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
  return Math.max(0, topLevelBlocks(container).indexOf(element));
}

function topLevelBlocks(container: HTMLElement): Element[] {
  return Array.from(container.children).filter(
    (element) => !element.classList.contains("inline-visualization-slot"),
  );
}

function topLevelBlock(container: HTMLElement, index: number): Element | undefined {
  return topLevelBlocks(container)[index];
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

function rangeForMathSource(root: Element, quote: string): Range | null {
  const normalized = quote.trim();
  const katex = Array.from(root.querySelectorAll(".katex")).find(
    (candidate) => mathSource(candidate) === normalized,
  );
  const visible = katex?.querySelector(".katex-html") ?? katex;
  if (!visible) return null;
  const range = document.createRange();
  range.selectNodeContents(visible);
  return range;
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

function MarkdownMessageComponent({
  message,
  nodeId,
  linkedAnchors,
  definitions,
  visualizations,
  onSelect,
  onOpenElaboration,
  onOpenDefinition,
  onOpenVisualization,
}: MarkdownMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const targetsRef = useRef<RangeTarget[]>([]);
  const blockTargetsRef = useRef<BlockTarget[]>([]);
  const definitionTargetsRef = useRef<DefinitionRangeTarget[]>([]);
  const definitionBlockTargetsRef = useRef<DefinitionBlockTarget[]>([]);
  const visualizationTargetsRef = useRef<VisualizationRangeTarget[]>([]);
  const visualizationBlockTargetsRef = useRef<VisualizationBlockTarget[]>([]);
  const highlightName = useMemo(
    () => `elaboration-${message.id.replace(/[^a-zA-Z0-9-]/g, "")}`,
    [message.id],
  );
  const definitionHighlightName = useMemo(
    () => `definition-${message.id.replace(/[^a-zA-Z0-9-]/g, "")}`,
    [message.id],
  );
  const visualizationHighlightName = useMemo(
    () => `visualization-${message.id.replace(/[^a-zA-Z0-9-]/g, "")}`,
    [message.id],
  );
  const normalizedContent = useMemo(
    () => normalizeMathDelimiters(message.content, message.role === "source"),
    [message.content, message.role],
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
      const block = topLevelBlock(container, linked.anchor.blockIndex);
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

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !definitions.length) return;

    const ranges: Range[] = [];
    const targets: DefinitionRangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: DefinitionBlockTarget[] = [];

    for (const definition of definitions) {
      const block = topLevelBlock(container, definition.anchor.blockIndex);
      const searchRoot = block instanceof HTMLElement ? block : container;
      const { text, points } = textMap(searchRoot);
      const quote = normalizedQuote(definition.anchor.quote);
      const index = quote ? text.indexOf(quote) : -1;
      if (index >= 0 && points[index] && points[index + quote.length - 1]) {
        const start = points[index];
        const end = points[index + quote.length - 1];
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        ranges.push(range);
        targets.push({ range, definitionId: definition.id });
        continue;
      }

      const mathRange = rangeForMathSource(searchRoot, definition.anchor.quote);
      if (mathRange) {
        ranges.push(mathRange);
        targets.push({ range: mathRange, definitionId: definition.id });
        continue;
      }

      if (block) {
        block.classList.add("has-linked-definition");
        styledBlocks.push(block);
        blockTargets.push({ element: block, definitionId: definition.id });
      }
    }

    definitionTargetsRef.current = targets;
    definitionBlockTargetsRef.current = blockTargets;
    const css = CSS as typeof CSS & {
      highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
    };
    const HighlightConstructor = (
      window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const style = document.createElement("style");
    if (css.highlights && HighlightConstructor && ranges.length) {
      css.highlights.set(
        definitionHighlightName,
        new HighlightConstructor(...ranges),
      );
      style.textContent = `::highlight(${definitionHighlightName}) { background: rgba(88, 166, 214, .3); text-decoration: underline; text-decoration-color: rgba(36, 112, 158, .62); text-underline-offset: 3px; }`;
      document.head.appendChild(style);
    }

    return () => {
      css.highlights?.delete(definitionHighlightName);
      style.remove();
      styledBlocks.forEach((block) => block.classList.remove("has-linked-definition"));
      definitionTargetsRef.current = [];
      definitionBlockTargetsRef.current = [];
    };
  }, [definitionHighlightName, definitions, message.content]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !visualizations.length) return;

    const ranges: Range[] = [];
    const targets: VisualizationRangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: VisualizationBlockTarget[] = [];
    for (const visualization of visualizations) {
      const block = topLevelBlock(container, visualization.anchor.blockIndex);
      const searchRoot = block instanceof HTMLElement ? block : container;
      const { text, points } = textMap(searchRoot);
      const quote = normalizedQuote(visualization.anchor.quote);
      const index = quote ? text.indexOf(quote) : -1;
      if (index >= 0 && points[index] && points[index + quote.length - 1]) {
        const start = points[index];
        const end = points[index + quote.length - 1];
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        ranges.push(range);
        targets.push({ range, visualizationId: visualization.id });
        continue;
      }
      const mathRange = rangeForMathSource(searchRoot, visualization.anchor.quote);
      if (mathRange) {
        ranges.push(mathRange);
        targets.push({ range: mathRange, visualizationId: visualization.id });
      } else if (block) {
        block.classList.add("has-linked-visualization");
        styledBlocks.push(block);
        blockTargets.push({ element: block, visualizationId: visualization.id });
      }
    }

    visualizationTargetsRef.current = targets;
    visualizationBlockTargetsRef.current = blockTargets;
    const css = CSS as typeof CSS & {
      highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
    };
    const HighlightConstructor = (
      window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const style = document.createElement("style");
    if (css.highlights && HighlightConstructor && ranges.length) {
      css.highlights.set(visualizationHighlightName, new HighlightConstructor(...ranges));
      style.textContent = `::highlight(${visualizationHighlightName}) { background: rgba(139, 102, 211, .3); text-decoration: underline; text-decoration-color: rgba(103, 63, 178, .7); text-underline-offset: 3px; }`;
      document.head.appendChild(style);
    }
    return () => {
      css.highlights?.delete(visualizationHighlightName);
      style.remove();
      styledBlocks.forEach((block) => block.classList.remove("has-linked-visualization"));
      visualizationTargetsRef.current = [];
      visualizationBlockTargetsRef.current = [];
    };
  }, [visualizationHighlightName, visualizations, message.content]);

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
      onMouseUp={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".inline-visualization-slot")
        ) return;
        captureSelection();
      }}
      onKeyUp={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".inline-visualization-slot")
        ) return;
        captureSelection();
      }}
      onClickCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".inline-visualization-slot")
        ) return;
        if (window.getSelection()?.toString()) return;
        const interactive =
          event.target instanceof Element ? event.target.closest("a, button") : null;
        if (interactive) return;

        const definitionRangeMatch = definitionTargetsRef.current.find((target) =>
          Array.from(target.range.getClientRects()).some(
            (rect) =>
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom,
          ),
        );
        const definitionBlockMatch =
          event.target instanceof Node
            ? definitionBlockTargetsRef.current.find((target) =>
                target.element.contains(event.target as Node),
              )
            : undefined;
        const definitionMatch = definitionRangeMatch ?? definitionBlockMatch;
        if (definitionMatch) {
          const getAnchorRect = () => {
            const bounds =
            "range" in definitionMatch
              ? definitionMatch.range.getBoundingClientRect()
              : definitionMatch.element.getBoundingClientRect();
            return {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            };
          };
          const bounds = getAnchorRect();
          event.preventDefault();
          onOpenDefinition(definitionMatch.definitionId, bounds, getAnchorRect);
          return;
        }

        const visualizationRangeMatch = visualizationTargetsRef.current.find((target) =>
          Array.from(target.range.getClientRects()).some(
            (rect) =>
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom,
          ),
        );
        const visualizationBlockMatch =
          event.target instanceof Node
            ? visualizationBlockTargetsRef.current.find((target) =>
                target.element.contains(event.target as Node),
              )
            : undefined;
        const visualizationMatch = visualizationRangeMatch ?? visualizationBlockMatch;
        if (visualizationMatch) {
          event.preventDefault();
          onOpenVisualization(visualizationMatch.visualizationId);
          return;
        }

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
        components={MARKDOWN_COMPONENTS}
      >
        {normalizedContent}
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

function sameMessage(left: Message, right: Message): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.role === right.role &&
      left.content === right.content &&
      left.pending === right.pending &&
      left.error === right.error &&
      left.stopped === right.stopped &&
      left.requestId === right.requestId &&
      left.generation === right.generation &&
      left.revisionGroupId === right.revisionGroupId &&
      left.revisionVariantId === right.revisionVariantId &&
      left.responseRevisionGroupId === right.responseRevisionGroupId)
  );
}

function sameLinkedAnchors(left: LinkedAnchor[], right: LinkedAnchor[]): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((anchor, index) => {
        const candidate = right[index];
        return (
          anchor.childId === candidate.childId &&
          anchor.title === candidate.title &&
          anchor.anchor === candidate.anchor
        );
      }))
  );
}

function sameDefinitions(left: InlineDefinition[], right: InlineDefinition[]): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((definition, index) => {
        const candidate = right[index];
        return (
          definition.id === candidate.id &&
          definition.anchor === candidate.anchor &&
          definition.content === candidate.content &&
          definition.pending === candidate.pending &&
          definition.error === candidate.error &&
          definition.generation === candidate.generation
        );
      }))
  );
}

function sameVisualizations(left: InlineVisualization[], right: InlineVisualization[]): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((visualization, index) => {
        const candidate = right[index];
        return (
          visualization.id === candidate.id &&
          visualization.anchor.sourceNodeId === candidate.anchor.sourceNodeId &&
          visualization.anchor.sourceMessageId === candidate.anchor.sourceMessageId &&
          visualization.anchor.quote === candidate.anchor.quote &&
          visualization.anchor.blockIndex === candidate.anchor.blockIndex
        );
      }))
  );
}

export const MarkdownMessage = memo(
  MarkdownMessageComponent,
  (left, right) =>
    left.nodeId === right.nodeId &&
    sameMessage(left.message, right.message) &&
    sameLinkedAnchors(left.linkedAnchors, right.linkedAnchors) &&
    sameDefinitions(left.definitions, right.definitions) &&
    sameVisualizations(left.visualizations, right.visualizations),
);
