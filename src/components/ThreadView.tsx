import {
  ArrowRight,
  ChevronDown,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Copy,
  ExternalLink,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Printer,
  RotateCcw,
  Search,
  Sparkles,
  Square,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  AnnotationTarget,
  ChatTree,
  HighlightAnchor,
  InlineDefinition,
  InlineElaboration,
  InlineVisualization,
  SelectionDraft,
  ThreadNode,
  ReasoningEffort,
  SendShortcut,
  ProviderId,
  ProviderModelOption,
  PdfPageFurniture,
  PdfTocEntry,
  VisualizationContextScope,
  VisualizationEngine,
} from "../types";
import { activeEditContent, childThreads, messagesForNode } from "../lib/tree";
import { formatDuration, generationDetails } from "../lib/generation";
import { applyMarkdownShortcut } from "../lib/textarea";
import { compatibleReasoningEffort } from "../lib/providers";
import { countTextTokens } from "../lib/tokenContext";
import {
  createPdfSearchPages,
  searchPdfPages,
} from "../lib/pdfVirtualization";
import { Composer } from "./Composer";
import { MarkdownMessage, type LinkedAnchor } from "./MarkdownMessage";
import { MODEL_OPTIONS, REASONING_OPTIONS } from "./ModelPicker";
import { VisualizationCard } from "./VisualizationCard";
import { InlineElaborationCard } from "./InlineElaborationCard";

const EMPTY_LINKED_ANCHORS: LinkedAnchor[] = [];
const EMPTY_DEFINITIONS: InlineDefinition[] = [];
const EMPTY_VISUALIZATIONS: InlineVisualization[] = [];
const EMPTY_INLINE_ELABORATIONS: InlineElaboration[] = [];

function highlightPdfSearchMatches(text: string, rawQuery: string): ReactNode {
  const query = rawQuery.trim();
  if (!query) return text;

  const searchable = text.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = searchable.indexOf(normalizedQuery);

  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex));
    const matchEnd = matchIndex + query.length;
    parts.push(
      <strong key={`${matchIndex}-${matchEnd}`}>
        {text.slice(matchIndex, matchEnd)}
      </strong>,
    );
    cursor = matchEnd;
    matchIndex = searchable.indexOf(normalizedQuery, matchEnd);
  }

  if (!parts.length) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function renderedMessageArticles(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(":scope > article[data-message-id]"),
  );
}

function pdfPageAtReadingLine(
  container: HTMLElement,
  readingLine: number,
): number | null {
  const shells = container.querySelectorAll<HTMLElement>("[data-pdf-page-shell]");
  if (!shells.length) return null;

  // Every PDF page keeps a lightweight shell while its Markdown is
  // virtualized. Binary-search those shells instead of relying exclusively on
  // elementFromPoint(), which can temporarily return the scrolling container
  // itself during fast mobile momentum scrolling or a drawer layout change.
  let low = 0;
  let high = shells.length - 1;
  let candidateIndex = shells.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bounds = shells[middle].getBoundingClientRect();
    if (bounds.bottom > readingLine) {
      candidateIndex = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  let candidate = shells[candidateIndex];
  const candidateBounds = candidate.getBoundingClientRect();
  if (candidateBounds.top > readingLine && candidateIndex > 0) {
    const previous = shells[candidateIndex - 1];
    const previousBounds = previous.getBoundingClientRect();
    if (
      readingLine - previousBounds.bottom <=
      candidateBounds.top - readingLine
    ) {
      candidate = previous;
    }
  }

  const page = Number(candidate.dataset.pdfPageShell);
  return Number.isInteger(page) ? page : null;
}

interface ThreadViewProps {
  chat: ChatTree;
  node: ThreadNode;
  side?: boolean;
  readOnly?: boolean;
  initialPdfPage?: number;
  onPdfPageChange?: (page: number) => void;
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
  onOpenDefinition: (
    definitionId: string,
    rect: SelectionDraft["rect"],
    getAnchorRect?: () => SelectionDraft["rect"],
  ) => void;
  onGenerateVisualization: (
    visualizationId: string,
    hint: string,
    engine: VisualizationEngine,
    contextScope: VisualizationContextScope,
  ) => void;
  onFixVisualization: (visualizationId: string, instruction: string) => void;
  onCompileVisualization: (visualizationId: string, source: string) => void;
  onStopVisualization: (visualizationId: string) => void;
  onDeleteVisualization: (visualizationId: string) => void;
  onGenerateInlineElaboration: (elaborationId: string, hint: string) => void;
  onStopInlineElaboration: (elaborationId: string) => void;
  onDeleteInlineElaboration: (elaborationId: string) => void;
  onElaborateFurther: (elaborationId: string) => void;
  onSend: (message: string) => void;
  onStop: (assistantId: string) => void;
  onEditMessage: (revisionGroupId: string, content: string) => void;
  onEditSource: (messageId: string) => void;
  onEditAssistant: (messageId: string) => void;
  onRevertSourceEdit: (messageId: string) => void;
  onRegenerateResponse: (
    assistantId: string,
    modelOverride?: string,
    reasoningEffortOverride?: ReasoningEffort,
  ) => void;
  onSwitchMessageRevision: (revisionGroupId: string, variantId: string) => void;
  onSwitchResponseRevision: (responseGroupId: string, responseId: string) => void;
  onSwitchAssistantEdit: (assistantMessageId: string, variantId: string) => void;
  onAnnotationContextMenu?: (
    nodeId: string,
    target: AnnotationTarget,
    point: { left: number; top: number },
  ) => void;
  provider: ProviderId;
  modelOptions?: ProviderModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  sendShortcut: SendShortcut;
  draftNamespace?: string;
  composerInsertion?: { id: string; value: string };
  onComposerInsertionApplied?: (id: string) => void;
  scrollRequest?: { id: string; anchor: HighlightAnchor };
  onScrollRequestHandled?: (id: string) => void;
}

async function writeMarkdownToClipboard(markdown: string): Promise<void> {
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fallback = document.createElement("textarea");
  fallback.value = markdown;
  fallback.setAttribute("readonly", "");
  fallback.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(fallback);
  fallback.select();
  fallback.setSelectionRange(0, fallback.value.length);
  const copiedSynchronously = document.execCommand("copy");
  fallback.remove();
  activeElement?.focus();
  if (copiedSynchronously) return;

  await navigator.clipboard.writeText(markdown);
}

function ThinkingIndicator({ startedAt }: { startedAt: string }) {
  const started = Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : Date.now();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, []);

  const elapsed = formatDuration(Math.max(0, now - started));
  return (
    <div className="thinking" aria-label={`Locus is thinking, ${elapsed} elapsed`}>
      <span />
      <span />
      <span />
      <em>Working through the steps…</em>
      <time>{elapsed}</time>
    </div>
  );
}

function AnchoredInlineMount({
  messagesRef,
  messageId,
  messageContent,
  annotationId,
  blockIndex,
  children,
}: {
  messagesRef: RefObject<HTMLDivElement | null>;
  messageId: string;
  messageContent: string;
  annotationId: string;
  blockIndex: number;
  children: ReactNode;
}) {
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = document.createElement("div");
    slot.className = "inline-annotation-slot";
    slot.dataset.annotationSlot = annotationId;
    slot.dataset.blockIndex = String(blockIndex);
    let frame: number | null = null;
    let attempts = 0;
    let disposed = false;

    const place = () => {
      const article = messagesRef.current?.querySelector<HTMLElement>(
        `article[data-message-id="${CSS.escape(messageId)}"]`,
      );
      const block = article?.querySelector<HTMLElement>(
        `[data-markdown-block-index="${blockIndex}"]`,
      );
      if (!block) return false;
      const mountParent = block.parentElement;
      if (!mountParent) return false;
      if (slot.parentElement === mountParent) return true;

      const existingSlots = Array.from(
        mountParent.querySelectorAll<HTMLElement>(
          `:scope > .inline-annotation-slot[data-block-index="${blockIndex}"]`,
        ),
      ).filter((candidate) => candidate !== slot);
      const lastSlot = existingSlots.at(-1);
      mountParent.insertBefore(slot, lastSlot ? lastSlot.nextSibling : block.nextSibling);
      return true;
    };

    const schedulePlacement = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        attempts += 1;
        if (!place() && attempts < 60) schedulePlacement();
      });
    };

    const root = messagesRef.current;
    const observer = root
      ? new MutationObserver(() => {
          if (slot.isConnected) return;
          attempts = 0;
          schedulePlacement();
        })
      : null;
    observer?.observe(root!, { childList: true, subtree: true });
    setMount(slot);
    if (!place()) schedulePlacement();
    return () => {
      disposed = true;
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      setMount(null);
      slot.remove();
    };
  }, [annotationId, blockIndex, messageContent, messageId, messagesRef]);

  return mount ? createPortal(children, mount) : null;
}

