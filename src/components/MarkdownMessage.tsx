import { CornerUpRight, ExternalLink } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { KATEX_RENDER_OPTIONS } from "../lib/katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/markdown";
import {
  anchorForSelection,
  containingOriginalMarkdownSection,
  createMarkdownDocumentIndex,
} from "../lib/sourceEditing";
import {
  createPdfMarkdownPages,
  stabilizePdfActiveRange,
  type PdfMarkdownPage,
} from "../lib/pdfVirtualization";
import type {
  AnnotationTarget,
  HighlightAnchor,
  InlineDefinition,
  InlineElaboration,
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
  img: ({ node, ...props }) => {
    void node;
    return <img {...props} loading="lazy" decoding="async" />;
  },
  table: ({ node, children, ...props }) => {
    void node;
    return (
      <div
        className="markdown-table-scroll"
        role="region"
        aria-label="Scrollable table"
        tabIndex={0}
      >
        <table {...props}>{children}</table>
      </div>
    );
  },
};

const PDF_MARKDOWN_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  img: ({ node, ...props }) => {
    void node;
    // Only the current PDF page window is mounted. Load its images now so
    // they establish their height before the reader reaches the page; lazy
    // images without intrinsic dimensions otherwise expand underneath the
    // scroll anchor and can move the viewport by several pages.
    return <img {...props} loading="eager" decoding="async" />;
  },
  strong: ({ node, children, ...props }) => {
    void node;
    const text = Array.isArray(children) ? children.join("") : String(children ?? "");
    const page = /^Page\s+(\d+)$/.exec(text.trim())?.[1];
    return (
      <strong
        {...props}
        {...(page
          ? {
              id: `pdf-page-${page}`,
              "data-pdf-page": page,
            }
          : {})}
      >
        {children}
      </strong>
    );
  },
};

const RenderedMarkdownBody = memo(function RenderedMarkdownBody({
  content,
  preserveSoftBreaks,
}: {
  content: string;
  preserveSoftBreaks: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, KATEX_RENDER_OPTIONS], rehypeHighlight]}
      components={preserveSoftBreaks ? PDF_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

function PdfVirtualPage({
  page,
  active,
  cachedHeight,
  onHeight,
}: {
  page: PdfMarkdownPage;
  active: boolean;
  cachedHeight?: number;
  onHeight: (page: number, height: number, element: HTMLElement) => void;
}) {
  const pageRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = pageRef.current;
    if (!element || !active) return;
    const measure = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0) onHeight(page.page, height, element);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [active, onHeight, page.page]);

  return (
    <section
      ref={pageRef}
      id={`page${page.page}`}
      className={`pdf-virtual-page${active ? " pdf-virtual-page--active" : ""}`}
      data-pdf-page-shell={page.page}
      data-pdf-page-active={active ? "true" : "false"}
      data-block-start={page.startBlockIndex}
      data-block-end={page.endBlockIndex}
      aria-label={`PDF page ${page.page}`}
      aria-hidden={!active}
      style={
        active
          ? undefined
          : { height: `${cachedHeight ?? page.estimatedHeight}px` }
      }
    >
      {active ? (
        <div
          className="pdf-virtual-page__content"
          data-pdf-page-content="true"
          data-block-start={page.startBlockIndex}
        >
          <RenderedMarkdownBody content={page.content} preserveSoftBreaks />
        </div>
      ) : null}
    </section>
  );
}

