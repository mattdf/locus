import {
  ChevronDown,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Copy,
  ExternalLink,
  MessageSquareText,
  Pencil,
  Printer,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import {
  useCallback,
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
  VisualizationContextScope,
  VisualizationEngine,
} from "../types";
import { activeEditContent, childThreads, messagesForNode } from "../lib/tree";
import { formatDuration, generationDetails } from "../lib/generation";
import { applyMarkdownShortcut } from "../lib/textarea";
import { compatibleReasoningEffort } from "../lib/providers";
import { Composer } from "./Composer";
import { MarkdownMessage, type LinkedAnchor } from "./MarkdownMessage";
import { MODEL_OPTIONS, REASONING_OPTIONS } from "./ModelPicker";
import { VisualizationCard } from "./VisualizationCard";
import { InlineElaborationCard } from "./InlineElaborationCard";

const EMPTY_LINKED_ANCHORS: LinkedAnchor[] = [];
const EMPTY_DEFINITIONS: InlineDefinition[] = [];
const EMPTY_VISUALIZATIONS: InlineVisualization[] = [];
const EMPTY_INLINE_ELABORATIONS: InlineElaboration[] = [];

function renderedMessageArticles(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(":scope > article[data-message-id]"),
  );
}

interface ThreadViewProps {
  chat: ChatTree;
  node: ThreadNode;
  side?: boolean;
  readOnly?: boolean;
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
      const markdown = article?.querySelector<HTMLElement>(".markdown-message");
      if (!markdown) return false;
      const blocks = Array.from(markdown.children).filter(
        (element) => !element.classList.contains("inline-annotation-slot"),
      );
      const block = blocks[blockIndex];
      if (!block) return false;
      if (slot.parentElement === markdown) return true;

      const existingSlots = Array.from(
        markdown.querySelectorAll<HTMLElement>(
          `:scope > .inline-annotation-slot[data-block-index="${blockIndex}"]`,
        ),
      ).filter((candidate) => candidate !== slot);
      const lastSlot = existingSlots.at(-1);
      markdown.insertBefore(slot, lastSlot ? lastSlot.nextSibling : block.nextSibling);
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
  const children = useMemo(() => childThreads(chat, node.id), [chat, node.id]);
  const messages = useMemo(() => messagesForNode(node), [node]);
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
    setEditingMessageId(null);
    setEditValue("");
    setCopyState(null);
    setRegenerationSettings(null);
    setCurrentMessageIndex(0);
    setMessageNavigationVisible(false);
  }, [node.id]);

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
    if (!scrollRequest || scrollRequest.anchor.sourceNodeId !== node.id) return;
    let attempts = 0;
    const scrollToAnchor = () => {
      const container = messagesRef.current;
      if (!container) return;
      const article = renderedMessageArticles(container).find(
        (candidate) => candidate.dataset.messageId === scrollRequest.anchor.sourceMessageId,
      );
      const markdown = article?.querySelector<HTMLElement>(".markdown-message");
      const block = Array.from(markdown?.children ?? []).filter(
        (element) => !element.classList.contains("inline-annotation-slot"),
      )[scrollRequest.anchor.blockIndex] as HTMLElement | undefined;
      const target = block ?? article;
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "center" });
        onScrollRequestHandled?.(scrollRequest.id);
        scrollFrame.current = null;
        return;
      }
      attempts += 1;
      if (attempts < 6) scrollFrame.current = window.requestAnimationFrame(scrollToAnchor);
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

  const jumpToMessage = (index: number) => {
    const container = messagesRef.current;
    if (!container) return;
    const targetIndex = Math.min(messages.length - 1, Math.max(0, index));
    const article = renderedMessageArticles(container)[targetIndex];
    article?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className={`thread-view ${side ? "thread-view--side" : ""}`}>
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
                          className="source-pdf-button"
                          href={`/api/pdf-documents/${encodeURIComponent(chat.source.documentId)}/source`}
                          target="_blank"
                          rel="noreferrer"
                          title={chat.source.filename}
                        >
                          <ExternalLink size={11} />
                          <span>View original PDF</span>
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
                        className="edit-message-button"
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
                        <Pencil size={11} />
                        <span>Edit source</span>
                      </button>
                    )}
                    {message.content && (
                      <button
                        className={`copy-response-button ${messageCopyStatus ? `copy-response-button--${messageCopyStatus}` : ""}`}
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
                        {messageCopyStatus === "copied" ? (
                          <Check size={11} />
                        ) : (
                          <Copy size={11} />
                        )}
                        <span>
                          {messageCopyStatus
                            ? messageCopyStatus === "copied"
                              ? "Copied"
                              : "Failed"
                            : "Copy"}
                        </span>
                      </button>
                    )}
                    {message.content && (
                      <button
                        className="print-response-button"
                        type="button"
                        aria-label="Print imported source"
                        onClick={() => printResponse(message.id)}
                      >
                        <Printer size={11} />
                        <span>Print</span>
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
                        className="edit-message-button"
                        type="button"
                        aria-label="Edit response Markdown"
                        title="Edit response Markdown"
                        disabled={waiting}
                        onClick={() => onEditAssistant(message.id)}
                      >
                        <Pencil size={11} />
                        <span>Edit</span>
                      </button>
                    )}
                    {!message.error && message.content && (
                      <button
                        className={`copy-response-button ${messageCopyStatus ? `copy-response-button--${messageCopyStatus}` : ""}`}
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
                        {messageCopyStatus === "copied" ? (
                          <Check size={11} />
                        ) : (
                          <Copy size={11} />
                        )}
                        <span>
                          {messageCopyStatus
                            ? messageCopyStatus === "copied"
                              ? "Copied"
                              : "Failed"
                            : "Copy"}
                        </span>
                      </button>
                    )}
                    {message.content && (
                      <button
                        className="print-response-button"
                        type="button"
                        aria-label="Print response"
                        onClick={() => printResponse(message.id)}
                      >
                        <Printer size={11} />
                        <span>Print</span>
                      </button>
                    )}
                    {!readOnly && <span
                      className="regenerate-response-control"
                      data-message-id={message.id}
                    >
                      <button
                        className="regenerate-response-button"
                        type="button"
                        aria-label="Regenerate response"
                        title={`Regenerate with ${model}`}
                        disabled={waiting}
                        onClick={() => onRegenerateResponse(message.id)}
                      >
                        <RotateCcw size={11} />
                        <span>Regenerate</span>
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
              ) : (
                <>
                <MarkdownMessage
                  message={message}
                  nodeId={node.id}
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
      {!readOnly && <div className="thread-composer-wrap">
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
          insertion={composerInsertion}
          onInsertionApplied={onComposerInsertionApplied}
          placeholder={side ? "Continue this line of thought…" : "Ask about this topic…"}
        />
        {!side && (
          <p className="selection-tip">
            Select any passage or equation to define, visualize, quote, elaborate, or rewrite it.
          </p>
        )}
      </div>}
    </div>
  );
}