function RevisionSwitcher({
  label,
  activeIndex,
  variantIds,
  disabled,
  onSwitch,
}: {
  label: "message" | "response" | "edit";
  activeIndex: number;
  variantIds: string[];
  disabled: boolean;
  onSwitch: (variantId: string) => void;
}) {
  if (variantIds.length < 2) return null;
  return (
    <span className="revision-switcher" aria-label={`${label} versions`}>
      <button
        type="button"
        aria-label={`Previous ${label} version`}
        disabled={disabled || activeIndex === 0}
        onClick={() => onSwitch(variantIds[activeIndex - 1])}
      >
        <ChevronLeft size={12} />
      </button>
      <span>{activeIndex + 1} / {variantIds.length}</span>
      <button
        type="button"
        aria-label={`Next ${label} version`}
        disabled={disabled || activeIndex === variantIds.length - 1}
        onClick={() => onSwitch(variantIds[activeIndex + 1])}
      >
        <ChevronRight size={12} />
      </button>
    </span>
  );
}

export function ThreadView({
  chat,
  node,
  side,
  readOnly = false,
  initialPdfPage,
  onPdfPageChange,
  onSelect,
  onOpenElaboration,
  onOpenDefinition,
  onGenerateVisualization,
  onFixVisualization,
  onCompileVisualization,
  onStopVisualization,
  onDeleteVisualization,
  onGenerateInlineElaboration,
  onStopInlineElaboration,
  onDeleteInlineElaboration,
  onElaborateFurther,
  onSend,
  onStop,
  onEditMessage,
  onEditSource,
  onEditAssistant,
  onRevertSourceEdit,
  onRegenerateResponse,
  onSwitchMessageRevision,
  onSwitchResponseRevision,
  onSwitchAssistantEdit,
  onAnnotationContextMenu,
  provider,
  modelOptions,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  sendShortcut,
  draftNamespace,
  composerInsertion,
  onComposerInsertionApplied,
  scrollRequest,
  onScrollRequestHandled,
}: ThreadViewProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // MarkdownMessage deliberately ignores callback identity while memoizing expensive
  // rendered math. Keep its handler stable while forwarding to the latest app state.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const dispatchSelection = useCallback(
    (selection: SelectionDraft) => onSelectRef.current(selection),
    [],
  );
  const copyResetTimer = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const visualizationScrollFrame = useRef<number | null>(null);
  const pdfJumpCleanupRef = useRef<(() => void) | null>(null);
  const pdfJumpPageRef = useRef<number | null>(null);
  const pdfSearchFocusFrameRef = useRef<number | null>(null);
  const pdfSearchFocusTimerRef = useRef<number | null>(null);
  const currentPdfPageRef = useRef(1);
  const pdfViewportAnchorRef = useRef<{ page: number; top: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [messageNavigationVisible, setMessageNavigationVisible] = useState(false);
  const [copyState, setCopyState] = useState<{
    messageId: string;
    status: "copied" | "failed";
  } | null>(null);
  const [regenerationSettings, setRegenerationSettings] = useState<{
    messageId: string;
    model: string;
    reasoningEffort: ReasoningEffort;
  } | null>(null);
  const pdfSource =
    !readOnly &&
    node.id === chat.rootId &&
    chat.source?.kind === "pdf" &&
    chat.source.status === "ready"
      ? chat.source
      : null;
  const pdfPageStart = pdfSource?.pageStart ?? 1;
  const pdfPageEnd = pdfSource?.pageEnd ?? pdfSource?.pageCount ?? 1;
  const boundedInitialPdfPage =
    Number.isSafeInteger(initialPdfPage) && initialPdfPage !== undefined
      ? Math.min(pdfPageEnd, Math.max(pdfPageStart, initialPdfPage))
      : pdfPageStart;
  const [currentPdfPage, setCurrentPdfPage] = useState(boundedInitialPdfPage);
  const [pdfPageInput, setPdfPageInput] = useState(String(boundedInitialPdfPage));
  const [pdfToc, setPdfToc] = useState<PdfTocEntry[]>([]);
  const [pdfTocOpen, setPdfTocOpen] = useState(false);
  const [pdfTocLoading, setPdfTocLoading] = useState(false);
  const [pdfTocError, setPdfTocError] = useState<string | null>(null);
  const [pdfTocQuery, setPdfTocQuery] = useState("");
  const [pdfTocCenterRequest, setPdfTocCenterRequest] = useState(0);
  const [pdfSearchOpen, setPdfSearchOpen] = useState(false);
  const [pdfSearchQuery, setPdfSearchQuery] = useState("");
  const [pdfSearchActiveIndex, setPdfSearchActiveIndex] = useState(-1);
  const [pdfFurniture, setPdfFurniture] = useState<PdfPageFurniture[]>([]);
  const [pdfTokenCount, setPdfTokenCount] = useState<number | null>(null);
  const [pdfTokenCountError, setPdfTokenCountError] = useState(false);
  const [printAllPdfPages, setPrintAllPdfPages] = useState(false);
  currentPdfPageRef.current = currentPdfPage;
  const pdfDocumentRef = useRef(pdfSource?.documentId ?? null);
  const pendingPdfRestoreRef = useRef<number | null>(
    pdfSource ? boundedInitialPdfPage : null,
  );
  const pdfNavigationRef = useRef<HTMLDivElement>(null);
  const pdfSearchInputRef = useRef<HTMLInputElement>(null);
  const [collapsedPdfComposerNodeId, setCollapsedPdfComposerNodeId] = useState<
    string | null
  >(() => (pdfSource && !side ? node.id : null));
  const children = useMemo(() => childThreads(chat, node.id), [chat, node.id]);
  const messages = useMemo(() => messagesForNode(node), [node]);
  const pdfMarkdown = pdfSource
    ? messages.find((message) => message.role === "source")?.content ?? ""
    : "";
  const pdfSearchPages = useMemo(
    () => createPdfSearchPages(pdfMarkdown, pdfPageStart),
    [pdfMarkdown, pdfPageStart],
  );
  const deferredPdfSearchQuery = useDeferredValue(pdfSearchQuery);
  const pdfSearchResult = useMemo(
    () => searchPdfPages(pdfSearchPages, deferredPdfSearchQuery, 300),
    [deferredPdfSearchQuery, pdfSearchPages],
  );
  const pdfComposerCollapsed =
    Boolean(pdfSource && !side) && collapsedPdfComposerNodeId === node.id;
  const linkedAnchorsByMessage = useMemo(() => {
    const anchors = new Map<string, LinkedAnchor[]>();
    children.forEach((child) => {
      if (!child.anchor) return;
      const linked: LinkedAnchor = {
        childId: child.id,
        title: child.title,
        anchor: child.anchor,
      };
      const messageAnchors = anchors.get(child.anchor.sourceMessageId);
      if (messageAnchors) messageAnchors.push(linked);
      else anchors.set(child.anchor.sourceMessageId, [linked]);
    });
    return anchors;
  }, [children]);
  const definitionsByMessage = useMemo(() => {
    const definitions = new Map<string, InlineDefinition[]>();
    (node.definitions ?? []).forEach((definition) => {
      const messageDefinitions = definitions.get(definition.anchor.sourceMessageId);
      if (messageDefinitions) messageDefinitions.push(definition);
      else definitions.set(definition.anchor.sourceMessageId, [definition]);
    });
    return definitions;
  }, [node.definitions]);
  const visualizationsByMessage = useMemo(() => {
    const visualizations = new Map<string, InlineVisualization[]>();
    (node.visualizations ?? []).forEach((visualization) => {
      const messageVisualizations = visualizations.get(visualization.anchor.sourceMessageId);
      if (messageVisualizations) messageVisualizations.push(visualization);
      else visualizations.set(visualization.anchor.sourceMessageId, [visualization]);
    });
    return visualizations;
  }, [node.visualizations]);
  const inlineElaborationsByMessage = useMemo(() => {
    const elaborations = new Map<string, InlineElaboration[]>();
    (node.inlineElaborations ?? []).forEach((elaboration) => {
      const messageElaborations = elaborations.get(elaboration.anchor.sourceMessageId);
      if (messageElaborations) messageElaborations.push(elaboration);
      else elaborations.set(elaboration.anchor.sourceMessageId, [elaboration]);
    });
    return elaborations;
  }, [node.inlineElaborations]);
  const pendingAssistant = messages.find(
    (message) => message.role === "assistant" && message.pending,
  );
  const waiting = Boolean(pendingAssistant);
  const regenerationModelOptions = useMemo(() => {
    const options =
      provider === "openai"
        ? MODEL_OPTIONS.map((option) => ({
            id: option.value,
            label: `${option.label} · ${option.note}`,
          }))
        : (modelOptions ?? []).map((option) => ({
            id: option.id,
            label: option.name ?? option.id,
          }));
    if (model && !options.some((option) => option.id === model)) {
      options.unshift({ id: model, label: model });
    }
    return options;
  }, [model, modelOptions, provider]);

  useEffect(() => {
    if (waiting) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [node.messages.length, waiting]);

  useEffect(() => {
    pdfJumpCleanupRef.current?.();
    pdfJumpPageRef.current = null;
    pdfViewportAnchorRef.current = null;
    setEditingMessageId(null);
    setEditValue("");
    setCopyState(null);
    setRegenerationSettings(null);
    setCurrentMessageIndex(0);
    setMessageNavigationVisible(false);
  }, [node.id]);

  useEffect(() => {
    const nextDocumentId = pdfSource?.documentId ?? null;
    const restoredPage =
      Number.isSafeInteger(initialPdfPage) && initialPdfPage !== undefined
        ? Math.min(pdfPageEnd, Math.max(pdfPageStart, initialPdfPage))
        : pdfPageStart;
    if (pdfDocumentRef.current !== nextDocumentId) {
      pdfDocumentRef.current = nextDocumentId;
      pendingPdfRestoreRef.current = pdfSource ? restoredPage : null;
    }
    currentPdfPageRef.current = restoredPage;
    setCurrentPdfPage(restoredPage);
    setPdfPageInput(String(restoredPage));
    setPdfToc([]);
    setPdfTocOpen(false);
    setPdfTocError(null);
    setPdfTocQuery("");
    setPdfSearchOpen(false);
    setPdfSearchQuery("");
    setPdfSearchActiveIndex(-1);
    setCollapsedPdfComposerNodeId(pdfSource && !side ? node.id : null);
    if (!pdfSource) return;
    const controller = new AbortController();
    setPdfTocLoading(true);
    void fetch(
      `/api/pdf-documents/${encodeURIComponent(pdfSource.documentId)}/toc`,
      {
        credentials: "same-origin",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          | { items?: PdfTocEntry[]; error?: string }
          | null;
        if (!response.ok) {
          throw new Error(result?.error || "Could not load the PDF contents");
        }
        const items = Array.isArray(result?.items)
          ? result.items.filter(
              (item) =>
                Number.isInteger(item.level) &&
                typeof item.title === "string" &&
                Number.isInteger(item.page) &&
                item.page >= pdfPageStart &&
                item.page <= pdfPageEnd,
            )
          : [];
        setPdfToc(items);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPdfTocError(
          error instanceof Error ? error.message : "Could not load the PDF contents",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPdfTocLoading(false);
      });
    return () => controller.abort();
  }, [node.id, pdfSource?.documentId, pdfPageEnd, pdfPageStart, side]);

  useEffect(() => {
    let disposed = false;
    setPdfTokenCount(null);
    setPdfTokenCountError(false);
    if (!pdfSource || !pdfMarkdown) return;
    void countTextTokens(pdfMarkdown)
      .then((count) => {
        if (!disposed) setPdfTokenCount(count);
      })
      .catch(() => {
        if (!disposed) setPdfTokenCountError(true);
      });
    return () => {
      disposed = true;
    };
  }, [pdfMarkdown, pdfSource?.documentId]);

  useEffect(() => {
    setPdfFurniture(pdfSource?.pageFurniture ?? []);
    if (!pdfSource) return;
    if (pdfSource.pageFurniture !== undefined) return;
    const controller = new AbortController();
    void fetch(
      `/api/pdf-documents/${encodeURIComponent(pdfSource.documentId)}/layout`,
      {
        credentials: "same-origin",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          | { pages?: PdfPageFurniture[] }
          | null;
        if (!response.ok || !Array.isArray(result?.pages)) return;
        setPdfFurniture(result.pages);
      })
      .catch(() => {
        // Layout semantics enhance a completed import. Plain Markdown remains
        // fully usable when an older worker does not expose them.
      });
    return () => controller.abort();
  }, [pdfSource?.documentId, pdfSource?.pageFurniture]);

  useLayoutEffect(() => {
    const sourceMessage = pdfSource
      ? messages.find((message) => message.role === "source")
      : null;
    const article = sourceMessage
      ? messagesRef.current?.querySelector<HTMLElement>(
          `article[data-message-id="${CSS.escape(sourceMessage.id)}"]`,
        )
      : null;
    const markdown = article?.querySelector<HTMLElement>(".markdown-message");
    if (!markdown || !pdfFurniture.length) return;

    const furnitureByPage = new Map(
      pdfFurniture.map((page) => [page.page, page]),
    );
    const styled: HTMLElement[] = [];

    const applyFurniture = (
      element: HTMLElement,
      kind: "header" | "footer",
      item: PdfPageFurniture["headers"][number],
    ) => {
      element.classList.add(
        "pdf-running-furniture",
        `pdf-running-furniture--${kind}`,
        `pdf-running-furniture--${item.align}`,
      );
      if (item.row_index === 0) {
        element.classList.add("pdf-running-furniture--row-start");
      } else {
        element.classList.add("pdf-running-furniture--overlay");
      }
      if (item.row_index === item.row_size - 1) {
        element.classList.add("pdf-running-furniture--row-end");
      }
      element.dataset.pdfFurniture = kind;
      element.setAttribute(
        "aria-label",
        `PDF page ${kind}: ${item.content}`,
      );
      styled.push(element);
    };

    const activePages = Array.from(
      markdown.querySelectorAll<HTMLElement>(
        ":scope > .pdf-virtual-page > [data-pdf-page-content='true']",
      ),
    );
    activePages.forEach((pageContent) => {
      const shell = pageContent.closest<HTMLElement>("[data-pdf-page-shell]");
      const page = Number(shell?.dataset.pdfPageShell);
      const pageFurniture = furnitureByPage.get(page);
      if (!pageFurniture) return;
      const blocks = Array.from(pageContent.children).filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          !element.classList.contains("inline-annotation-slot"),
      );
      const markerIndex = blocks.findIndex((element) =>
        Boolean(element.querySelector<HTMLElement>("[data-pdf-page]")),
      );
      const pageBlocks = blocks
        .slice(Math.max(0, markerIndex + 1))
        .filter((element) => element.tagName !== "HR");
      pageFurniture.headers.forEach((item, index) => {
        const element =
          item.block_index !== undefined && item.block_index !== null
            ? pageBlocks[item.block_index]
            : pageBlocks[index];
        if (element) applyFurniture(element, "header", item);
      });
      const footerStart = Math.max(
        pageFurniture.headers.length,
        pageBlocks.length - pageFurniture.footers.length,
      );
      pageFurniture.footers.forEach((item, index) => {
        const element =
          item.block_index !== undefined && item.block_index !== null
            ? pageBlocks[item.block_index]
            : pageBlocks[footerStart + index];
        if (element) applyFurniture(element, "footer", item);
      });
    });

    return () => {
      styled.forEach((element) => {
        element.classList.remove(
          "pdf-running-furniture",
          "pdf-running-furniture--header",
          "pdf-running-furniture--footer",
          "pdf-running-furniture--left",
          "pdf-running-furniture--center",
          "pdf-running-furniture--right",
          "pdf-running-furniture--row-start",
          "pdf-running-furniture--row-end",
          "pdf-running-furniture--overlay",
        );
        delete element.dataset.pdfFurniture;
        element.removeAttribute("aria-label");
      });
    };
  }, [
    currentPdfPage,
    messages,
    node.id,
    pdfFurniture,
    pdfSource?.documentId,
    printAllPdfPages,
  ]);

  useEffect(() => {
    if (!pdfTocOpen && !pdfSearchOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        pdfNavigationRef.current?.contains(event.target)
      ) {
        return;
      }
      setPdfTocOpen(false);
      setPdfSearchOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPdfTocOpen(false);
      setPdfSearchOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pdfSearchOpen, pdfTocOpen]);

  useEffect(() => {
    if (!pdfSource) return;
    const openFullPdfSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "f") {
        return;
      }
      const view = messagesRef.current?.closest<HTMLElement>(".thread-view");
      const bounds = view?.getBoundingClientRect();
      if (!view || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const focusedView =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>(".thread-view")
          : null;
      if (focusedView && focusedView !== view) return;
      event.preventDefault();
      setPdfTocOpen(false);
      setPdfSearchOpen(true);
      window.requestAnimationFrame(() => {
        pdfSearchInputRef.current?.focus();
        pdfSearchInputRef.current?.select();
      });
    };
    document.addEventListener("keydown", openFullPdfSearch);
    return () => document.removeEventListener("keydown", openFullPdfSearch);
  }, [pdfSource?.documentId]);

  useEffect(() => {
    setPdfSearchActiveIndex(-1);
  }, [deferredPdfSearchQuery]);

  useLayoutEffect(() => {
    if (!pdfTocOpen || !pdfToc.length) return;
    const frame = window.requestAnimationFrame(() => {
      const list = pdfNavigationRef.current?.querySelector<HTMLElement>(
        ".pdf-document-toc__items",
      );
      const active = list?.querySelector<HTMLElement>("[data-toc-active='true']");
      if (!list || !active) return;
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      list.scrollTop +=
        activeRect.top -
        listRect.top -
        (listRect.height - activeRect.height) / 2;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pdfTocCenterRequest, pdfToc.length, pdfTocOpen]);

  useEffect(() => {
    if (!regenerationSettings) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const control =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".regenerate-response-control")
          : null;
      if (control?.dataset.messageId === regenerationSettings.messageId) return;
      setRegenerationSettings(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRegenerationSettings(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [regenerationSettings?.messageId]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    if (messages.length < 2) {
      setCurrentMessageIndex(0);
      setMessageNavigationVisible(false);
      return;
    }
    let frame: number | null = null;
    const syncCurrentMessage = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const articles = renderedMessageArticles(container);
        const marker = container.getBoundingClientRect().top + 24;
        let index = 0;
        articles.forEach((article, candidate) => {
          if (article.getBoundingClientRect().top <= marker) index = candidate;
        });
        if (
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 4
        ) {
          index = articles.length - 1;
        }
        setMessageNavigationVisible(
          container.scrollHeight - container.clientHeight > 120,
        );
        setCurrentMessageIndex(
          Math.min(messages.length - 1, Math.max(0, index)),
        );
      });
    };
    const resizeObserver = new ResizeObserver(syncCurrentMessage);
    resizeObserver.observe(container);
    renderedMessageArticles(container).forEach((article) => resizeObserver.observe(article));
    syncCurrentMessage();
    container.addEventListener("scroll", syncCurrentMessage, { passive: true });
    window.addEventListener("resize", syncCurrentMessage);
    return () => {
      container.removeEventListener("scroll", syncCurrentMessage);
      window.removeEventListener("resize", syncCurrentMessage);
      resizeObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [node.id, messages.length]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container || !pdfSource) return;
    let frame: number | null = null;
    const syncCurrentPage = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (pdfJumpPageRef.current !== null) return;
        const bounds = container.getBoundingClientRect();
        // On mobile the main pane remains mounted but is display:none while a
        // focused thread occupies the screen. Do not interpret that temporary
        // zero-sized viewport as page 1 and unmount the real reading window.
        if (
          container.clientWidth <= 0 ||
          container.clientHeight <= 0 ||
          bounds.width <= 0 ||
          bounds.height <= 0
        ) {
          return;
        }
        const readingLine =
          bounds.top + Math.min(28, Math.max(1, bounds.height - 1));
        const elementAtReadingLine = document.elementFromPoint(
          bounds.left + Math.min(bounds.width - 1, Math.max(1, bounds.width / 2)),
          readingLine,
        );
        const visiblePage =
          elementAtReadingLine instanceof Node && container.contains(elementAtReadingLine)
            ? elementAtReadingLine.closest<HTMLElement>("[data-pdf-page-shell]")
            : null;
        let page = Number(visiblePage?.dataset.pdfPageShell);
        if (!Number.isInteger(page)) {
          page = pdfPageAtReadingLine(container, readingLine) ?? Number.NaN;
        }
        // A transient hit-test/layout failure must retain the current page.
        // Falling back to the first page empties the virtual window around the
        // user's actual scroll position and is what caused the persistent
        // blank view.
        if (!Number.isInteger(page)) return;
        if (
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 4
        ) {
          page = pdfPageEnd;
        }
        if (currentPdfPageRef.current === page) return;
        const anchorShell =
          visiblePage ??
          container.querySelector<HTMLElement>(
            `[data-pdf-page-shell="${page}"]`,
          );
        if (anchorShell) {
          pdfViewportAnchorRef.current = {
            page,
            top: anchorShell.getBoundingClientRect().top,
          };
        }
        currentPdfPageRef.current = page;
        setCurrentPdfPage(page);
      });
    };
    const resizeObserver = new ResizeObserver(syncCurrentPage);
    resizeObserver.observe(container);
    syncCurrentPage();
    container.addEventListener("scroll", syncCurrentPage, { passive: true });
    window.addEventListener("resize", syncCurrentPage);
    return () => {
      container.removeEventListener("scroll", syncCurrentPage);
      window.removeEventListener("resize", syncCurrentPage);
      resizeObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    messages[0]?.content,
    pdfPageEnd,
    pdfPageStart,
    pdfSource?.documentId,
  ]);

  useLayoutEffect(() => {
    const anchor = pdfViewportAnchorRef.current;
    pdfViewportAnchorRef.current = null;
    if (!anchor || pdfJumpPageRef.current !== null) return;
    const container = messagesRef.current;
    const shell = container?.querySelector<HTMLElement>(
      `[data-pdf-page-shell="${anchor.page}"]`,
    );
    if (!container || !shell) return;
    const delta = shell.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    const previousScrollBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollTop += delta;
    container.style.scrollBehavior = previousScrollBehavior;
  }, [currentPdfPage]);

  useEffect(() => {
    setPdfPageInput(String(currentPdfPage));
    if (pdfSource) onPdfPageChange?.(currentPdfPage);
  }, [currentPdfPage, onPdfPageChange, pdfSource?.documentId]);

  useLayoutEffect(() => {
    const page = pendingPdfRestoreRef.current;
    if (!pdfSource || page === null || currentPdfPage !== page) return;
    const container = messagesRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-pdf-page-shell="${page}"]`,
    );
    if (!container || !target) return;
    pendingPdfRestoreRef.current = null;
    const delta =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      18;
    if (Math.abs(delta) < 1) return;
    const previousScrollBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollTop += delta;
    container.style.scrollBehavior = previousScrollBehavior;
  }, [currentPdfPage, pdfSource?.documentId]);

  useEffect(() => {
    if (!scrollRequest || scrollRequest.anchor.sourceNodeId !== node.id) return;
    const unresolvedBlock = scrollRequest.anchor.blockIndex < 0;
    const sourceOffset = scrollRequest.anchor.start;
    const offsetPage =
      unresolvedBlock && Number.isSafeInteger(sourceOffset)
        ? pdfSearchPages.find(
            (page, index) =>
              sourceOffset! >= page.sourceStart &&
              sourceOffset! <
                (pdfSearchPages[index + 1]?.sourceStart ?? Number.POSITIVE_INFINITY),
          )?.page
        : undefined;
    let attempts = 0;
    let offsetPageJumped = false;
    const scrollToAnchor = () => {
      const container = messagesRef.current;
      if (!container) return;
      const article = renderedMessageArticles(container).find(
        (candidate) => candidate.dataset.messageId === scrollRequest.anchor.sourceMessageId,
      );
      const offsetPageShell =
        article && Number.isInteger(offsetPage)
          ? article.querySelector<HTMLElement>(
              `[data-pdf-page-shell="${offsetPage}"]`,
            )
          : null;
      if (
        offsetPageShell &&
        offsetPageShell.dataset.pdfPageActive !== "true" &&
        !offsetPageJumped
      ) {
        offsetPageJumped = true;
        jumpToPdfPage(offsetPage!);
      }
      const searchRoot = offsetPageShell?.dataset.pdfPageActive === "true"
        ? offsetPageShell
        : unresolvedBlock && offsetPageShell
          ? null
          : article;
      const quote = scrollRequest.anchor.quote.trim().toLocaleLowerCase();
      const block = unresolvedBlock
        ? Array.from(
            searchRoot?.querySelectorAll<HTMLElement>("[data-markdown-block-index]") ?? [],
          ).find((candidate) =>
            quote ? candidate.textContent?.toLocaleLowerCase().includes(quote) : false,
          ) ?? null
        : article?.querySelector<HTMLElement>(
            `[data-markdown-block-index="${scrollRequest.anchor.blockIndex}"]`,
          ) ?? null;
      if (!block && article) {
        const pageShell = Array.from(
          article.querySelectorAll<HTMLElement>("[data-pdf-page-shell]"),
        ).find((candidate) => {
          const start = Number(candidate.dataset.blockStart);
          const end = Number(candidate.dataset.blockEnd);
          return (
            Number.isInteger(start) &&
            Number.isInteger(end) &&
            scrollRequest.anchor.blockIndex >= start &&
            scrollRequest.anchor.blockIndex <= end
          );
        });
        const page = Number(pageShell?.dataset.pdfPageShell);
        if (Number.isInteger(page)) {
          setCurrentPdfPage((current) => (current === page ? current : page));
        }
      }
      const resolvedOffsetPage =
        unresolvedBlock &&
        offsetPageShell?.dataset.pdfPageActive === "true"
          ? offsetPageShell
          : null;
      const target = block ?? resolvedOffsetPage ?? article;
      if (
        target &&
        (block ||
          resolvedOffsetPage ||
          !article?.querySelector("[data-pdf-page-shell]"))
      ) {
        target.scrollIntoView({ behavior: "auto", block: "center" });
        onScrollRequestHandled?.(scrollRequest.id);
        scrollFrame.current = null;
        return;
      }
      attempts += 1;
      if (attempts < 60) scrollFrame.current = window.requestAnimationFrame(scrollToAnchor);
      else scrollFrame.current = null;
    };
    scrollFrame.current = window.requestAnimationFrame(scrollToAnchor);
    return () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [node.id, scrollRequest?.id]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
      if (visualizationScrollFrame.current !== null) {
        window.cancelAnimationFrame(visualizationScrollFrame.current);
      }
      pdfJumpCleanupRef.current?.();
      if (pdfSearchFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(pdfSearchFocusFrameRef.current);
      }
      if (pdfSearchFocusTimerRef.current !== null) {
        window.clearTimeout(pdfSearchFocusTimerRef.current);
      }
    },
    [],
  );

  const focusVisualization = useCallback((visualizationId: string) => {
    if (visualizationScrollFrame.current !== null) {
      window.cancelAnimationFrame(visualizationScrollFrame.current);
    }
    let attempts = 0;
    const focus = () => {
      visualizationScrollFrame.current = null;
      const target = messagesRef.current?.querySelector<HTMLElement>(
        `[data-visualization-id="${CSS.escape(visualizationId)}"]`,
      );
      if (target) {
        target.dispatchEvent(new CustomEvent("locus:expand-visualization"));
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 30) {
        visualizationScrollFrame.current = window.requestAnimationFrame(focus);
      }
    };
    focus();
  }, []);

  const focusInlineElaboration = useCallback((elaborationId: string) => {
    if (visualizationScrollFrame.current !== null) {
      window.cancelAnimationFrame(visualizationScrollFrame.current);
    }
    let attempts = 0;
    const focus = () => {
      visualizationScrollFrame.current = null;
      const target = messagesRef.current?.querySelector<HTMLElement>(
        `[data-inline-elaboration-id="${CSS.escape(elaborationId)}"]`,
      );
      if (target) {
        target.dispatchEvent(new CustomEvent("locus:expand-inline-elaboration"));
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 30) {
        visualizationScrollFrame.current = window.requestAnimationFrame(focus);
      }
    };
    focus();
  }, []);

  const copyResponse = async (messageId: string, markdown: string) => {
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    try {
      await writeMarkdownToClipboard(markdown);
      setCopyState({ messageId, status: "copied" });
    } catch {
      setCopyState({ messageId, status: "failed" });
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopyState(null);
      copyResetTimer.current = null;
    }, 1800);
  };

  const printResponse = (messageId: string) => {
    const article = Array.from(
      messagesRef.current ? renderedMessageArticles(messagesRef.current) : [],
    ).find((candidate) => candidate.dataset.messageId === messageId);
    if (!article) return;
    const isVirtualizedPdfMessage =
      Boolean(pdfSource) &&
      messages.some((message) => message.id === messageId && message.role === "source");

    const openPrintDialog = () => {
      document
        .querySelectorAll<HTMLElement>('[data-print-target="true"]')
        .forEach((candidate) => candidate.removeAttribute("data-print-target"));
      article.dataset.printTarget = "true";
      document.body.dataset.printingMessage = "true";

      let cleanupTimer: number | null = null;
      const cleanup = () => {
        article.removeAttribute("data-print-target");
        delete document.body.dataset.printingMessage;
        window.removeEventListener("afterprint", cleanup);
        if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
        if (isVirtualizedPdfMessage) setPrintAllPdfPages(false);
      };
      window.addEventListener("afterprint", cleanup, { once: true });

      try {
        window.print();
        // `afterprint` is widely supported; this also prevents stale print state
        // in browsers that return from print without dispatching it.
        if (article.dataset.printTarget === "true") {
          cleanupTimer = window.setTimeout(cleanup, 60_000);
        }
      } catch {
        cleanup();
      }
    };

    if (!isVirtualizedPdfMessage) {
      openPrintDialog();
      return;
    }
    setPrintAllPdfPages(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(openPrintDialog));
  };

  const jumpToMessage = (index: number) => {
    const container = messagesRef.current;
    if (!container) return;
    const targetIndex = Math.min(messages.length - 1, Math.max(0, index));
    const article = renderedMessageArticles(container)[targetIndex];
    article?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const jumpToPdfPage = (requestedPage: number) => {
    const page = Math.min(pdfPageEnd, Math.max(pdfPageStart, requestedPage));
    pdfJumpPageRef.current = page;
    setCurrentPdfPage(page);
    setPdfPageInput(String(page));
    const container = messagesRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-pdf-page-shell="${page}"]`,
    );
    if (!container || !target) {
      pdfJumpPageRef.current = null;
      return;
    }

    // Smooth-scrolling through a large imported PDF intersects every lazy
    // image on the way. As those images decode, their newly known heights move
    // the destination marker and the animation lands many pages early. Jump
    // atomically, then keep the marker pinned briefly while nearby images
    // settle. Any deliberate user interaction immediately releases the pin.
    pdfJumpCleanupRef.current?.();
    const previousScrollBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    target.scrollIntoView({ behavior: "auto", block: "start" });
    container.style.scrollBehavior = previousScrollBehavior;

    let frame: number | null = null;
    let timer: number | null = null;
    let disposed = false;
    let expectedScrollTop = container.scrollTop;
    const article = target.closest<HTMLElement>("article") ?? target;
    const align = () => {
      frame = null;
      if (disposed || !target.isConnected) return;
      const delta =
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        18;
      if (Math.abs(delta) > 1) {
        const behavior = container.style.scrollBehavior;
        container.style.scrollBehavior = "auto";
        expectedScrollTop = container.scrollTop + delta;
        container.scrollTop = expectedScrollTop;
        container.style.scrollBehavior = behavior;
      }
    };
    const scheduleAlign = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(align);
    };
    const resizeObserver = new ResizeObserver(scheduleAlign);
    const cancelOnReaderScroll = () => {
      // Ignore the scroll event produced by our own alignment. Any other
      // scroll—including dragging a scrollbar or momentum continuing after a
      // gesture—belongs to the reader and must release the destination pin.
      if (Math.abs(container.scrollTop - expectedScrollTop) <= 1) return;
      cleanup();
    };
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      pdfJumpPageRef.current = null;
      resizeObserver.disconnect();
      article.removeEventListener("load", scheduleAlign, true);
      container.removeEventListener("wheel", cleanup);
      container.removeEventListener("touchstart", cleanup);
      container.removeEventListener("pointerdown", cleanup);
      container.removeEventListener("keydown", cleanup);
      container.removeEventListener("scroll", cancelOnReaderScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
      if (pdfJumpCleanupRef.current === cleanup) {
        pdfJumpCleanupRef.current = null;
      }
    };
    resizeObserver.observe(article);
    article.addEventListener("load", scheduleAlign, true);
    container.addEventListener("wheel", cleanup, { passive: true, once: true });
    container.addEventListener("touchstart", cleanup, { passive: true, once: true });
    container.addEventListener("pointerdown", cleanup, { passive: true, once: true });
    container.addEventListener("keydown", cleanup, { once: true });
    container.addEventListener("scroll", cancelOnReaderScroll, { passive: true });
    timer = window.setTimeout(cleanup, 2_500);
    pdfJumpCleanupRef.current = cleanup;
    scheduleAlign();

  };

  const activatePdfSearchMatch = (requestedIndex: number) => {
    if (!pdfSearchResult.matches.length) return;
    const index =
      (requestedIndex % pdfSearchResult.matches.length + pdfSearchResult.matches.length) %
      pdfSearchResult.matches.length;
    const match = pdfSearchResult.matches[index];
    setPdfSearchActiveIndex(index);
    jumpToPdfPage(match.page);
    if (pdfSearchFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(pdfSearchFocusFrameRef.current);
    }
    if (pdfSearchFocusTimerRef.current !== null) {
      window.clearTimeout(pdfSearchFocusTimerRef.current);
      pdfSearchFocusTimerRef.current = null;
    }
    let attempts = 0;
    const query = deferredPdfSearchQuery.trim().toLocaleLowerCase();
    const focusMatch = () => {
      pdfSearchFocusFrameRef.current = null;
      const shell = messagesRef.current?.querySelector<HTMLElement>(
        `[data-pdf-page-shell="${match.page}"][data-pdf-page-active="true"]`,
      );
      if (!shell) {
        attempts += 1;
        if (attempts < 90) {
          pdfSearchFocusFrameRef.current = window.requestAnimationFrame(focusMatch);
        }
        return;
      }
      const blocks = Array.from(
        shell.querySelectorAll<HTMLElement>("[data-markdown-block-index]"),
      );
      let remaining = match.pageOccurrence;
      let target: HTMLElement | null = null;
      for (const block of blocks) {
        const text = (block.textContent ?? "").toLocaleLowerCase();
        let blockMatches = 0;
        let cursor = query ? text.indexOf(query) : -1;
        while (cursor >= 0) {
          blockMatches += 1;
          cursor = text.indexOf(query, cursor + Math.max(1, query.length));
        }
        if (blockMatches > remaining) {
          target = block;
          break;
        }
        remaining -= blockMatches;
      }
      target ??= shell;
      pdfJumpCleanupRef.current?.();
      target.scrollIntoView({ behavior: "auto", block: target === shell ? "start" : "center" });
      if (target !== shell) {
        target.classList.add("pdf-search-target");
        pdfSearchFocusTimerRef.current = window.setTimeout(() => {
          target?.classList.remove("pdf-search-target");
          pdfSearchFocusTimerRef.current = null;
        }, 2_200);
      }
    };
    pdfSearchFocusFrameRef.current = window.requestAnimationFrame(focusMatch);
  };

  const activePdfTocIndex = pdfToc.reduce((bestIndex, item, index) => {
    if (item.page > currentPdfPage) return bestIndex;
    if (bestIndex < 0) return index;
    const bestPage = pdfToc[bestIndex]?.page ?? Number.NEGATIVE_INFINITY;
    return item.page >= bestPage ? index : bestIndex;
  }, -1);
  const normalizedActivePdfTocIndex =
    activePdfTocIndex >= 0 ? activePdfTocIndex : pdfToc.length ? 0 : -1;
  const indexedPdfToc = pdfToc.map((item, index) => ({ item, index }));
  const filteredPdfToc = pdfTocQuery.trim()
    ? indexedPdfToc.filter(({ item }) =>
        item.title.toLocaleLowerCase().includes(pdfTocQuery.trim().toLocaleLowerCase()),
      )
    : indexedPdfToc;

  return (
    <div className={`thread-view ${side ? "thread-view--side" : ""}`}>
      {pdfSource && (
        <div className="pdf-document-nav" ref={pdfNavigationRef}>
          <div className="pdf-document-nav__summary">
            <button
              className="pdf-document-nav__contents"
              type="button"
              aria-label="PDF table of contents"
              aria-expanded={pdfTocOpen}
              aria-controls={`pdf-toc-${pdfSource.documentId}`}
              onClick={() => {
                if (!pdfTocOpen) {
                  setPdfTocCenterRequest((request) => request + 1);
                }
                setPdfSearchOpen(false);
                setPdfTocOpen(!pdfTocOpen);
              }}
            >
              <ListTree size={14} />
              <span>Contents</span>
            </button>
            <button
              className="pdf-document-nav__contents"
              type="button"
              aria-label="Search PDF"
              aria-expanded={pdfSearchOpen}
              aria-controls={`pdf-search-${pdfSource.documentId}`}
              onClick={() => {
                setPdfTocOpen(false);
                setPdfSearchOpen((open) => !open);
                if (!pdfSearchOpen) {
                  window.requestAnimationFrame(() => pdfSearchInputRef.current?.focus());
                }
              }}
            >
              <Search size={14} />
              <span>Search</span>
            </button>
            <span
              className="pdf-document-nav__token-count"
              title="Markdown token count (o200k tokenizer)"
            >
              {pdfTokenCountError
                ? "Token count unavailable"
                : pdfTokenCount === null
                  ? "Counting tokens…"
                  : `${pdfTokenCount.toLocaleString()} tokens`}
            </span>
          </div>
          <form
            className="pdf-document-nav__pages"
            onSubmit={(event) => {
              event.preventDefault();
              jumpToPdfPage(Number(pdfPageInput));
            }}
          >
            <button
              type="button"
              aria-label="Previous PDF page"
              disabled={currentPdfPage <= pdfPageStart}
              onClick={() => jumpToPdfPage(currentPdfPage - 1)}
            >
              <ChevronLeft size={14} />
            </button>
            <label>
              <span>Page</span>
              <input
                type="number"
                min={pdfPageStart}
                max={pdfPageEnd}
                value={pdfPageInput}
                aria-label="PDF page number"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setPdfPageInput(event.target.value)}
              />
              <span>of {pdfPageEnd}</span>
            </label>
            <button type="submit" aria-label="Go to PDF page">
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              aria-label="Next PDF page"
              disabled={currentPdfPage >= pdfPageEnd}
              onClick={() => jumpToPdfPage(currentPdfPage + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </form>
          {pdfTocOpen && (
            <section
              className="pdf-document-toc"
              id={`pdf-toc-${pdfSource.documentId}`}
              aria-label="PDF table of contents"
            >
              <header>
                <strong>Table of contents</strong>
                <span>{pdfToc.length} entries</span>
              </header>
              {!!pdfToc.length && (
                <input
                  type="search"
                  value={pdfTocQuery}
                  placeholder="Filter contents…"
                  aria-label="Filter PDF table of contents"
                  onChange={(event) => setPdfTocQuery(event.target.value)}
                />
              )}
              <div className="pdf-document-toc__items">
                {pdfTocLoading ? (
                  <p>Importing contents…</p>
                ) : pdfTocError ? (
                  <p className="pdf-document-toc__error">{pdfTocError}</p>
                ) : !pdfToc.length ? (
                  <p>This PDF has no embedded table of contents.</p>
                ) : !filteredPdfToc.length ? (
                  <p>No matching sections.</p>
                ) : (
                  filteredPdfToc.map(({ item, index }) => (
                    <button
                      type="button"
                      key={`${item.page}-${item.level}-${index}`}
                      className={
                        index === normalizedActivePdfTocIndex ? "is-current" : ""
                      }
                      data-toc-active={
                        index === normalizedActivePdfTocIndex ? "true" : undefined
                      }
                      style={{ paddingLeft: `${12 + Math.min(5, item.level - 1) * 14}px` }}
                      onClick={() => {
                        jumpToPdfPage(item.page);
                        setPdfTocOpen(false);
                      }}
                    >
                      <span>{item.title}</span>
                      <small>{item.page}</small>
                    </button>
                  ))
                )}
              </div>
            </section>
          )}
          {pdfSearchOpen && (
            <section
              className="pdf-document-search"
              id={`pdf-search-${pdfSource.documentId}`}
              aria-label="Search the entire PDF"
            >
              <header>
                <strong>Search all {pdfSearchPages.length.toLocaleString()} pages</strong>
                <span>
                  {pdfSearchQuery.trim()
                    ? deferredPdfSearchQuery !== pdfSearchQuery
                      ? "Searching…"
                      : `${pdfSearchResult.total.toLocaleString()} match${pdfSearchResult.total === 1 ? "" : "es"}`
                    : "Cmd/Ctrl + F"}
                </span>
              </header>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  activatePdfSearchMatch(
                    pdfSearchActiveIndex < 0 ? 0 : pdfSearchActiveIndex + 1,
                  );
                }}
              >
                <Search size={13} aria-hidden="true" />
                <input
                  ref={pdfSearchInputRef}
                  type="search"
                  value={pdfSearchQuery}
                  placeholder="Search text, equations, or code…"
                  aria-label="Search the entire imported PDF"
                  onChange={(event) => setPdfSearchQuery(event.target.value)}
                />
                <button
                  type="button"
                  aria-label="Previous PDF search result"
                  disabled={!pdfSearchResult.matches.length}
                  onClick={() =>
                    activatePdfSearchMatch(
                      pdfSearchActiveIndex < 0
                        ? pdfSearchResult.matches.length - 1
                        : pdfSearchActiveIndex - 1,
                    )
                  }
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="submit"
                  aria-label="Next PDF search result"
                  disabled={!pdfSearchResult.matches.length}
                >
                  <ChevronDown size={13} />
                </button>
              </form>
              <div className="pdf-document-search__items">
                {!pdfSearchQuery.trim() ? (
                  <p>Search uses the full imported Markdown, including pages outside the rendered window.</p>
                ) : deferredPdfSearchQuery !== pdfSearchQuery ? (
                  <p>Searching the document…</p>
                ) : !pdfSearchResult.matches.length ? (
                  <p>No matches in this PDF.</p>
                ) : (
                  pdfSearchResult.matches.map((match, index) => (
                    <button
                      type="button"
                      className={index === pdfSearchActiveIndex ? "is-current" : ""}
                      key={`${match.page}-${match.index}`}
                      onClick={() => activatePdfSearchMatch(index)}
                    >
                      <small>Page {match.page}</small>
                      <span>
                        {highlightPdfSearchMatches(match.snippet, deferredPdfSearchQuery)}
                      </span>
                    </button>
                  ))
                )}
              </div>
              {pdfSearchResult.truncated && (
                <footer>
                  Showing the first {pdfSearchResult.matches.length.toLocaleString()} of{" "}
                  {pdfSearchResult.total.toLocaleString()} matches. Refine the search to narrow it.
                </footer>
              )}
            </section>
          )}
        </div>
      )}
      {messages.length > 1 && messageNavigationVisible && (
        <nav className="message-jump-nav" aria-label="Message navigation">
          <button
            type="button"
            aria-label="Previous message"
            disabled={currentMessageIndex === 0}
            onClick={() => jumpToMessage(currentMessageIndex - 1)}
          >
            <ChevronUp size={14} />
          </button>
          <span aria-label={`Message ${currentMessageIndex + 1} of ${messages.length}`}>
            {currentMessageIndex + 1}<i>/</i>{messages.length}
          </span>
          <button
            type="button"
            aria-label="Next message"
            disabled={currentMessageIndex === messages.length - 1}
            onClick={() => jumpToMessage(currentMessageIndex + 1)}
          >
            <ChevronDown size={14} />
          </button>
        </nav>
      )}
      <div className="thread-messages" ref={messagesRef}>
        {messages.map((message) => {
          const revisionGroupId =
            message.revisionGroupId ?? (message.role === "user" ? message.id : null);
          const revisionGroup = revisionGroupId
            ? node.messageRevisions?.[revisionGroupId]
            : undefined;
          const activeRevisionIndex = revisionGroup
            ? Math.max(
                0,
                revisionGroup.variants.findIndex(
                  (variant) => variant.id === revisionGroup.activeVariantId,
                ),
              )
            : 0;
          const responseRevisionGroupId = message.responseRevisionGroupId;
          const responseRevisionGroup = responseRevisionGroupId
            ? node.responseRevisions?.[responseRevisionGroupId]
            : undefined;
          const activeResponseIndex = responseRevisionGroup
            ? Math.max(
                0,
                responseRevisionGroup.responses.findIndex(
                  (response) => response.id === responseRevisionGroup.activeResponseId,
                ),
              )
            : 0;
          const assistantEditGroup =
            message.role === "assistant" ? node.assistantEdits?.[message.id] : undefined;
          const activeAssistantEditIndex = assistantEditGroup
            ? Math.max(
                0,
                assistantEditGroup.variants.findIndex(
                  (variant) => variant.id === assistantEditGroup.activeVariantId,
                ),
              )
            : 0;
          const messageCopyStatus =
            copyState?.messageId === message.id ? copyState.status : null;
          const linkedAnchors =
            linkedAnchorsByMessage.get(message.id) ?? EMPTY_LINKED_ANCHORS;
          const definitions = definitionsByMessage.get(message.id) ?? EMPTY_DEFINITIONS;
          const visualizations =
            visualizationsByMessage.get(message.id) ?? EMPTY_VISUALIZATIONS;
          const inlineElaborations =
            inlineElaborationsByMessage.get(message.id) ?? EMPTY_INLINE_ELABORATIONS;
          const virtualizePdfSource =
            Boolean(pdfSource) &&
            message.role === "source" &&
            node.id === chat.rootId;
          return (
            <article
              className={`message message--${message.role} ${message.error ? "message--error" : ""}`}
              data-message-id={message.id}
              key={message.id}
            >
              <div className="message__meta">
                <span className="message__author">
                  {message.role === "assistant" ? (
                    <Sparkles size={13} />
                  ) : message.role === "source" ? (
                    <BookOpen size={13} />
                  ) : (
                    <MessageSquareText size={13} />
                  )}
                  <span>
                    {message.role === "assistant"
                      ? "Locus"
                      : message.role === "source"
                        ? "Imported source"
                        : "You"}
                  </span>
                </span>
                {!readOnly && message.role === "user" && revisionGroupId && (
                  <span className="message__controls">
                    {revisionGroup && (
                      <RevisionSwitcher
                        label="message"
                        activeIndex={activeRevisionIndex}
                        variantIds={revisionGroup.variants.map((variant) => variant.id)}
                        disabled={waiting}
                        onSwitch={(variantId) =>
                          onSwitchMessageRevision(revisionGroupId, variantId)
                        }
                      />
                    )}
                    <button
                      className="edit-message-button"
                      type="button"
                      aria-label="Edit message"
                      disabled={waiting}
                      onClick={() => {
                        setEditingMessageId(revisionGroupId);
                        setEditValue(message.content);
                      }}
                    >
                      <Pencil size={11} />
                    </button>
                  </span>
                )}
                {message.role === "source" && (
                  <span className="message__controls">
                    {!readOnly &&
                      node.id === chat.rootId &&
                      chat.source?.kind === "pdf" &&
                      chat.source.status === "ready" && (
                        <a
                          className="source-pdf-button message-action-button"
                          href={`/api/pdf-documents/${encodeURIComponent(chat.source.documentId)}/source`}
                          target="_blank"
                          rel="noreferrer"
                          title={chat.source.filename}
                        >
                          <span>View original PDF</span>
                          <ExternalLink size={11} />
                        </a>
                      )}
                    {node.id === chat.rootId &&
                      chat.source?.kind === "pdf" &&
                      chat.source.status === "importing" && (
                        <span className="source-pdf-status">
                          <span /> Converting PDF…
                        </span>
                      )}
                    {!readOnly && (
                      <button
                        className="edit-message-button message-action-button"
                        type="button"
                        aria-label="Edit imported Markdown source"
                        disabled={
                          waiting ||
                          (
                            node.id === chat.rootId &&
                            chat.source?.kind === "pdf" &&
                            chat.source.status === "importing"
                          )
                        }
                        onClick={() => onEditSource(message.id)}
                      >
                        <span>Edit source</span>
                        <Pencil size={11} />
                      </button>
                    )}
                    {message.content && (
                      <button
                        className={`copy-response-button message-action-button ${messageCopyStatus ? `copy-response-button--${messageCopyStatus}` : ""}`}
                        type="button"
                        aria-label={
                          messageCopyStatus
                            ? messageCopyStatus === "copied"
                              ? "Imported Markdown copied"
                              : "Copy failed"
                            : "Copy imported Markdown"
                        }
                        onClick={() => void copyResponse(message.id, message.content)}
                      >
                        <span>
                          {messageCopyStatus
                            ? messageCopyStatus === "copied"
                              ? "Copied"
                              : "Failed"
                            : "Copy"}
                        </span>
                        {messageCopyStatus === "copied" ? (
                          <Check size={11} />
                        ) : (
                          <Copy size={11} />
                        )}
                      </button>
                    )}
                    {message.content && (
                      <button
                        className="print-response-button message-action-button"
                        type="button"
                        aria-label="Print imported source"
                        onClick={() => printResponse(message.id)}
                      >
                        <span>Print</span>
                        <Printer size={11} />
                      </button>
                    )}
                  </span>
                )}
                {message.role === "assistant" && !message.pending && (
                  <span className="message__controls">
                    {!readOnly && responseRevisionGroup && responseRevisionGroupId && (
                      <RevisionSwitcher
                        label="response"
                        activeIndex={activeResponseIndex}
                        variantIds={responseRevisionGroup.responses.map(
                          (response) => response.id,
                        )}
                        disabled={waiting}
                        onSwitch={(responseId) =>
                          onSwitchResponseRevision(responseRevisionGroupId, responseId)
                        }
                      />
                    )}
                    {!readOnly && assistantEditGroup && (
                      <RevisionSwitcher
                        label="edit"
                        activeIndex={activeAssistantEditIndex}
                        variantIds={assistantEditGroup.variants.map((variant) => variant.id)}
                        disabled={waiting}
                        onSwitch={(variantId) =>
                          onSwitchAssistantEdit(message.id, variantId)
                        }
                      />
                    )}
                    {!readOnly && message.content && (
                      <button
                        className="edit-message-button message-action-button"
                        type="button"
                        aria-label="Edit response Markdown"
                        title="Edit response Markdown"
                        disabled={waiting}
                        onClick={() => onEditAssistant(message.id)}
                      >
                        <span>Edit</span>
                        <Pencil size={11} />
                      </button>
                    )}
                    {!message.error && message.content && (
                      <button
                        className={`copy-response-button message-action-button ${messageCopyStatus ? `copy-response-button--${messageCopyStatus}` : ""}`}
                        type="button"
                        aria-label={
                          messageCopyStatus
                            ? messageCopyStatus === "copied"
                              ? "Response copied as Markdown"
                              : "Copy failed"
                            : "Copy response as Markdown"
                        }
                        onClick={() => void copyResponse(message.id, message.content)}
                      >
                        <span>
                          {messageCopyStatus
                            ? messageCopyStatus === "copied"
                              ? "Copied"
                              : "Failed"
                            : "Copy"}
                        </span>
                        {messageCopyStatus === "copied" ? (
                          <Check size={11} />
                        ) : (
                          <Copy size={11} />
                        )}
                      </button>
                    )}
                    {message.content && (
                      <button
                        className="print-response-button message-action-button"
                        type="button"
                        aria-label="Print response"
                        onClick={() => printResponse(message.id)}
                      >
                        <span>Print</span>
                        <Printer size={11} />
                      </button>
                    )}
                    {!readOnly && <span
                      className="regenerate-response-control"
                      data-message-id={message.id}
                    >
                      <button
                        className="regenerate-response-button message-action-button"
                        type="button"
                        aria-label="Regenerate response"
                        title={`Regenerate with ${model}`}
                        disabled={waiting}
                        onClick={() => onRegenerateResponse(message.id)}
                      >
                        <span>Regenerate</span>
                        <RotateCcw size={11} />
                      </button>
                      <button
                        className="regenerate-model-button"
                        type="button"
                        aria-label="Configure regeneration"
                        aria-expanded={regenerationSettings?.messageId === message.id}
                        aria-controls={`regeneration-settings-${message.id}`}
                        title="Choose a model for this regeneration"
                        disabled={waiting}
                        onClick={() =>
                          setRegenerationSettings((current) =>
                            current?.messageId === message.id
                              ? null
                              : {
                                  messageId: message.id,
                                  model,
                                  reasoningEffort,
                                },
                          )
                        }
                      >
                        <ChevronDown size={11} aria-hidden="true" />
                      </button>
                      {regenerationSettings?.messageId === message.id && (
                        <div
                          className="regeneration-settings-popover"
                          id={`regeneration-settings-${message.id}`}
                          role="dialog"
                          aria-label="Regeneration settings"
                        >
                          <strong>Regenerate response</strong>
                          <label>
                            <span>Model</span>
                            <select
                              aria-label="Model for regeneration"
                              value={regenerationSettings.model}
                              onChange={(event) => {
                                const selectedModel = event.target.value;
                                setRegenerationSettings((current) =>
                                  current
                                    ? {
                                        ...current,
                                        model: selectedModel,
                                        reasoningEffort: compatibleReasoningEffort(
                                          provider,
                                          selectedModel,
                                          current.reasoningEffort,
                                        ),
                                      }
                                    : current,
                                );
                              }}
                            >
                              {regenerationModelOptions.map((option) => (
                                <option value={option.id} key={option.id}>
                                  {option.label}{option.id === model ? " · current" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Reasoning effort</span>
                            <select
                              aria-label="Reasoning effort for regeneration"
                              value={regenerationSettings.reasoningEffort}
                              onChange={(event) =>
                                setRegenerationSettings((current) =>
                                  current
                                    ? {
                                        ...current,
                                        reasoningEffort: event.target.value as ReasoningEffort,
                                      }
                                    : current,
                                )
                              }
                            >
                              {REASONING_OPTIONS.map((effort) => (
                                <option
                                  value={effort.value}
                                  key={effort.value}
                                  disabled={
                                    effort.value === "max" &&
                                    provider === "openai" &&
                                    !regenerationSettings.model.startsWith("gpt-5.6")
                                  }
                                >
                                  {effort.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              onRegenerateResponse(
                                message.id,
                                regenerationSettings.model,
                                regenerationSettings.reasoningEffort,
                              );
                              setRegenerationSettings(null);
                            }}
                          >
                            <RotateCcw size={12} /> Regenerate
                          </button>
                        </div>
                      )}
                    </span>}
                  </span>
                )}
              </div>
              {message.role === "user" &&
              revisionGroupId &&
              editingMessageId === revisionGroupId ? (
                <div className="message-editor">
                  <textarea
                    autoFocus
                    value={editValue}
                    aria-label="Edit previous message"
                    onChange={(event) => setEditValue(event.target.value)}
                    onKeyDown={(event) => {
                      applyMarkdownShortcut(event, editValue, setEditValue);
                    }}
                  />
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMessageId(null);
                        setEditValue("");
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="message-editor__save"
                      type="button"
                      disabled={!editValue.trim() || editValue.trim() === message.content.trim()}
                      onClick={() => {
                        onEditMessage(revisionGroupId, editValue.trim());
                        setEditingMessageId(null);
                        setEditValue("");
                      }}
                    >
                      Save & regenerate
                    </button>
                  </div>
                </div>
              ) : message.pending && !message.content ? (
                <ThinkingIndicator startedAt={message.createdAt} />
              ) : message.role === "source" &&
                node.id === chat.rootId &&
                chat.source?.kind === "pdf" &&
                chat.source.status === "importing" ? (
                <div className="pdf-import-progress" role="status" aria-live="polite">
                  <LoaderCircle size={22} aria-hidden="true" />
                  <div>
                    <strong>Converting {chat.source.filename}</strong>
                    <p>
                      Extracting pages, recovering figures, then checking Markdown and LaTeX
                      formatting. This job continues on the server if you leave or refresh.
                    </p>
                  </div>
                  <span className="pdf-import-progress__track" aria-hidden="true"><i /></span>
                </div>
              ) : (
                <>
                <MarkdownMessage
                  message={message}
                  nodeId={node.id}
                  preserveSoftBreaks={
                    message.role === "source" &&
                    node.id === chat.rootId &&
                    chat.source?.kind === "pdf"
                  }
                  pdfVirtualization={
                    virtualizePdfSource
                      ? {
                          currentPage: currentPdfPage,
                          pageStart: pdfPageStart,
                          buffer: 10,
                          renderAll: printAllPdfPages,
                        }
                      : undefined
                  }
                  linkedAnchors={linkedAnchors}
                  definitions={definitions}
                  visualizations={visualizations}
                  inlineElaborations={inlineElaborations}
                  onSelect={dispatchSelection}
                  onOpenElaboration={onOpenElaboration}
                  onOpenDefinition={onOpenDefinition}
                  onOpenVisualization={focusVisualization}
                  onOpenInlineElaboration={focusInlineElaboration}
                  onAnnotationContextMenu={
                    onAnnotationContextMenu
                      ? (target, point) => onAnnotationContextMenu(node.id, target, point)
                      : undefined
                  }
                />
                  {message.role === "source" &&
                    node.sourceEditUndo?.sourceMessageId === message.id && (
                      <div className="source-edit-undo" role="status">
                        <span>Source rewrite applied</span>
                        <button type="button" onClick={() => onRevertSourceEdit(message.id)}>
                          <RotateCcw size={12} /> Revert
                        </button>
                      </div>
                    )}
                  {visualizations.map((visualization) => (
                    <AnchoredInlineMount
                      key={visualization.id}
                      messagesRef={messagesRef}
                      messageId={message.id}
                      messageContent={message.content}
                      annotationId={visualization.id}
                      blockIndex={visualization.anchor.blockIndex}
                    >
                      <VisualizationCard
                        visualization={visualization}
                        sendShortcut={sendShortcut}
                        onGenerate={onGenerateVisualization}
                        onFix={onFixVisualization}
                        onCompile={onCompileVisualization}
                        onStop={onStopVisualization}
                        onDelete={onDeleteVisualization}
                        readOnly={readOnly}
                      />
                    </AnchoredInlineMount>
                  ))}
                  {inlineElaborations.map((elaboration) => {
                    const renderedElaboration = {
                      ...elaboration,
                      content: activeEditContent(node, elaboration.id, elaboration.content),
                    };
                    const inlineEditGroup = node.assistantEdits?.[elaboration.id];
                    const furtherNode = elaboration.furtherElaborationNodeId
                      ? chat.nodes[elaboration.furtherElaborationNodeId]
                      : undefined;
                    const furtherElaborationState = furtherNode
                      ? messagesForNode(furtherNode).some(
                          (candidate) => candidate.role === "assistant" && candidate.pending,
                        )
                        ? "pending" as const
                        : "ready" as const
                      : undefined;
                    return (
                      <AnchoredInlineMount
                        key={elaboration.id}
                        messagesRef={messagesRef}
                        messageId={message.id}
                        messageContent={message.content}
                        annotationId={elaboration.id}
                        blockIndex={elaboration.anchor.blockIndex}
                      >
                        <InlineElaborationCard
                          elaboration={renderedElaboration}
                          nodeId={node.id}
                          definitions={
                            definitionsByMessage.get(elaboration.id) ?? EMPTY_DEFINITIONS
                          }
                          onSelect={dispatchSelection}
                          onOpenDefinition={onOpenDefinition}
                          onGenerate={onGenerateInlineElaboration}
                          onStop={onStopInlineElaboration}
                          onDelete={onDeleteInlineElaboration}
                          onElaborateFurther={onElaborateFurther}
                          editGroup={inlineEditGroup}
                          onSwitchEdit={onSwitchAssistantEdit}
                          onAnnotationContextMenu={
                            onAnnotationContextMenu
                              ? (target, point) =>
                                  onAnnotationContextMenu(node.id, target, point)
                              : undefined
                          }
                          onOpenFurtherElaboration={() => {
                            if (furtherNode) onOpenElaboration(furtherNode.id);
                          }}
                          furtherElaborationState={furtherElaborationState}
                          readOnly={readOnly}
                        />
                      </AnchoredInlineMount>
                    );
                  })}
                  {message.pending && (
                    <div className="streaming-status" aria-label="Locus is responding">
                      <span /> Streaming
                    </div>
                  )}
                  {message.stopped && (
                    <div className="stopped-status"><Square size={9} /> Response stopped</div>
                  )}
                  {message.role === "assistant" && !message.pending && message.generation && (
                    <footer className="generation-details" aria-label="Generation details">
                      <Clock3 size={10} />
                      <span>{generationDetails(message.generation)}</span>
                    </footer>
                  )}
                </>
              )}
            </article>
          );
        })}
        <div ref={endRef} />
      </div>
      {!readOnly && (
        <div
          className={`thread-composer-wrap${pdfComposerCollapsed ? " thread-composer-wrap--collapsed" : ""}`}
        >
          {pdfComposerCollapsed ? (
            <button
              className="pdf-composer-toggle pdf-composer-toggle--open"
              type="button"
              aria-expanded="false"
              onClick={() => setCollapsedPdfComposerNodeId(null)}
            >
              <MessageSquareText size={14} />
              <span>{pendingAssistant ? "Response in progress" : "Ask about this topic"}</span>
              <ChevronUp size={14} />
            </button>
          ) : (
            <>
          {pdfSource && !side && (
            <button
              className="pdf-composer-toggle pdf-composer-toggle--close"
              type="button"
              aria-expanded="true"
              aria-label="Minimize Ask about this topic"
              onClick={() => setCollapsedPdfComposerNodeId(node.id)}
            >
              <span>Ask about this topic</span>
              <ChevronDown size={13} />
            </button>
          )}
          {pendingAssistant && (
            <button
              className="stop-response-button"
              type="button"
              onClick={() => onStop(pendingAssistant.id)}
            >
              <Square size={10} fill="currentColor" /> Stop response
            </button>
          )}
          <Composer
            key={node.id}
            compact={side}
            disabled={waiting}
            onSend={onSend}
            provider={provider}
            modelOptions={modelOptions}
            model={model}
            onModelChange={onModelChange}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={onReasoningEffortChange}
            sendShortcut={sendShortcut}
            draftKey={draftNamespace ? `${draftNamespace}:${chat.id}:${node.id}` : undefined}
            insertion={composerInsertion}
            onInsertionApplied={onComposerInsertionApplied}
            placeholder={side ? "Continue this line of thought…" : "Ask about this topic…"}
          />
          {!side && (
            <p className="selection-tip">
              Select any passage or equation to define, visualize, quote, elaborate, or rewrite it.
            </p>
          )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
