import {
  ChevronDown,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Copy,
  MessageSquareText,
  Pencil,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatTree,
  GenerationMetrics,
  HighlightAnchor,
  SelectionDraft,
  ThreadNode,
  ReasoningEffort,
  SendShortcut,
  ProviderId,
  ProviderModelOption,
} from "../types";
import { childThreads, messagesForNode } from "../lib/tree";
import { applyMarkdownShortcut } from "../lib/textarea";
import { compatibleReasoningEffort, providerLabel } from "../lib/providers";
import { Composer } from "./Composer";
import { MarkdownMessage, type LinkedAnchor } from "./MarkdownMessage";
import { MODEL_OPTIONS, REASONING_OPTIONS } from "./ModelPicker";

const EMPTY_LINKED_ANCHORS: LinkedAnchor[] = [];

interface ThreadViewProps {
  chat: ChatTree;
  node: ThreadNode;
  side?: boolean;
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
  onSend: (message: string) => void;
  onStop: (assistantId: string) => void;
  onEditMessage: (revisionGroupId: string, content: string) => void;
  onRegenerateResponse: (
    assistantId: string,
    modelOverride?: string,
    reasoningEffortOverride?: ReasoningEffort,
  ) => void;
  onSwitchMessageRevision: (revisionGroupId: string, variantId: string) => void;
  onSwitchResponseRevision: (responseGroupId: string, responseId: string) => void;
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

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function generationDetails(generation: GenerationMetrics): string {
  const duration = formatDuration(generation.durationMs);
  const route = [
    generation.provider ? providerLabel(generation.provider) : null,
    generation.model,
  ].filter(Boolean).join(" · ");
  const prefix = route ? `${duration} · ${route}` : duration;
  if (
    generation.totalTokens === null ||
    generation.inputTokens === null ||
    generation.outputTokens === null ||
    generation.reasoningTokens === null
  ) {
    return `${prefix} · token usage unavailable`;
  }
  const format = (value: number) => value.toLocaleString();
  const costKind = generation.provider === "openrouter" ? "reported" : "estimated";
  const cost =
    typeof generation.totalCostUsd === "number"
      ? generation.totalCostUsd < 0.0001
        ? `< $0.0001 ${costKind}`
        : `$${generation.totalCostUsd.toFixed(generation.totalCostUsd < 0.01 ? 5 : 4)} ${costKind}`
      : "cost unavailable";
  return `${prefix} · ${format(generation.totalTokens)} tokens total · ${format(generation.inputTokens)} input · ${format(generation.outputTokens)} generated (including ${format(generation.reasoningTokens)} reasoning) · ${cost}`;
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

function RevisionSwitcher({
  label,
  activeIndex,
  variantIds,
  disabled,
  onSwitch,
}: {
  label: "message" | "response";
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
  onSelect,
  onOpenElaboration,
  onSend,
  onStop,
  onEditMessage,
  onRegenerateResponse,
  onSwitchMessageRevision,
  onSwitchResponseRevision,
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
  const copyResetTimer = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
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
    if (!container || messages.length < 2) return;
    let frame: number | null = null;
    const syncCurrentMessage = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const articles = Array.from(
          container.querySelectorAll<HTMLElement>("[data-message-id]"),
        );
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
        setCurrentMessageIndex(Math.max(0, index));
      });
    };
    const resizeObserver = new ResizeObserver(syncCurrentMessage);
    resizeObserver.observe(container);
    container
      .querySelectorAll<HTMLElement>("[data-message-id]")
      .forEach((article) => resizeObserver.observe(article));
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
      const article = Array.from(
        container.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find((candidate) => candidate.dataset.messageId === scrollRequest.anchor.sourceMessageId);
      const markdown = article?.querySelector<HTMLElement>(".markdown-message");
      const block = markdown?.children.item(scrollRequest.anchor.blockIndex) as HTMLElement | null;
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
    },
    [],
  );

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

  const jumpToMessage = (index: number) => {
    const container = messagesRef.current;
    const article = container?.querySelectorAll<HTMLElement>("[data-message-id]").item(index);
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
          const messageCopyStatus =
            copyState?.messageId === message.id ? copyState.status : null;
          const linkedAnchors =
            linkedAnchorsByMessage.get(message.id) ?? EMPTY_LINKED_ANCHORS;
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
                {message.role === "user" && revisionGroupId && (
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
                {message.role === "assistant" && !message.pending && (
                  <span className="message__controls">
                    {responseRevisionGroup && responseRevisionGroupId && (
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
                    <span
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
                    </span>
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
                  onSelect={onSelect}
                  onOpenElaboration={onOpenElaboration}
                />
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
      <div className="thread-composer-wrap">
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
            Select any passage or equation to quote it here or open a focused elaboration.
          </p>
        )}
      </div>
    </div>
  );
}