const VirtualizedPdfMarkdownBody = memo(function VirtualizedPdfMarkdownBody({
  pages,
  currentPage,
  buffer,
  renderAll,
}: {
  pages: PdfMarkdownPage[];
  currentPage: number;
  buffer: number;
  renderAll: boolean;
}) {
  const heightsRef = useRef(new Map<number, number>());
  const pageMap = useMemo(
    () => new Map(pages.map((page) => [page.page, page])),
    [pages],
  );
  const pagesRef = useRef(pageMap);
  const currentPageRef = useRef(currentPage);
  const renderAllRef = useRef(renderAll);
  const bufferRef = useRef(buffer);
  const activeRangeRef = useRef({
    start: currentPage - buffer,
    end: currentPage + buffer,
  });
  pagesRef.current = pageMap;
  currentPageRef.current = currentPage;

  const previousRange = activeRangeRef.current;
  const resetWindow = renderAllRef.current || bufferRef.current !== buffer;
  renderAllRef.current = renderAll;
  bufferRef.current = buffer;
  if (renderAll) {
    activeRangeRef.current = {
      start: pages[0]?.page ?? currentPage,
      end: pages.at(-1)?.page ?? currentPage,
    };
  } else if (
    resetWindow ||
    currentPage < previousRange.start ||
    currentPage > previousRange.end
  ) {
    activeRangeRef.current = stabilizePdfActiveRange(
      previousRange,
      currentPage,
      buffer,
      true,
    );
  } else {
    // Do not evict a page on every page-number transition. That creates a
    // feedback loop when the evicted shell and its rendered Markdown differ
    // slightly in height: 365 -> 366 changes layout -> detector sees 365 ->
    // the window changes back. Retain a small hysteresis band and trim only
    // after the reader is several pages beyond an edge.
    activeRangeRef.current = stabilizePdfActiveRange(
      previousRange,
      currentPage,
      buffer,
    );
  }

  const recordHeight = useCallback(
    (page: number, height: number, element: HTMLElement) => {
      const definition = pagesRef.current.get(page);
      const previousHeight =
        heightsRef.current.get(page) ?? definition?.estimatedHeight ?? height;
      const delta = height - previousHeight;
      if (Math.abs(delta) < 2) return;
      heightsRef.current.set(page, height);

      // Mounting a real page in place of its estimated shell—or a later KaTeX
      // reflow—must not move the content currently being read. Compensate for
      // measured height changes above it before the next paint.
      if (page >= currentPageRef.current) return;
      const scroller = element.closest<HTMLElement>(".thread-messages");
      if (!scroller) return;
      const previousScrollBehavior = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = "auto";
      scroller.scrollTop += delta;
      scroller.style.scrollBehavior = previousScrollBehavior;
    },
    [],
  );

  const activeRange = activeRangeRef.current;

  return pages.map((page) => {
    const active =
      renderAll ||
      (page.page >= activeRange.start && page.page <= activeRange.end);
    return (
      <PdfVirtualPage
        key={page.page}
        page={page}
        active={active}
        cachedHeight={heightsRef.current.get(page.page)}
        onHeight={recordHeight}
      />
    );
  });
});

const selectionCaptureByContainer = new WeakMap<HTMLElement, () => void>();
let selectionCaptureSubscriberCount = 0;
let selectionCaptureTimer: number | null = null;

function selectionContainerForNode(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(".markdown-message") ?? null;
}

function handleDocumentSelectionChange() {
  if (selectionCaptureTimer !== null) window.clearTimeout(selectionCaptureTimer);
  selectionCaptureTimer = window.setTimeout(() => {
    selectionCaptureTimer = null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const container = selectionContainerForNode(selection.getRangeAt(0).commonAncestorContainer);
    if (!container) return;
    selectionCaptureByContainer.get(container)?.();
  }, 80);
}

function subscribeToSelectionCapture(container: HTMLElement, capture: () => void) {
  selectionCaptureByContainer.set(container, capture);
  selectionCaptureSubscriberCount += 1;
  if (selectionCaptureSubscriberCount === 1) {
    document.addEventListener("selectionchange", handleDocumentSelectionChange);
  }

  return () => {
    selectionCaptureByContainer.delete(container);
    selectionCaptureSubscriberCount = Math.max(0, selectionCaptureSubscriberCount - 1);
    if (selectionCaptureSubscriberCount === 0) {
      document.removeEventListener("selectionchange", handleDocumentSelectionChange);
      if (selectionCaptureTimer !== null) {
        window.clearTimeout(selectionCaptureTimer);
        selectionCaptureTimer = null;
      }
    }
  };
}

interface MarkdownMessageProps {
  message: Message;
  nodeId: string;
  preserveSoftBreaks?: boolean;
  linkedAnchors: LinkedAnchor[];
  definitions: InlineDefinition[];
  visualizations: InlineVisualization[];
  inlineElaborations: InlineElaboration[];
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
  onOpenDefinition: (
    definitionId: string,
    rect: SelectionDraft["rect"],
    getAnchorRect?: () => SelectionDraft["rect"],
  ) => void;
  onOpenVisualization: (visualizationId: string) => void;
  onOpenInlineElaboration: (elaborationId: string) => void;
  onAnnotationContextMenu?: (
    target: AnnotationTarget,
    point: { left: number; top: number },
  ) => void;
  selectionSurface?: SelectionDraft["surface"];
  pdfVirtualization?: {
    currentPage: number;
    pageStart: number;
    buffer?: number;
    renderAll?: boolean;
  };
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

interface InlineElaborationRangeTarget {
  range: Range;
  elaborationId: string;
}

interface InlineElaborationBlockTarget {
  element: Element;
  elaborationId: string;
}

interface AnnotationClickChoice {
  target: AnnotationTarget;
  getBounds: () => DOMRect;
}

interface AnnotationChooserState {
  left: number;
  top: number;
  choices: AnnotationClickChoice[];
}

function textMap(container: HTMLElement): { text: string; points: Point[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (
        !parent ||
        parent.closest(
          ".katex-mathml, annotation, .elaboration-links, .inline-annotation-slot",
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
  const indexedBlock = element.closest<HTMLElement>("[data-markdown-block-index]");
  if (indexedBlock && container.contains(indexedBlock)) {
    const indexed = Number(indexedBlock.dataset.markdownBlockIndex);
    if (Number.isSafeInteger(indexed) && indexed >= 0) return indexed;
  }
  while (element.parentElement && element.parentElement !== container) {
    element = element.parentElement;
  }
  if (element instanceof HTMLElement) {
    const indexed = Number(element.dataset.markdownBlockIndex);
    if (Number.isSafeInteger(indexed) && indexed >= 0) return indexed;
  }
  return Math.max(0, topLevelBlocks(container).indexOf(element));
}

function topLevelBlocks(container: HTMLElement): Element[] {
  const virtualized = Array.from(
    container.querySelectorAll<HTMLElement>(
      ":scope > .pdf-virtual-page > [data-pdf-page-content='true']",
    ),
  );
  if (virtualized.length) {
    return virtualized.flatMap((page) =>
      Array.from(page.children).filter(
        (element) => !element.classList.contains("inline-annotation-slot"),
      ),
    );
  }
  return Array.from(container.children).filter(
    (element) =>
      !element.classList.contains("inline-annotation-slot") &&
      !element.classList.contains("pdf-virtual-page"),
  );
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
  preserveSoftBreaks = false,
  linkedAnchors,
  definitions,
  visualizations,
  inlineElaborations,
  onSelect,
  onOpenElaboration,
  onOpenDefinition,
  onOpenVisualization,
  onOpenInlineElaboration,
  onAnnotationContextMenu,
  selectionSurface = "message",
  pdfVirtualization,
}: MarkdownMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const targetsRef = useRef<RangeTarget[]>([]);
  const blockTargetsRef = useRef<BlockTarget[]>([]);
  const definitionTargetsRef = useRef<DefinitionRangeTarget[]>([]);
  const definitionBlockTargetsRef = useRef<DefinitionBlockTarget[]>([]);
  const visualizationTargetsRef = useRef<VisualizationRangeTarget[]>([]);
  const visualizationBlockTargetsRef = useRef<VisualizationBlockTarget[]>([]);
  const inlineElaborationTargetsRef = useRef<InlineElaborationRangeTarget[]>([]);
  const inlineElaborationBlockTargetsRef = useRef<InlineElaborationBlockTarget[]>([]);
  const [annotationChooser, setAnnotationChooser] =
    useState<AnnotationChooserState | null>(null);
  const renderedBlocksRef = useRef<Map<number, Element>>(new Map());
  const blockTextMapsRef = useRef<WeakMap<Element, ReturnType<typeof textMap>>>(new WeakMap());
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
  const inlineElaborationHighlightName = useMemo(
    () => `inline-elaboration-${message.id.replace(/[^a-zA-Z0-9-]/g, "")}`,
    [message.id],
  );
  const normalizedContent = useMemo(
    () => normalizeMathDelimiters(message.content, message.role === "source"),
    [message.content, message.role],
  );
  const documentIndex = useMemo(
    () => createMarkdownDocumentIndex(message.content, normalizedContent),
    [message.content, normalizedContent],
  );
  const pdfPages = useMemo(
    () =>
      pdfVirtualization
        ? createPdfMarkdownPages(
            normalizedContent,
            documentIndex,
            pdfVirtualization.pageStart,
          )
        : [],
    [documentIndex, normalizedContent, pdfVirtualization?.pageStart],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const blocks = topLevelBlocks(container);
    const indexedBlocks = new Map<number, Element>();
    blocks.forEach((block, fallbackIndex) => {
      const pageContent = block.parentElement?.closest<HTMLElement>(
        "[data-pdf-page-content='true']",
      );
      const blockStart = Number(pageContent?.dataset.blockStart);
      const localBlocks = pageContent
        ? Array.from(pageContent.children).filter(
            (element) => !element.classList.contains("inline-annotation-slot"),
          )
        : blocks;
      const localIndex = pageContent ? localBlocks.indexOf(block) : fallbackIndex;
      const index =
        Number.isSafeInteger(blockStart) && blockStart >= 0
          ? blockStart + Math.max(0, localIndex)
          : fallbackIndex;
      if (block instanceof HTMLElement) block.dataset.markdownBlockIndex = String(index);
      indexedBlocks.set(index, block);
    });
    renderedBlocksRef.current = indexedBlocks;
    blockTextMapsRef.current = new WeakMap();
    return () => {
      renderedBlocksRef.current = new Map();
      blockTextMapsRef.current = new WeakMap();
    };
  }, [
    normalizedContent,
    preserveSoftBreaks,
    pdfVirtualization?.currentPage,
    pdfVirtualization?.renderAll,
  ]);

  const indexedTextMap = (root: Element): ReturnType<typeof textMap> => {
    const existing = blockTextMapsRef.current.get(root);
    if (existing) return existing;
    const mapped = textMap(root as HTMLElement);
    blockTextMapsRef.current.set(root, mapped);
    return mapped;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !linkedAnchors.length) return;

    const ranges: Range[] = [];
    const targets: RangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: BlockTarget[] = [];

    for (const linked of linkedAnchors) {
      const block = renderedBlocksRef.current.get(linked.anchor.blockIndex);
      const searchRoot = block ?? (pdfVirtualization ? null : container);
      if (!searchRoot) continue;
      if (block) {
        block.classList.add("has-linked-elaboration");
        styledBlocks.push(block);
        blockTargets.push({ element: block, childId: linked.childId });
      }

      const { text, points } = indexedTextMap(searchRoot);
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
  }, [
    highlightName,
    linkedAnchors,
    message.content,
    pdfVirtualization?.currentPage,
    pdfVirtualization?.renderAll,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !definitions.length) return;

    const ranges: Range[] = [];
    const targets: DefinitionRangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: DefinitionBlockTarget[] = [];

    for (const definition of definitions) {
      const block = renderedBlocksRef.current.get(definition.anchor.blockIndex);
      const searchRoot = block instanceof HTMLElement
        ? block
        : pdfVirtualization
          ? null
          : container;
      if (!searchRoot) continue;
      const { text, points } = indexedTextMap(searchRoot);
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
  }, [
    definitionHighlightName,
    definitions,
    message.content,
    pdfVirtualization?.currentPage,
    pdfVirtualization?.renderAll,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !visualizations.length) return;

    const ranges: Range[] = [];
    const targets: VisualizationRangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: VisualizationBlockTarget[] = [];
    for (const visualization of visualizations) {
      const block = renderedBlocksRef.current.get(visualization.anchor.blockIndex);
      const searchRoot = block instanceof HTMLElement
        ? block
        : pdfVirtualization
          ? null
          : container;
      if (!searchRoot) continue;
      const { text, points } = indexedTextMap(searchRoot);
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
  }, [
    visualizationHighlightName,
    visualizations,
    message.content,
    pdfVirtualization?.currentPage,
    pdfVirtualization?.renderAll,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !inlineElaborations.length) return;

    const ranges: Range[] = [];
    const targets: InlineElaborationRangeTarget[] = [];
    const styledBlocks: Element[] = [];
    const blockTargets: InlineElaborationBlockTarget[] = [];
    for (const elaboration of inlineElaborations) {
      const block = renderedBlocksRef.current.get(elaboration.anchor.blockIndex);
      const searchRoot = block instanceof HTMLElement
        ? block
        : pdfVirtualization
          ? null
          : container;
      if (!searchRoot) continue;
      const { text, points } = indexedTextMap(searchRoot);
      const quote = normalizedQuote(elaboration.anchor.quote);
      const index = quote ? text.indexOf(quote) : -1;
      if (index >= 0 && points[index] && points[index + quote.length - 1]) {
        const start = points[index];
        const end = points[index + quote.length - 1];
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        ranges.push(range);
        targets.push({ range, elaborationId: elaboration.id });
        continue;
      }
      const mathRange = rangeForMathSource(searchRoot, elaboration.anchor.quote);
      if (mathRange) {
        ranges.push(mathRange);
        targets.push({ range: mathRange, elaborationId: elaboration.id });
      } else if (block) {
        block.classList.add("has-linked-inline-elaboration");
        styledBlocks.push(block);
        blockTargets.push({ element: block, elaborationId: elaboration.id });
      }
    }

    inlineElaborationTargetsRef.current = targets;
    inlineElaborationBlockTargetsRef.current = blockTargets;
    const css = CSS as typeof CSS & {
      highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
    };
    const HighlightConstructor = (
      window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const style = document.createElement("style");
    if (css.highlights && HighlightConstructor && ranges.length) {
      css.highlights.set(inlineElaborationHighlightName, new HighlightConstructor(...ranges));
      style.textContent = `::highlight(${inlineElaborationHighlightName}) { background: rgba(72, 170, 145, .3); text-decoration: underline; text-decoration-color: rgba(35, 125, 103, .72); text-underline-offset: 3px; }`;
      document.head.appendChild(style);
    }
    return () => {
      css.highlights?.delete(inlineElaborationHighlightName);
      style.remove();
      styledBlocks.forEach((block) => block.classList.remove("has-linked-inline-elaboration"));
      inlineElaborationTargetsRef.current = [];
      inlineElaborationBlockTargetsRef.current = [];
    };
  }, [
    inlineElaborationHighlightName,
    inlineElaborations,
    message.content,
    pdfVirtualization?.currentPage,
    pdfVirtualization?.renderAll,
  ]);

  const captureSelection = useCallback(() => {
    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const quote = sourceQuoteFromRange(range, container);
    if (!quote.trim() || quote.length > 12_000) return;
    const bounds = range.getBoundingClientRect();
    const startBlockIndex = topLevelBlockIndex(container, range.startContainer);
    const endBlockIndex = topLevelBlockIndex(container, range.endContainer);
    const section = containingOriginalMarkdownSection(
      message.content,
      normalizedContent,
      startBlockIndex,
      endBlockIndex,
      documentIndex,
    );
    const anchor = anchorForSelection(
      message.content,
      {
        sourceNodeId: nodeId,
        sourceMessageId: message.id,
        quote,
        blockIndex: startBlockIndex,
      },
      endBlockIndex,
      section,
    );
    const mappedSource = message.content.slice(anchor.start, anchor.end);
    const rawMarkdown =
      mappedSource &&
      mappedSource.length <= Math.max(quote.length * 4, quote.length + 256)
        ? mappedSource
        : quote;
    onSelect({
      ...anchor,
      rawMarkdown,
      surface: selectionSurface,
      endBlockIndex,
      sectionStart: section.start,
      sectionEnd: section.end,
      sectionContent: section.content,
      rect: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    });
  }, [
    message.content,
    message.id,
    nodeId,
    normalizedContent,
    documentIndex,
    onSelect,
    selectionSurface,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return subscribeToSelectionCapture(container, captureSelection);
  }, [captureSelection]);

  const annotationAnchorForTarget = (target: AnnotationTarget): HighlightAnchor | undefined => {
    if (target.kind === "branch") {
      return linkedAnchors.find((linked) => linked.childId === target.id)?.anchor;
    }
    if (target.kind === "definition") {
      return definitions.find((definition) => definition.id === target.id)?.anchor;
    }
    if (target.kind === "visualization") {
      return visualizations.find((visualization) => visualization.id === target.id)?.anchor;
    }
    return inlineElaborations.find((elaboration) => elaboration.id === target.id)?.anchor;
  };

  const annotationChoicesAtPoint = (
    targetNode: EventTarget | null,
    clientX: number,
    clientY: number,
  ): AnnotationClickChoice[] => {
    const rangeContainsPoint = (range: Range) =>
      Array.from(range.getClientRects()).some(
        (rect) =>
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom,
      );
    const elementContainsTarget = (element: Element) =>
      targetNode instanceof Node && element.contains(targetNode);
    const exact: AnnotationClickChoice[] = [];
    definitionTargetsRef.current.forEach((target) => {
      if (rangeContainsPoint(target.range)) {
        exact.push({
          target: { kind: "definition", id: target.definitionId },
          getBounds: () => target.range.getBoundingClientRect(),
        });
      }
    });
    inlineElaborationTargetsRef.current.forEach((target) => {
      if (rangeContainsPoint(target.range)) {
        exact.push({
          target: { kind: "inline-elaboration", id: target.elaborationId },
          getBounds: () => target.range.getBoundingClientRect(),
        });
      }
    });
    visualizationTargetsRef.current.forEach((target) => {
      if (rangeContainsPoint(target.range)) {
        exact.push({
          target: { kind: "visualization", id: target.visualizationId },
          getBounds: () => target.range.getBoundingClientRect(),
        });
      }
    });
    targetsRef.current.forEach((target) => {
      if (rangeContainsPoint(target.range)) {
        exact.push({
          target: { kind: "branch", id: target.childId },
          getBounds: () => target.range.getBoundingClientRect(),
        });
      }
    });

    const blockCandidates = [
          ...definitionBlockTargetsRef.current
            .filter((target) => elementContainsTarget(target.element))
            .map((target) => ({
              target: { kind: "definition", id: target.definitionId } as AnnotationTarget,
              getBounds: () => target.element.getBoundingClientRect(),
            })),
          ...inlineElaborationBlockTargetsRef.current
            .filter((target) => elementContainsTarget(target.element))
            .map((target) => ({
              target: {
                kind: "inline-elaboration",
                id: target.elaborationId,
              } as AnnotationTarget,
              getBounds: () => target.element.getBoundingClientRect(),
            })),
          ...visualizationBlockTargetsRef.current
            .filter((target) => elementContainsTarget(target.element))
            .map((target) => ({
              target: {
                kind: "visualization",
                id: target.visualizationId,
              } as AnnotationTarget,
              getBounds: () => target.element.getBoundingClientRect(),
            })),
          ...blockTargetsRef.current
            .filter((target) => elementContainsTarget(target.element))
            .map((target) => ({
              target: { kind: "branch", id: target.childId } as AnnotationTarget,
              getBounds: () => target.element.getBoundingClientRect(),
            })),
        ];
    const logicalOverlaps: AnnotationClickChoice[] = [];
    if (exact.length) {
      const allTargets: AnnotationTarget[] = [
        ...linkedAnchors.map((linked) => ({ kind: "branch", id: linked.childId } as const)),
        ...definitions.map((definition) => ({ kind: "definition", id: definition.id } as const)),
        ...visualizations.map((visualization) => ({ kind: "visualization", id: visualization.id } as const)),
        ...inlineElaborations.map((elaboration) => ({
          kind: "inline-elaboration",
          id: elaboration.id,
        } as const)),
      ];
      allTargets.forEach((target) => {
        if (exact.some((choice) =>
          choice.target.kind === target.kind && choice.target.id === target.id
        )) return;
        const anchor = annotationAnchorForTarget(target);
        if (!anchor) return;
        const matchingExact = exact.find((choice) => {
          const exactAnchor = annotationAnchorForTarget(choice.target);
          if (!exactAnchor) return false;
          const sameStoredRange =
            Number.isSafeInteger(anchor.start) &&
            Number.isSafeInteger(anchor.end) &&
            anchor.start === exactAnchor.start &&
            anchor.end === exactAnchor.end;
          return sameStoredRange || anchor.quote.trim() === exactAnchor.quote.trim();
        });
        if (matchingExact) {
          logicalOverlaps.push({ target, getBounds: matchingExact.getBounds });
        }
      });
    }
    const candidates = exact.length
      ? [
          ...exact,
          ...logicalOverlaps,
          ...blockCandidates.filter((candidate) => {
            const candidateAnchor = annotationAnchorForTarget(candidate.target);
            if (!candidateAnchor) return false;
            return exact.some((exactChoice) => {
              const exactAnchor = annotationAnchorForTarget(exactChoice.target);
              if (!exactAnchor) return false;
              const sameStoredRange =
                Number.isSafeInteger(candidateAnchor.start) &&
                Number.isSafeInteger(candidateAnchor.end) &&
                candidateAnchor.start === exactAnchor.start &&
                candidateAnchor.end === exactAnchor.end;
              return (
                sameStoredRange ||
                candidateAnchor.quote.trim() === exactAnchor.quote.trim()
              );
            });
          }),
        ]
      : blockCandidates;

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.target.kind}:${candidate.target.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const openAnnotationChoice = (choice: AnnotationClickChoice) => {
    setAnnotationChooser(null);
    if (choice.target.kind === "definition") {
      const getAnchorRect = () => {
        const bounds = choice.getBounds();
        return {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        };
      };
      onOpenDefinition(choice.target.id, getAnchorRect(), getAnchorRect);
      return;
    }
    if (choice.target.kind === "inline-elaboration") {
      onOpenInlineElaboration(choice.target.id);
      return;
    }
    if (choice.target.kind === "visualization") {
      onOpenVisualization(choice.target.id);
      return;
    }
    onOpenElaboration(choice.target.id);
  };

  const annotationChoiceText = (target: AnnotationTarget) => {
    if (target.kind === "branch") {
      return linkedAnchors.find((linked) => linked.childId === target.id)?.title ?? "Elaboration";
    }
    if (target.kind === "definition") {
      return definitions.find((definition) => definition.id === target.id)?.anchor.quote ?? "Definition";
    }
    if (target.kind === "visualization") {
      return visualizations.find((visualization) => visualization.id === target.id)?.anchor.quote ?? "Visualization";
    }
    return inlineElaborations.find((elaboration) => elaboration.id === target.id)?.anchor.quote ?? "Inline elaboration";
  };

  const annotationChoiceKind = (kind: AnnotationTarget["kind"]) => {
    if (kind === "branch") return "Branch";
    if (kind === "definition") return "Definition";
    if (kind === "visualization") return "Visualization";
    return "Inline elaboration";
  };

  useEffect(() => {
    if (!annotationChooser) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnnotationChooser(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [annotationChooser]);

  return (
    <div
      className={`markdown-message${preserveSoftBreaks ? " markdown-message--preserve-soft-breaks" : ""}`}
      ref={containerRef}
      onMouseUp={(event) => {
        if (
          selectionSurface !== "inline-elaboration" &&
          event.target instanceof Element &&
          event.target.closest(".inline-annotation-slot")
        ) return;
        captureSelection();
        if (selectionSurface === "inline-elaboration") event.stopPropagation();
      }}
      onTouchEnd={(event) => {
        if (
          selectionSurface !== "inline-elaboration" &&
          event.target instanceof Element &&
          event.target.closest(".inline-annotation-slot")
        ) return;
        window.setTimeout(captureSelection, 80);
        if (selectionSurface === "inline-elaboration") event.stopPropagation();
      }}
      onKeyUp={(event) => {
        if (
          selectionSurface !== "inline-elaboration" &&
          event.target instanceof Element &&
          event.target.closest(".inline-annotation-slot")
        ) return;
        captureSelection();
        if (selectionSurface === "inline-elaboration") event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (!onAnnotationContextMenu) return;
        const annotation = annotationChoicesAtPoint(
          event.target,
          event.clientX,
          event.clientY,
        )[0]?.target;
        if (!annotation) return;
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        onAnnotationContextMenu(annotation, {
          left: event.clientX,
          top: event.clientY,
        });
      }}
      onClickCapture={(event) => {
        if (
          selectionSurface !== "inline-elaboration" &&
          event.target instanceof Element &&
          event.target.closest(".inline-annotation-slot")
        ) return;
        if (window.getSelection()?.toString()) return;
        const interactive =
          event.target instanceof Element ? event.target.closest("a, button") : null;
        if (interactive) return;

        const choices = annotationChoicesAtPoint(
          event.target,
          event.clientX,
          event.clientY,
        );
        if (!choices.length) return;
        event.preventDefault();
        if (choices.length === 1) {
          openAnnotationChoice(choices[0]);
          return;
        }
        setAnnotationChooser({
          left: event.clientX,
          top: event.clientY,
          choices,
        });
      }}
    >
      {pdfVirtualization ? (
        <VirtualizedPdfMarkdownBody
          pages={pdfPages}
          currentPage={pdfVirtualization.currentPage}
          buffer={pdfVirtualization.buffer ?? 10}
          renderAll={Boolean(pdfVirtualization.renderAll)}
        />
      ) : (
        <RenderedMarkdownBody
          content={normalizedContent}
          preserveSoftBreaks={preserveSoftBreaks}
        />
      )}
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
      {annotationChooser && (
        <div
          className="annotation-choice-backdrop"
          onPointerDown={() => setAnnotationChooser(null)}
        >
          <div
            className="annotation-choice-menu"
            role="menu"
            aria-label="Choose a highlight"
            style={{
              left: Math.max(8, Math.min(annotationChooser.left, window.innerWidth - 288)),
              top: Math.max(8, Math.min(annotationChooser.top, window.innerHeight - 260)),
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>Choose highlight</strong>
              <span>{annotationChooser.choices.length} overlap here</span>
            </header>
            {annotationChooser.choices.map((choice) => (
              <button
                type="button"
                role="menuitem"
                key={`${choice.target.kind}:${choice.target.id}`}
                onClick={() => openAnnotationChoice(choice)}
              >
                <small>{annotationChoiceKind(choice.target.kind)}</small>
                <InlineMath source={annotationChoiceText(choice.target)} />
              </button>
            ))}
          </div>
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

function sameInlineElaborations(
  left: InlineElaboration[],
  right: InlineElaboration[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((elaboration, index) => {
        const candidate = right[index];
        return (
          elaboration.id === candidate.id &&
          elaboration.anchor.sourceNodeId === candidate.anchor.sourceNodeId &&
          elaboration.anchor.sourceMessageId === candidate.anchor.sourceMessageId &&
          elaboration.anchor.quote === candidate.anchor.quote &&
          elaboration.anchor.blockIndex === candidate.anchor.blockIndex
        );
      }))
  );
}

function samePdfVirtualization(
  left: MarkdownMessageProps["pdfVirtualization"],
  right: MarkdownMessageProps["pdfVirtualization"],
): boolean {
  return (
    left === right ||
    (left?.currentPage === right?.currentPage &&
      left?.pageStart === right?.pageStart &&
      left?.buffer === right?.buffer &&
      left?.renderAll === right?.renderAll)
  );
}

export const MarkdownMessage = memo(
  MarkdownMessageComponent,
  (left, right) =>
    left.nodeId === right.nodeId &&
    sameMessage(left.message, right.message) &&
    sameLinkedAnchors(left.linkedAnchors, right.linkedAnchors) &&
    sameDefinitions(left.definitions, right.definitions) &&
    sameVisualizations(left.visualizations, right.visualizations) &&
    sameInlineElaborations(left.inlineElaborations, right.inlineElaborations) &&
    left.preserveSoftBreaks === right.preserveSoftBreaks &&
    left.selectionSurface === right.selectionSurface &&
    samePdfVirtualization(left.pdfVirtualization, right.pdfVirtualization),
);
